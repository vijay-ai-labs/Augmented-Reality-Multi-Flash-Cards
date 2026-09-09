// Uploads the runtime asset library to Cloudflare R2: npm run upload
//
//   npm run upload                    everything (~822MB, ~1700 files)
//   npm run upload -- --dry-run       show what would transfer, send nothing
//   npm run upload -- targets models  just those directories
//   npm run upload -- --json          just manifest.json and placements.json
//
// Why this exists: dist/ is 3.4MB and assets/ is 6.7GB, so a deploy is two
// halves. Vercel gets the app, R2 gets the library, and src/config.js joins
// them with VITE_ASSET_BASE. Miss this half and the deployed app loads, opens
// the camera, and shows "No Categories Found".
//
// What it will NOT upload, and the reason the directories are listed one by
// one rather than filtered: assets/ also holds cards-original/ and
// models-original/, 5.9GB of print masters that exist only on this machine and
// must never be public. A filter expression that drifts turns into a 6.7GB
// upload of files nobody should have. Naming the four runtime directories
// explicitly means the masters are not in the source path at all, so no filter
// bug can reach them.
//
// Each directory is `rclone sync`ed to its own prefix, so deleting a deck here
// deletes it on the CDN too. That is the intent — a stale .mind on the CDN
// tracks cards that the manifest no longer lists.
//
// Cache headers are split because the two halves change on different clocks.
// Cards, models, targets and audio are content that gets replaced by adding a
// new file, never by editing one in place, so they take a one-year immutable
// header. manifest.json and placements.json are rewritten every time you run
// `npm run validate` or move a model, so they take a short TTL: a browser
// holding a year-old manifest would never see a new deck.
//
// Credentials come from .env (see .env.example) and are handed to rclone
// through RCLONE_CONFIG_* environment variables rather than argv, so the
// secret does not show up in the process list.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'assets');

// The four runtime directories. Anything not on this list stays local.
const DIRS = ['cards', 'models', 'targets', 'audios'];
const JSON_FILES = ['manifest.json', 'placements.json'];

const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=60, must-revalidate';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const jsonOnly = argv.includes('--json');
const named = argv.filter((a) => !a.startsWith('-'));

for (const name of named) {
  if (!DIRS.includes(name)) {
    console.error(`ERROR unknown directory "${name}" — pick from: ${DIRS.join(', ')}`);
    process.exit(1);
  }
}

const dirs = jsonOnly ? [] : (named.length ? named : DIRS);

// --- Preflight --------------------------------------------------------------
// Every check here is something that fails slowly and confusingly if left to
// rclone: a half-finished upload, or a 403 after twenty minutes of transfer.

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  console.error('ERROR no .env file — copy .env.example to .env and fill in the R2 values.');
  process.exit(1);
}

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env;
const missing = Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET })
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`ERROR .env is missing: ${missing.join(', ')}`);
  console.error('      See .env.example for where each value comes from.');
  process.exit(1);
}

// rclone is spawned WITHOUT a shell, because both the project path and the
// Cache-Control header values contain spaces: with shell:true on Windows, node
// concatenates argv into one string without quoting, and rclone sees
// "C:\...\Ar-Multi", "Flascards\assets\cards", "public,", "max-age=31536000,"
// and "immutable" as five separate arguments. Spawning without a shell passes
// each argument through intact, but then node no longer applies PATHEXT, so the
// bare name "rclone" would not resolve to rclone.exe. Hence: resolve the
// absolute path once here, through a shell, and use it for every call after.
function resolveRclone() {
  const finder = process.platform === 'win32' ? 'where rclone' : 'command -v rclone';
  const found = spawnSync(finder, { shell: true, encoding: 'utf8' });
  if (found.status !== 0) return null;
  return found.stdout.split(/\r?\n/).find((line) => line.trim())?.trim() ?? null;
}

const RCLONE = resolveRclone();

if (!RCLONE) {
  console.error('ERROR rclone not found on PATH.');
  console.error('      Install it:  winget install Rclone.Rclone');
  console.error('      Then open a NEW terminal so PATH picks it up.');
  process.exit(1);
}

for (const dir of dirs) {
  if (!existsSync(path.join(assetsDir, dir))) {
    console.error(`ERROR assets/${dir}/ does not exist — nothing to upload.`);
    process.exit(1);
  }
}

// The JSON pair rides along with a full run, and can be sent on its own after
// a `npm run validate`, but is skipped when only named directories go up.
const withJson = jsonOnly || named.length === 0;

for (const file of withJson ? JSON_FILES : []) {
  if (!existsSync(path.join(assetsDir, file))) {
    console.error(`ERROR assets/${file} does not exist — run "npm run validate" first.`);
    process.exit(1);
  }
}

// --- rclone wiring ----------------------------------------------------------
// Configured entirely through the environment, so there is no rclone.conf to
// create and no secret on the command line. "R2" is the remote name that the
// RCLONE_CONFIG_R2_* variables define.

const env = {
  ...process.env,
  RCLONE_CONFIG_R2_TYPE: 's3',
  RCLONE_CONFIG_R2_PROVIDER: 'Cloudflare',
  RCLONE_CONFIG_R2_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
  RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
  RCLONE_CONFIG_R2_ENDPOINT: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  RCLONE_CONFIG_R2_REGION: 'auto',
  // R2 has no per-object ACLs; sending one makes every PUT fail.
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET: 'true'
};

const COMMON = [
  '--transfers', '16',
  '--checkers', '32',
  '--retries', '3',
  '--progress',
  '--stats-one-line',
  ...(dryRun ? ['--dry-run'] : [])
];

function rclone(args, label) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(RCLONE, args, { env, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\nERROR rclone exited ${result.status} during: ${label}`);
    process.exit(result.status ?? 1);
  }
}

async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    bytes += statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
    files++;
  }
  return { bytes, files };
}

// --- Report, then transfer --------------------------------------------------

const gb = (bytes) => `${(bytes / 1e9).toFixed(2)} GB`;
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

let totalBytes = 0;
let totalFiles = 0;
for (const dir of dirs) {
  const { bytes, files } = await dirSize(path.join(assetsDir, dir));
  console.log(`  assets/${dir.padEnd(8)} ${String(files).padStart(5)} files  ${mb(bytes).padStart(8)}`);
  totalBytes += bytes;
  totalFiles += files;
}

console.log(`\n${totalFiles} files, ${gb(totalBytes)} to R2 bucket "${R2_BUCKET}"${dryRun ? ' (DRY RUN)' : ''}`);
console.log('Excluded: cards-original/, models-original/ — print masters, never public.\n');

for (const dir of dirs) {
  rclone(
    [
      'sync',
      path.join(assetsDir, dir),
      `R2:${R2_BUCKET}/assets/${dir}`,
      '--header-upload', `Cache-Control: ${IMMUTABLE}`,
      ...COMMON
    ],
    `assets/${dir} -> ${R2_BUCKET}/assets/${dir}`
  );
}

// The JSON pair goes last on purpose. It is the index the app reads first, so
// publishing it before the files it points at leaves a window where the app
// lists a deck whose .mind is not there yet.
if (withJson) {
  for (const file of JSON_FILES) {
    rclone(
      [
        'copyto',
        path.join(assetsDir, file),
        `R2:${R2_BUCKET}/assets/${file}`,
        '--header-upload', `Cache-Control: ${SHORT}`,
        ...COMMON
      ],
      `assets/${file} -> ${R2_BUCKET}/assets/${file}`
    );
  }
}

console.log(dryRun ? '\nDry run complete — nothing was uploaded.' : '\nUpload complete.');
console.log('Verify it before deploying:  npm run check:cdn');
