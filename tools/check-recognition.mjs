// Answers "when I point the camera at card X, which card does MindAR say it
// is?" for every card, offline, with MindAR's own detector and matcher.
//
//   npm run check:recognition                  every deck
//   node tools/check-recognition.mjs month time jersey
//   node tools/check-recognition.mjs month --verbose     per-card inlier table
//
// Why this exists: check-targets.mjs says whether a card CAN be found, not
// whether it is found as ITSELF. Decks built on one template (month calendars,
// time clocks, jerseys) share most of their keypoints, so a camera frame of
// "june" also matches "april" -- and MindAR's stock matcher takes the first
// card in manifest order that clears 6 inliers, not the best one. That is the
// "wrong model on a similar card" bug. This tool reproduces it without a phone.
//
// How: each card image is warped into a synthetic 480x640 portrait camera frame
// (perspective tilt, rotation, lighting, blur, sensor noise, textured table),
// run through MindAR's CropDetector exactly as the runtime does -- 256px crops
// cycling the 9 detectMoving() positions -- and every crop's features are
// matched against every target of the deck's compiled .mind. Two verdicts per
// card:
//
//   stock  -- first target in manifest order with a match (mind-ar 1.2.5 as
//             shipped, before tools/patch-mindar.mjs)
//   ranked -- the target with the most inliers, and only when it beats the
//             runner-up by the margin the patched runtime uses
//
// The numbers need a phone to confirm, but a card that is confused here is
// confused on a phone: this is the same code on the same data.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decode } from '@msgpack/msgpack';
import * as tf from '@tensorflow/tfjs';
import '../node_modules/mind-ar/src/image-target/detector/kernels/cpu/index.js';
import { CropDetector } from '../node_modules/mind-ar/src/image-target/detector/crop-detector.js';
import { Matcher } from '../node_modules/mind-ar/src/image-target/matching/matcher.js';
import { RANK_MIN_INLIERS, RANK_MARGIN, pickRanked } from './mindar-ranking.js';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAME_W = 480;
const FRAME_H = 640;

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
// --dump=<file>: one JSON line per crop with every target's inlier count, for
// tuning tools/mindar-ranking.js without re-running detection (the slow part).
const dumpPath = args.find((a) => a.startsWith('--dump='))?.slice('--dump='.length);
const wanted = new Set(args.filter((a) => !a.startsWith('--')));
const dumpLines = [];

await tf.setBackend('cpu');
tf.enableProdMode();

const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
const decks = manifest.categories.filter((c) => !wanted.size || wanted.has(c.id));
for (const id of wanted) {
  if (!manifest.categories.some((c) => c.id === id)) console.error(`ERROR no deck "${id}" in the manifest`);
}

/* ------------------------------------------------------------ frame synthesis */

// Deterministic, so two runs of the tool print the same table.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 3x3 homography mapping the 4 `src` points onto the 4 `dst` points.
function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting on the 8x8 system.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < 8; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(8);
  for (let r = 7; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < 8; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [...h, 1];
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
    .map((v) => v / det);
}

