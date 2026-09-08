// Reads the compiled .mind files and reports, per card, whether MindAR can
// actually find and hold that target. Run AFTER compiling: npm run check
//
//   npm run check                 every deck
//   node tools/check-targets.mjs numbers music    just those decks
//
// Why this exists: nothing else in the pipeline can tell you a card will not
// track. validate-assets.mjs only sees file names and byte sizes, and the
// compiler reports success as long as it produced a file -- a card whose art is
// one flat shape compiles perfectly into a target that the camera can never
// match. The only honest signal is inside the .mind, so this reads it.
//
// Two numbers per card, both taken from the same structures the runtime uses:
//
//   features -- keypoints in the full-scale matching keyframe. This is what
//     detection matches a camera frame against (matching/matcher.js). Few
//     keypoints means the card is rarely recognised at all.
//
//   tracking -- points in the 128px tracking keyframe. tracker.js pins
//     TRACKING_KEYFRAME = 1, so this one level is the whole basis of frame-to-
//     frame tracking, and controller.js drops the target when fewer than 4
//     survive the similarity test. A card in single digits here can be found
//     and then lost immediately, which reads as flicker rather than failure.
//
// It also re-checks the thing that silently breaks a whole deck: anchors are
// index-based, so the .mind targets must line up with the manifest's card order
// one for one. Card count and exact pixel dimensions are compared in order.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode } from '@msgpack/msgpack';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetsDir = path.join(root, 'assets', 'targets');

// Chosen against the current library (541 targets, median 191 features / 21
// tracking points): the WEAK lines flag roughly the worst tenth, the BAD lines
// the cards that were reported as not working.
const FEATURES_BAD = 60;
const FEATURES_WEAK = 100;
const TRACKING_BAD = 8;
const TRACKING_WEAK = 15;

const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
const wanted = new Set(process.argv.slice(2));
const decks = manifest.categories.filter((c) => !wanted.size || wanted.has(c.id));

for (const id of wanted) {
  if (!manifest.categories.some((c) => c.id === id)) console.error(`ERROR no deck "${id}" in the manifest`);
}

// The matching keyframe the detector reaches for first is the one at full
// scale; buildImageList() reverses its list, so that is the largest `scale`.
function fullScaleKeyframe(matchingData) {
  return matchingData.reduce((best, k) => (k.scale > best.scale ? k : best), matchingData[0]);
}

const problems = [];
const stale = [];
let checked = 0;

for (const cat of decks) {
  const file = path.join(targetsDir, `${cat.id}.mind`);
  let data;
  try {
    data = decode(await readFile(file));
  } catch (err) {
    stale.push(`${cat.id}: no readable .mind (${err.code ?? err.message}) — compile it`);
    continue;
  }

  if (data.v !== 2) {
    stale.push(`${cat.id}: .mind format v${data.v}, runtime expects v2 — recompile`);
    continue;
  }

  const list = data.dataList ?? [];
  if (list.length !== cat.cards.length) {
    // Every anchor past the first difference points at the wrong model.
    stale.push(`${cat.id}: ${list.length} targets vs ${cat.cards.length} cards — recompile, anchors are misaligned`);
    continue;
  }

  list.forEach((target, i) => {
    const card = cat.cards[i];
    checked++;

    if (card.w && card.h && (target.targetImage.width !== card.w || target.targetImage.height !== card.h)) {
      stale.push(
        `${cat.id}[${i}] ${card.id}: target is ${target.targetImage.width}x${target.targetImage.height} ` +
        `but the card image is ${card.w}x${card.h} — the .mind predates the current cards, recompile`
      );
      return;
    }

    const keyframe = fullScaleKeyframe(target.matchingData);
    const features = keyframe.maximaPoints.length + keyframe.minimaPoints.length;
    const tracking = target.trackingData[1]?.points?.length ?? 0;

    const level =
      features < FEATURES_BAD || tracking < TRACKING_BAD ? 'BAD'
      : features < FEATURES_WEAK || tracking < TRACKING_WEAK ? 'WEAK'
      : null;
    if (level) problems.push({ level, deck: cat.id, card: card.id, features, tracking });
  });
}

if (stale.length) {
  console.error('=== STALE OR MISALIGNED TARGETS ===');
  for (const s of stale) console.error(`ERROR ${s}`);
  console.error('');
}

const bad = problems.filter((p) => p.level === 'BAD');
const weak = problems.filter((p) => p.level === 'WEAK');

function report(title, rows) {
  if (!rows.length) return;
  console.log(`=== ${title} ===`);
  const byDeck = new Map();
  for (const r of rows) byDeck.set(r.deck, [...(byDeck.get(r.deck) ?? []), r]);
  for (const [deck, list] of byDeck) {
    console.log(`  ${deck}`);
    for (const r of list) {
      console.log(`    ${r.card.padEnd(24)} ${String(r.features).padStart(4)} features  ${String(r.tracking).padStart(3)} tracking`);
    }
  }
  console.log('');
}

report(`WILL NOT TRACK — under ${FEATURES_BAD} features or ${TRACKING_BAD} tracking points`, bad);
report(`UNRELIABLE — under ${FEATURES_WEAK} features or ${TRACKING_WEAK} tracking points`, weak);

// Deck size is the other half of "some cards are not recognised": detection
// matches a camera frame against every target in the loaded .mind, so a large
// deck slows every scan and makes weak targets lose to their neighbours.
const crowded = decks.filter((c) => c.cards.length > 25);
if (crowded.length) {
  console.log('=== CROWDED DECKS — detection compares every target on every frame ===');
  for (const c of crowded) console.log(`  ${c.id}: ${c.cards.length} cards (aim for <= 25)`);
  console.log('');
}

console.log(`${checked} targets checked across ${decks.length} decks: ${bad.length} will not track, ${weak.length} unreliable.`);
if (bad.length || weak.length) {
  console.log('Low counts are a property of the card ART, not of the compile — flat shapes,');
  console.log('large uniform areas and thin line work give the detector nothing to hold.');
  console.log('Fix by re-arting those cards with texture and detail, not by recompiling.');
}

process.exit(stale.length ? 1 : 0);
