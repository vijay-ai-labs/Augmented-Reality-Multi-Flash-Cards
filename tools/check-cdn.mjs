// Proves the deployed asset library is actually usable: npm run check:cdn
//
//   npm run check:cdn                          uses VITE_ASSET_BASE from .env
//   npm run check:cdn -- https://pub-x.r2.dev  checks that base instead
//   npm run check:cdn -- --all                 every file, not a sample
//   npm run check:cdn -- --origin https://my-app.vercel.app
//
// Run it AFTER `npm run upload` and BEFORE deploying. Everything it tests is a
// failure that looks identical from inside the app: the page loads, the camera
// opens, and you get "No Categories Found" or a card that tracks but shows no
// model. The browser console has the real reason, on a phone, where you cannot
// read it. So this asks the CDN directly, over the network, the same way the
// app will.
//
// What it checks, and why each one has bitten this kind of deploy before:
//
//   reachable  -- the two JSON files parse, and the remote manifest matches the
//     local one. A stale remote manifest lists decks whose .mind was never
//     uploaded, which reads in the app as a category that opens to nothing.
//
//   targets    -- every .mind returns 200 AND the exact local byte count. A
//     truncated or resumed-wrong upload still returns 200; MindAR then fails to
//     decode it and the deck never tracks. Size is the only cheap proof.
//
//   CORS       -- access-control-allow-origin must come back on a cross-origin
//     request. Without it the bucket serves every file perfectly to curl and
//     nothing at all to the app. This is the single most common cause of a
//     deploy that works for you locally and is blank in production.
//
//   caching    -- cache-control on the long-lived files. Not correctness, but
//     alphabets.mind is 26MB; without a cache header every open re-downloads
//     it, which is the difference between smooth AR and a blank camera.
//
//   masters    -- the print masters must NOT be reachable. cards-original/ and
//     models-original/ are 5.9GB that should never have left this machine, and
//     a mis-scoped upload publishes them silently.
//
// HEAD is used throughout, so checking all 30 targets costs no bandwidth even
// though they total 222MB.

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'assets');

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const originFlag = argv.indexOf('--origin');
// A browser always sends an Origin the bucket has to answer for. Any value
// works against a wildcard CORS policy; pass the real one to test a locked
// policy before you trust it.
const origin = originFlag !== -1 ? argv[originFlag + 1] : 'https://ar-flashcards.example';

// The base URL is a POSITIONAL argument, so the value belonging to --origin has
// to be stepped over: both are URLs, and picking the first thing that looks like
// one made `--origin https://my-app.vercel.app` check the app for asset paths
// instead of the bucket, reporting every file as a 404.
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--origin') {
    i++;
    continue;
  }
  if (!argv[i].startsWith('-')) positional.push(argv[i]);
}

if (originFlag !== -1 && !origin?.startsWith('http')) {
  console.error('ERROR --origin needs a URL, e.g. --origin https://my-app.vercel.app');
  process.exit(1);
}

let base = positional.find((a) => a.startsWith('http'));
if (!base) {
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    // No .env is fine as long as a URL was passed on the command line.
  }
  base = process.env.VITE_ASSET_BASE ?? '';
}
base = base.replace(/\/+$/, '');

if (!base) {
  console.error('ERROR no CDN base URL. Pass one, or set VITE_ASSET_BASE in .env:');
  console.error('      npm run check:cdn -- https://pub-<id>.r2.dev');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(assetsDir, 'manifest.json'), 'utf8'));

const errors = [];
const warnings = [];
// Kept apart from both. A 429 that survives the retries says nothing about
// whether the file is there — only that the endpoint refused to answer right
// now. Counting those as broken produced 884 false "not uploaded" reports on a
// bucket that was in fact complete.
const throttled = [];
let checked = 0;