async function loadGrey(file) {
  // White matte first: printed card stock is white, same as load-card-image.js.
  const { data, info } = await sharp(file).flatten({ background: '#ffffff' }).greyscale().raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// One synthetic camera frame of `card`. `pose` picks how the card sits.
function renderFrame(card, pose, seed) {
  const rand = rng(seed);
  const out = new Float32Array(FRAME_W * FRAME_H);

  // Card height as a share of the frame, centre offset, in-plane spin, and a
  // perspective squeeze of one edge (the phone held at an angle).
  const cardH = FRAME_H * pose.fill;
  const cardW = cardH * (card.width / card.height);
  const cx = FRAME_W / 2 + pose.dx * FRAME_W;
  const cy = FRAME_H / 2 + pose.dy * FRAME_H;
  const rot = (pose.rot * Math.PI) / 180;
  const squeeze = pose.tilt; // top edge shorter by this fraction
  const corners = [
    [-cardW / 2 * (1 - squeeze), -cardH / 2],
    [cardW / 2 * (1 - squeeze), -cardH / 2],
    [cardW / 2, cardH / 2],
    [-cardW / 2, cardH / 2]
  ].map(([x, y]) => [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  const src = [[0, 0], [card.width, 0], [card.width, card.height], [0, card.height]];
  const Hinv = invert3(homography(src, corners));

  const gain = pose.gain;
  const bias = pose.bias;
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
      const u = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w;
      const v = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w;
      let val;
      if (u >= 0 && v >= 0 && u < card.width - 1 && v < card.height - 1) {
        const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
        const i0 = y0 * card.width + x0;
        const d = card.data;
        val = (d[i0] * (1 - fx) + d[i0 + 1] * fx) * (1 - fy) + (d[i0 + card.width] * (1 - fx) + d[i0 + card.width + 1] * fx) * fy;
        val = val * gain + bias;
      } else {
        // Wood-ish table: low-frequency bands plus grain, darker than the card.
        val = 90 + 25 * Math.sin(x * 0.05 + Math.sin(y * 0.013) * 3) + 10 * Math.sin(y * 0.4 + x * 0.02);
      }
      out[y * FRAME_W + x] = val;
    }
  }

  // Lens softness: one 3x3 box pass, then sensor noise.
  const blurred = new Float32Array(out.length);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      if (!pose.blur || x === 0 || y === 0 || x === FRAME_W - 1 || y === FRAME_H - 1) {
        blurred[y * FRAME_W + x] = out[y * FRAME_W + x];
        continue;
      }
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += out[(y + j) * FRAME_W + x + i];
      blurred[y * FRAME_W + x] = s / 9;
    }
  }
  for (let i = 0; i < blurred.length; i++) {
    const n = (rand() + rand() + rand() - 1.5) * 2 * pose.noise;
    blurred[i] = Math.min(255, Math.max(0, blurred[i] + n));
  }
  return blurred;
}

// A child pointing a phone at a card: mostly filling the view, a bit off
// centre, tilted, in ordinary room light. Plus one far and one close view.
const POSES = [
  { name: 'straight', fill: 0.72, dx: 0, dy: 0, rot: 0, tilt: 0, gain: 1, bias: 0, blur: false, noise: 3 },
  { name: 'tilted', fill: 0.7, dx: 0.04, dy: -0.03, rot: 8, tilt: 0.12, gain: 0.85, bias: 10, blur: true, noise: 5 },
  { name: 'far', fill: 0.45, dx: -0.05, dy: 0.05, rot: -6, tilt: 0.06, gain: 0.8, bias: 15, blur: true, noise: 5 },
  { name: 'close', fill: 0.95, dx: 0.02, dy: 0.02, rot: 4, tilt: 0.08, gain: 0.9, bias: 5, blur: true, noise: 4 }
];

/* ------------------------------------------------------------------ matching */

const cropDetector = new CropDetector(FRAME_W, FRAME_H);
const matcher = new Matcher(FRAME_W, FRAME_H);

// Inlier count of every target against one crop's features. 0 = no match.
function scoreAll(featurePoints, matchingDataList) {
  return matchingDataList.map((keyframes) => {
    const { keyframeIndex, screenCoords } = matcher.matchDetection(keyframes, featurePoints);
    return keyframeIndex === -1 ? 0 : screenCoords.length;
  });
}

/* ---------------------------------------------------------------------- run */

const summary = [];

