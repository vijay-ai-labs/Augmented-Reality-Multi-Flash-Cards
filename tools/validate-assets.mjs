// Validates the assets folder and generates assets/manifest.json.
//
// Expected layout (names: lowercase, digits, hyphens only; image and model
// for the same card must share the same base name):
//   assets/cards/<category>/<card-name>.jpg|.jpeg|.png
//   assets/models/<category>/<card-name>.glb
//   assets/audios/<category>/<card-name>.mp3|.m4a|.ogg|.wav   (optional)
//
// Audio is the card's spoken name, played when its model appears. It is
// optional on purpose: a missing clip warns rather than errors, so a deck can
// ship before its recordings are done.
//
// Card order inside each category is alphabetical — the .mind target file
// for a category MUST be compiled from images in this same order, since
// MindAR anchors are index-based. The compiler page reads the manifest,
// so recompile targets whenever cards are added or removed.

import { readdir, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cardsDir = path.join(root, 'assets', 'cards');
const modelsDir = path.join(root, 'assets', 'models');
const audiosDir = path.join(root, 'assets', 'audios');
const targetsDir = path.join(root, 'assets', 'targets');
const manifestPath = path.join(root, 'assets', 'manifest.json');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.ogg', '.wav']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const errors = [];
const warnings = [];

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return null;
  }
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// Slugs are lowercase, so a country code would otherwise read "Uk Pound".
const ACRONYMS = new Set(['uk', 'us', 'usa', 'uae', 'eu']);

