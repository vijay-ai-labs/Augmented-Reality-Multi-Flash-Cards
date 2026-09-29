// Batch-compresses .glb files under assets/models/ in place:
//   - spec/gloss -> metal/rough material conversion, when the source needs it
//   - Draco mesh compression
//   - texture resize to max 1024px + WebP conversion
//   - mesh simplification, except on point clouds / line sets (it deletes them)
// A model whose output ends up with no geometry is reported FAIL, never OK.
// Originals are backed up to assets/models-original/ on first run.
// Run AFTER validate: npm run compress
//
//   npm run compress                              every deck
//   node tools/compress-models.mjs yoga fruits    just those decks
//   node tools/compress-models.mjs assets/models/time/3o.glb   just those models
//
// Compressing is idempotent -- every run re-reads the pristine backup, so a
// whole-library run is always safe. It is just slow: one npx gltf-transform
// process per model. Name the decks (or the models) when only some changed.

import { readdir, mkdir, copyFile, stat, open, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'assets', 'models');
const backupDir = path.join(root, 'assets', 'models-original');

// A deck name, or a path to a single .glb — re-running one model after a fix
// should not mean re-compressing its whole deck.
function resolveTarget(arg) {
  const asDeck = path.join(modelsDir, arg);
  if (existsSync(asDeck)) return asDeck;
  const asFile = path.isAbsolute(arg) ? arg : path.join(root, arg);
  if (existsSync(asFile)) return asFile;
  console.error(`No such deck or model in assets/models/: ${arg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const targets = args.length ? args.map(resolveTarget) : [modelsDir];

async function* walk(entries) {
  for (const entry of entries) {
    if ((await stat(entry)).isDirectory()) {
      for (const child of await readdir(entry)) yield* walk([path.join(entry, child)]);
    } else if (entry.toLowerCase().endsWith('.glb')) {
      yield entry;
    }
  }
}

// The JSON chunk of a .glb, or null when the file is unreadable or not a GLB
// (gltf-transform is then the one to complain).
async function readGlbJson(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const header = Buffer.alloc(20);
    await handle.read(header, 0, 20, 0);
    if (header.readUInt32LE(0) !== 0x46546c67) return null; // not a binary glTF
    const jsonLength = header.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    await handle.read(json, 0, jsonLength, 20);
    return JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// three.js dropped KHR_materials_pbrSpecularGlossiness from GLTFLoader in r150,
// and only warns about it -- a model whose base colour and diffuse texture live
// solely in that extension still loads, as an untextured white blob (its core
// `pbrMetallicRoughness` block is empty). gltf-transform's `metalrough` rewrites
// those materials into the core model, so it has to run before `optimize`.
function usesSpecularGlossiness(gltf) {
  return [...(gltf?.extensionsUsed ?? []), ...(gltf?.extensionsRequired ?? [])].includes(
    'KHR_materials_pbrSpecularGlossiness'
  );
}

const primitivesOf = (gltf) => (gltf?.meshes ?? []).flatMap((m) => m.primitives ?? []);

// optimize's `simplify` step is a triangle decimator. On a point cloud or line
// set it removes every primitive, and the output is a valid, empty scene that
// loads without error and shows nothing (verified: universe/star-cluster, a
// 50k-point cloud, came out 0KB and still logged OK). Such sources skip it.
function hasNonTriangles(gltf) {
  return primitivesOf(gltf).some((p) => ![4, 5, 6].includes(p.mode ?? 4));
}

let done = 0, failed = 0, savedBytes = 0;

for await (const file of walk(targets)) {
  const rel = path.relative(modelsDir, file);
  const backup = path.join(backupDir, rel);

  if (!existsSync(backup)) {
    await mkdir(path.dirname(backup), { recursive: true });
    await copyFile(file, backup);
  }

  const before = (await stat(file)).size;
  const quote = (p) => process.platform === 'win32' ? `"${p}"` : p;
  const run = (args) => execFileP('npx', ['gltf-transform', ...args], { shell: process.platform === 'win32' });
  // Kept out of assets/ on purpose: walk() is lazy, so a scratch .glb written
  // beside the real ones would be picked up as a model later in the same run.
  let scratch = null;

  try {
    let source = backup;
    const gltf = await readGlbJson(backup);
    if (usesSpecularGlossiness(gltf)) {
      scratch = path.join(tmpdir(), `metalrough-${randomUUID()}.glb`);
      await run(['metalrough', quote(backup), quote(scratch)]);
      source = scratch;
    }
    const noSimplify = hasNonTriangles(gltf);
    await run([
      'optimize', quote(source), quote(file),
      '--compress', 'draco',
      '--texture-compress', 'webp',
      '--texture-size', '1024',
      ...(noSimplify ? ['--simplify', 'false'] : [])
    ]);
    // Never report OK for an output that lost its geometry: it loads cleanly
    // and the card just shows nothing, so nothing downstream would catch it.
    const sourcePrims = primitivesOf(gltf).length;
    const outPrims = primitivesOf(await readGlbJson(file)).length;
    if (gltf && sourcePrims > 0 && outPrims === 0) {
      throw new Error(`output has no geometry (source had ${sourcePrims} primitives) — do not ship it`);
    }
    const after = (await stat(file)).size;
    savedBytes += before - after;
    done++;
    const notes = [scratch && 'spec/gloss converted', noSimplify && 'points/lines: simplify skipped'].filter(Boolean);
    console.log(`OK   ${rel}${notes.length ? ` (${notes.join(', ')})` : ''}  ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${rel}: ${err.message.split('\n')[0]}`);
  } finally {
    if (scratch) await rm(scratch, { force: true });
  }
}

console.log(`\n${done} compressed, ${failed} failed, ${(savedBytes / 1e9).toFixed(2)}GB saved.`);
console.log(`Originals kept in assets/models-original/ (delete once happy).`);