for (const cat of decks) {
  let data;
  try {
    data = decode(await readFile(path.join(root, 'assets', 'targets', `${cat.id}.mind`)));
  } catch (err) {
    console.error(`ERROR ${cat.id}: no readable .mind (${err.code ?? err.message})`);
    continue;
  }
  const matchingDataList = data.dataList.map((t) => t.matchingData);
  if (matchingDataList.length !== cat.cards.length) {
    console.error(`ERROR ${cat.id}: ${matchingDataList.length} targets vs ${cat.cards.length} cards — recompile first`);
    continue;
  }

  const rows = [];
  for (const [truth, card] of cat.cards.entries()) {
    const img = await loadGrey(path.join(root, card.image.split('?')[0]));
    const row = { card: card.id, stockWrong: 0, rankedWrong: 0, rankedFound: 0, stockFound: 0, frames: 0, confusedWith: new Map(), worst: null };

    for (const [p, pose] of POSES.entries()) {
      const frame = renderFrame(img, pose, truth * 97 + p);
      const inputT = tf.tensor(frame, [FRAME_H, FRAME_W], 'float32');
      // The 9 detectMoving() crop positions, i.e. 9 consecutive video frames.
      for (let k = 0; k < 9; k++) {
        const { featurePoints } = cropDetector.detectMoving(inputT);
        const scores = scoreAll(featurePoints, matchingDataList);
        row.frames++;
        if (dumpPath) dumpLines.push(JSON.stringify({ deck: cat.id, truth, pose: pose.name, crop: k, scores }));

        const stock = scores.findIndex((s) => s > 0);
        if (stock !== -1) {
          row.stockFound++;
          if (stock !== truth) {
            row.stockWrong++;
            const name = cat.cards[stock].id;
            row.confusedWith.set(name, (row.confusedWith.get(name) ?? 0) + 1);
          }
        }

        const ranked = pickRanked(scores);
        if (ranked !== -1) {
          row.rankedFound++;
          if (ranked !== truth) row.rankedWrong++;
        }

        const others = scores.filter((_, i) => i !== truth);
        const rival = Math.max(0, ...others);
        if (!row.worst || rival - scores[truth] > row.worst.gap) {
          row.worst = { gap: rival - scores[truth], own: scores[truth], rival, rivalId: cat.cards[scores.indexOf(rival)]?.id };
        }
      }
      inputT.dispose();
    }
    rows.push(row);
  }

  const t = rows.reduce((a, r) => ({
    frames: a.frames + r.frames,
    stockWrong: a.stockWrong + r.stockWrong,
    rankedWrong: a.rankedWrong + r.rankedWrong,
    stockFound: a.stockFound + r.stockFound,
    rankedFound: a.rankedFound + r.rankedFound
  }), { frames: 0, stockWrong: 0, rankedWrong: 0, stockFound: 0, rankedFound: 0 });
  summary.push({ deck: cat.id, ...t, cards: rows.length, stockBadCards: rows.filter((r) => r.stockWrong).length, rankedBadCards: rows.filter((r) => r.rankedWrong).length });

  console.log(`=== ${cat.id} (${rows.length} cards, ${t.frames} frames) ===`);
  for (const r of rows) {
    const flag = r.rankedWrong ? 'WRONG ' : r.rankedFound === 0 ? 'UNSEEN' : r.stockWrong ? 'fixed ' : 'ok    ';
    if (!verbose && flag === 'ok    ') continue;
    const conf = [...r.confusedWith].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(' ');
    console.log(
      `  ${flag} ${r.card.padEnd(26)} stock ${String(r.stockWrong).padStart(2)} wrong/${String(r.stockFound).padStart(2)} found` +
      `   ranked ${String(r.rankedWrong).padStart(2)} wrong/${String(r.rankedFound).padStart(2)} found` +
      (conf ? `   stock picked: ${conf}` : '')
    );
  }
}

console.log('');
console.log('deck                          cards  frames | stock: wrong-frames cards-hit | ranked: wrong-frames cards-hit found%');
for (const s of summary) {
  console.log(
    `${s.deck.padEnd(28)} ${String(s.cards).padStart(6)} ${String(s.frames).padStart(7)} |` +
    ` ${String(s.stockWrong).padStart(18)} ${String(s.stockBadCards).padStart(9)} |` +
    ` ${String(s.rankedWrong).padStart(19)} ${String(s.rankedBadCards).padStart(9)} ${String(Math.round((100 * s.rankedFound) / s.frames)).padStart(6)}`
  );
}
console.log(`\nranked = most inliers, >= ${RANK_MIN_INLIERS} inliers, and ${RANK_MARGIN}x the runner-up (tools/mindar-ranking.js).`);
if (dumpPath) await writeFile(dumpPath, dumpLines.join('\n') + '\n');