function titleCase(slug) {
  return slug
    .split('-')
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

async function imageDimensions(filePath) {
  const buffer = await readFile(filePath);
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (buffer.subarray(0, 8).equals(pngSignature)) {
    return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buffer.readUInt16BE(offset + 5), w: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }

  return {};
}

// Models and audio clips go to the CDN with a one-year immutable cache header,
// so replacing one under the same name would never reach a phone that already
// has it. The manifest (short TTL) carries a content hash on each model and
// audio URL instead: a new file means a new URL. Hash the *compressed* model,
// so run this after `npm run compress`.
async function contentHash(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex').slice(0, 8);
}

const cardCategories = await listDirs(cardsDir);
const modelCategories = await listDirs(modelsDir);

if (cardCategories === null || modelCategories === null) {
  console.error('Missing assets/cards/ or assets/models/ directory.');
  process.exit(1);
}

for (const c of cardCategories) {
  if (!modelCategories.includes(c)) errors.push(`Category "${c}" exists in cards/ but not in models/`);
  if (!NAME_RE.test(c)) errors.push(`Category folder "${c}" breaks naming rule (lowercase, digits, hyphens)`);
}
for (const c of modelCategories) {
  if (!cardCategories.includes(c)) errors.push(`Category "${c}" exists in models/ but not in cards/`);
}
// audios/ is optional as a whole, but a folder in it that matches no deck is
// almost always a typo — and it would silently mute that entire deck.
for (const c of (await listDirs(audiosDir)) ?? []) {
  if (!cardCategories.includes(c)) warnings.push(`Category "${c}" exists in audios/ but not in cards/ — nothing will play it`);
}

const categories = [];
let totalCards = 0;

for (const cat of cardCategories.filter((c) => modelCategories.includes(c))) {
  const imageFiles = await listFiles(path.join(cardsDir, cat));
  const modelFiles = await listFiles(path.join(modelsDir, cat));
  const audioFiles = await listFiles(path.join(audiosDir, cat));

  const images = new Map(); // base name -> filename
  for (const f of imageFiles) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, path.extname(f));
    if (!IMAGE_EXTS.has(ext)) {
      warnings.push(`${cat}/${f}: skipped (not .jpg/.jpeg/.png)`);
      continue;
    }
    if (!NAME_RE.test(base)) errors.push(`Card image "${cat}/${f}" breaks naming rule (lowercase, digits, hyphens)`);
    if (images.has(base)) errors.push(`Card "${cat}/${base}" has multiple image files`);
    images.set(base, f);
  }

  const models = new Map();
  for (const f of modelFiles) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, path.extname(f));
    if (ext !== '.glb' && ext !== '.gltf') {
      warnings.push(`${cat}/${f}: skipped (not .glb/.gltf)`);
      continue;
    }
    models.set(base, f);
  }

  // A stray space or capital in a clip name silently breaks its card's audio,
  // so audio names are held to the same rule as images -- as an error, since
  // the fix is a rename and not a missing recording.
  const audios = new Map();
  for (const f of audioFiles) {
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, path.extname(f));
    if (!AUDIO_EXTS.has(ext)) {
      warnings.push(`${cat}/${f}: skipped (not .mp3/.m4a/.ogg/.wav)`);
      continue;
    }
    if (!NAME_RE.test(base)) {
      errors.push(`Audio clip "${cat}/${f}" breaks naming rule (lowercase, digits, hyphens)`);
      continue;
    }
    if (audios.has(base)) errors.push(`Card "${cat}/${base}" has multiple audio files`);
    audios.set(base, f);
  }

  const cards = [];
  for (const [base, imgFile] of [...images.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!models.has(base)) {
      errors.push(`Card "${cat}/${base}" has image but no model (.glb)`);
      continue;
    }
    const imagePath = path.join(cardsDir, cat, imgFile);
    const imgStat = await stat(imagePath);
    if (imgStat.size < 20 * 1024) warnings.push(`${cat}/${imgFile}: very small file — low-res images track poorly`);
    const dimensions = await imageDimensions(imagePath);
    if (!audios.has(base)) warnings.push(`Card "${cat}/${base}" has no audio clip — it will play silently`);
    const modelFile = models.get(base);
    cards.push({
      id: base,
      name: titleCase(base),
      image: `assets/cards/${cat}/${imgFile}`,
      model: `assets/models/${cat}/${modelFile}?v=${await contentHash(path.join(modelsDir, cat, modelFile))}`,
      ...(audios.has(base)
        ? { audio: `assets/audios/${cat}/${audios.get(base)}?v=${await contentHash(path.join(audiosDir, cat, audios.get(base)))}` }
        : {}),
      ...dimensions
    });
  }
  for (const base of models.keys()) {
    if (!images.has(base)) errors.push(`Card "${cat}/${base}" has model but no image`);
  }
  for (const base of audios.keys()) {
    if (!images.has(base)) warnings.push(`Audio "${cat}/${base}" matches no card — nothing will play it`);
  }

  if (cards.length > 25) warnings.push(`Category "${cat}" has ${cards.length} cards — recognition slows above ~25 targets per category`);

  // The .mind gets the same immutable header, and a stale one is worse than a
  // stale model: anchors are index-based, so a phone holding last month's
  // target file against this manifest shows every card after an insertion with
  // its neighbour's model. Hash it like the models, so run this again after
  // compiling targets (upload-assets refuses a manifest whose hash is stale).
  const targetPath = path.join(targetsDir, `${cat}.mind`);
  const target = await stat(targetPath).then(
    async () => `assets/targets/${cat}.mind?v=${await contentHash(targetPath)}`,
    () => null
  );

  totalCards += cards.length;
  categories.push({ id: cat, name: titleCase(cat), ...(target ? { target } : {}), cards });
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

const withAudio = categories.reduce((sum, c) => sum + c.cards.filter((card) => card.audio).length, 0);
console.log(`\n${categories.length} categories, ${totalCards} valid cards, ${withAudio} with audio.`);

if (errors.length) {
  console.error(`\n${errors.length} error(s) — manifest NOT written. Fix and re-run.`);
  process.exit(1);
}

await mkdir(path.dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, JSON.stringify({ generated: new Date().toISOString(), categories }, null, 2));
console.log(`Manifest written to assets/manifest.json`);