// --- One request ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 and 5xx are retried with backoff, because r2.dev throttles aggressively
// and a throttled response is indistinguishable from a missing file if you only
// look once. Jitter keeps the retries from re-colliding in lockstep, which is
// what turns one burst of 429s into a sustained one.
async function request(url, method = 'HEAD', attempt = 0) {
  try {
    const res = await fetch(url, {
      method,
      headers: { Origin: origin },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(500 * 2 ** attempt + Math.random() * 400);
      return request(url, method, attempt + 1);
    }
    return { status: res.status, headers: res.headers, res };
  } catch (err) {
    if (attempt < 2) {
      await sleep(500 * 2 ** attempt + Math.random() * 400);
      return request(url, method, attempt + 1);
    }
    return { status: 0, error: err.cause?.code ?? err.name ?? String(err) };
  }
}

const head = (url) => request(url, 'HEAD');

// Concurrency is capped because R2's r2.dev endpoint rate-limits, and a burst
// of 1700 parallel HEADs reads back as a wall of 429s that look like outages.
async function pool(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

// Loaders do not inspect content-type, so a wrong one is a warning. An HTML
// content-type is the exception: that means the URL hit an error page or a
// SPA fallback rather than the file, and the fetch will fail.
function checkType(label, type, expected) {
  if (!type) return;
  if (type.includes('text/html')) {
    errors.push(`${label}: served as text/html — that is an error page, not the file`);
  } else if (expected && !expected.some((e) => type.includes(e))) {
    warnings.push(`${label}: content-type "${type.split(';')[0]}", expected ${expected.join(' or ')}`);
  }
}

async function checkFile(relPath, { expectType, longCache = true, label = relPath } = {}) {
  checked++;
  // Model paths carry a `?v=<hash>` cache-buster (see validate-assets.mjs). It
  // belongs in the URL, not the disk path — left in, existsSync() is always
  // false and the size comparison below silently never runs for any model.
  const local = path.join(root, relPath.split('?')[0]);
  const res = await head(`${base}/${relPath}`);

  if (res.status === 0) {
    errors.push(`${label}: request failed (${res.error})`);
    return;
  }
  if (res.status === 429) {
    throttled.push(label);
    return;
  }
  if (res.status !== 200) {
    errors.push(`${label}: HTTP ${res.status} — not uploaded, or the bucket path is wrong`);
    return;
  }

  if (!res.headers.get('access-control-allow-origin')) {
    errors.push(`${label}: no access-control-allow-origin — the browser will block this`);
  }

  if (existsSync(local)) {
    const localSize = statSync(local).size;
    const remoteSize = Number(res.headers.get('content-length'));
    if (remoteSize && remoteSize !== localSize) {
      errors.push(`${label}: ${remoteSize} bytes on the CDN vs ${localSize} local — incomplete upload, re-run npm run upload`);
    }
  }

  checkType(label, res.headers.get('content-type'), expectType);

  if (longCache && !res.headers.get('cache-control')) {
    warnings.push(`${label}: no cache-control — re-downloaded on every visit`);
  }
}

// --- 1. The two JSON files --------------------------------------------------

console.log(`Checking ${base}\n  origin sent: ${origin}\n`);

for (const file of ['manifest.json', 'placements.json']) {
  checked++;
  const url = `${base}/assets/${file}`;
  try {
    const { status, headers, res } = await request(url, 'GET');
    if (status !== 200) {
      errors.push(`assets/${file}: HTTP ${status} — the app cannot start without this`);
      continue;
    }
    if (!headers.get('access-control-allow-origin')) {
      errors.push(`assets/${file}: no access-control-allow-origin — set the bucket CORS policy`);
    }
    // The app revalidates these itself (fetch cache: 'no-cache'), but older
    // builds and other clients rely on the header: missing = heuristic caching
    // for days, long = stale index pointing at old models.
    const cc = headers.get('cache-control') ?? '';
    const maxAge = Number(cc.match(/max-age=(\d+)/)?.[1] ?? NaN);
    if (!cc) {
      warnings.push(`assets/${file}: no cache-control — browsers may cache it for days; re-upload with npm run upload -- --json`);
    } else if (!(maxAge <= 300) && !/no-cache|no-store/.test(cc)) {
      warnings.push(`assets/${file}: cache-control "${cc}" — too long for the index file; re-upload with npm run upload -- --json`);
    }
    const body = await res.json();
    if (file === 'manifest.json') {
      const remoteDecks = body.categories?.length ?? 0;
      const localDecks = manifest.categories.length;
      if (remoteDecks !== localDecks) {
        errors.push(`manifest.json: ${remoteDecks} decks on the CDN vs ${localDecks} local — re-upload it`);
      } else if (body.generated !== manifest.generated) {
        warnings.push(`manifest.json: CDN copy generated ${body.generated}, local ${manifest.generated} — stale`);
      }
    }
  } catch (err) {
    errors.push(`assets/${file}: ${err.name === 'SyntaxError' ? 'not valid JSON — probably an error page' : err.cause?.code ?? err.name}`);
  }
}

// --- 2. Every .mind target --------------------------------------------------
// Never sampled. A missing target kills one whole deck, and there are only 30.

await pool(
  manifest.categories.map((c) => `assets/targets/${c.id}.mind`),
  8,
  (relPath) => checkFile(relPath, { expectType: ['application/octet-stream', 'application/x-'] })
);

// --- 3. Cards, models and audio ---------------------------------------------
// Sampled by default: first, middle and last card of each deck. Order is
// alphabetical and stable, so this lands on different files across decks.

const sampled = [];
for (const cat of manifest.categories) {
  const cards = all ? cat.cards : [cat.cards[0], cat.cards[Math.floor(cat.cards.length / 2)], cat.cards.at(-1)];
  for (const card of new Set(cards.filter(Boolean))) {
    sampled.push({ relPath: card.image, expectType: ['image/'] });
    sampled.push({ relPath: card.model, expectType: ['model/gltf', 'application/octet-stream'] });
    if (card.audio) sampled.push({ relPath: card.audio, expectType: ['audio/'] });
  }
}

// 6, not 12. A full --all sweep is 1653 requests, and r2.dev starts returning
// 429 well before that finishes at higher concurrency.
await pool(sampled, 6, ({ relPath, expectType }) => checkFile(relPath, { expectType }));

// --- 4. The print masters must be unreachable -------------------------------

const masterProbe = manifest.categories[0]?.cards[0];
if (masterProbe) {
  for (const dir of ['models-original', 'cards-original']) {
    const relPath = masterProbe[dir.startsWith('models') ? 'model' : 'image'].split('?')[0].replace(
      dir.startsWith('models') ? 'assets/models/' : 'assets/cards/',
      `assets/${dir}/`
    );
    const res = await head(`${base}/${relPath}`);
    if (res.status === 200) {
      errors.push(`${dir}/ IS PUBLIC on the CDN — print masters were uploaded by mistake, delete that prefix`);
    }
  }
}

// --- Report -----------------------------------------------------------------

function report(title, rows, stream) {
  if (!rows.length) return;
  stream(`=== ${title} ===`);
  for (const r of rows) stream(`  ${r}`);
  stream('');
}

console.log('');
report('BROKEN — the app will not work with these', errors, (s) => console.error(s));
report('WARNINGS — works, but slower or stale', warnings, (s) => console.warn(s));

if (throttled.length) {
  console.warn(`=== RATE LIMITED — ${throttled.length} files returned 429 after 3 retries ===`);
  console.warn('  This is the endpoint refusing to answer, not a missing file. It is what');
  console.warn('  Cloudflare means by "r2.dev is not for production": a burst of requests');
  console.warn('  gets throttled. Real users browsing decks one at a time will rarely hit');
  console.warn('  it, but it is the reason to move to a custom domain, which is not');
  console.warn('  rate limited and gets full Cloudflare edge caching.');
  console.warn(`  First few: ${throttled.slice(0, 3).join(', ')}`);
  console.warn('');
}

console.log(
  `${checked} files checked across ${manifest.categories.length} decks` +
  `${all ? ' (full)' : ' (sampled — use --all for every file)'}: ` +
  `${errors.length} broken, ${warnings.length} warnings, ${throttled.length} rate limited.`
);

if (!errors.length && !warnings.length && !throttled.length) {
  console.log('CDN is good. Set VITE_ASSET_BASE to this URL in Vercel and redeploy.');
} else if (!errors.length) {
  console.log('Nothing broken. The app will work.');
} else if (errors.length) {
  console.log('\nFix the broken list before deploying — every one of these shows up in the');
  console.log('app as "No Categories Found" or a card that tracks but never renders.');
}

process.exit(errors.length ? 1 : 0);
