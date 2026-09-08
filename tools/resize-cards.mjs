// Downscales oversized card images to 1200x1700 in place.
//
//   node tools/resize-cards.mjs <deck> [deck...]
//
// Some source decks arrive as ~3300x4700 print masters (10MB+ per PNG). That
// resolution buys nothing at runtime -- MindAR downsamples for tracking anyway
// -- but it does make the browser target compiler run out of memory on a large
// deck, and it makes the picker's thumbnails multi-megabyte downloads.
//
// Originals are backed up to assets/cards-original/<deck>/ on first run, and
// every resize reads from that backup, so re-running is idempotent.
//
// Uses sharp, which is present via node_modules but is not a direct dependency
// -- this is a local asset-prep tool, not part of the app or the build.

import sharp from 'sharp';
import { readdir, mkdir, copyFile, stat, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decks = process.argv.slice(2);

if (!decks.length) {
  console.error('usage: node tools/resize-cards.mjs <deck> [deck...]');
  process.exit(1);
}

const MAX_W = 1200;
const MAX_H = 1700;

let done = 0, skipped = 0, failed = 0, before = 0, after = 0;

for (const deck of decks) {
  const dir = path.join(root, 'assets', 'cards', deck);
  const backupDir = path.join(root, 'assets', 'cards-original', deck);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    console.error(`FAIL ${deck}: no such deck in assets/cards/`);
    failed++;
    continue;
  }

  const files = entries
    .filter((e) => e.isFile() && /\.(png|jpe?g)$/i.test(e.name))
    .map((e) => e.name)
    .sort();

  for (const file of files) {
    const full = path.join(dir, file);
    const backup = path.join(backupDir, file);
    const source = existsSync(backup) ? backup : full;

    const meta = await sharp(source).metadata();
    if (meta.width <= MAX_W && meta.height <= MAX_H) {
      skipped++;
      console.log(`SKIP ${deck}/${file}  ${meta.width}x${meta.height}`);
      continue;
    }

    if (!existsSync(backup)) {
      await mkdir(backupDir, { recursive: true });
      await copyFile(full, backup);
    }

    const sizeBefore = (await stat(full)).size;
    // sharp cannot read and write the same path, so write beside it and swap.
    const tmp = path.join(dir, `.tmp-${file}`);
    try {
      // Re-encode in the source's own format. Forcing PNG here would leave a
      // JPEG deck holding PNG bytes behind a .jpg name -- the manifest and the
      // browser both go by extension, and a photo re-encoded as PNG grows
      // rather than shrinks, which is the opposite of the point.
      const resized = sharp(backup)
        .resize({ width: MAX_W, height: MAX_H, fit: 'inside', withoutEnlargement: true });
      const isJpeg = /\.jpe?g$/i.test(file);
      await (isJpeg ? resized.jpeg({ quality: 88, mozjpeg: true }) : resized.png({ compressionLevel: 9 }))
        .toFile(tmp);
      await rename(tmp, full);

      const sizeAfter = (await stat(full)).size;
      const out = await sharp(full).metadata();
      before += sizeBefore;
      after += sizeAfter;
      done++;
      console.log(
        `OK   ${deck}/${file}  ${meta.width}x${meta.height} -> ${out.width}x${out.height}  ` +
        `${(sizeBefore / 1e6).toFixed(1)}MB -> ${(sizeAfter / 1e6).toFixed(1)}MB`
      );
    } catch (err) {
      failed++;
      // A half-written scratch file left in assets/cards/<deck>/ would fail
      // validate on the next run -- ".tmp-x.png" breaks the slug naming rule --
      // and read as a broken deck rather than as this one failed resize.
      await rm(tmp, { force: true });
      console.error(`FAIL ${deck}/${file}: ${err.message.split('\n')[0]}`);
    }
  }
}

console.log(
  `\n${done} resized, ${skipped} skipped, ${failed} failed. ` +
  `${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB. ` +
  `Originals kept in assets/cards-original/.`
);
