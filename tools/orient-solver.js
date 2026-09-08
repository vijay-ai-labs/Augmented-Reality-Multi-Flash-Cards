// Solves a model's orientation by matching its silhouette to the printed art.
//
// Source glTFs share no authoring convention (root nodes carry arbitrary
// matrices, local extents run 0.026 to 2954, the longest local axis is x, y or
// z depending on the file), so which way a model faces cannot be derived from
// the file. The card image is the ground truth: it already shows the subject
// from the view the model must present. So mask the printed subject, render the
// model from the AR camera's head-on direction at many orientations, and keep
// the one whose silhouette overlaps the print best.
//
// Owns no DOM. tools/place-models.html drives it.

import * as THREE from 'three';
import { UP_AXIS_KEYS, orientationQuaternion } from '../src/placement.js';
import { imageUrl } from '../src/config.js';

// Both masks are rasterized at this width. Big enough that thin legs and tails
// survive, small enough that ~800 GPU readbacks per model stay interactive.
const RASTER_W = 160;

/* --------------------------------------------------------------- print mask */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

// The background is modelled as a smooth quadratic surface per channel, not a
// flat colour. A single colour (or even two clusters) works on the white decks
// but fails on `bikes`, whose art is a dark ground under a bright spotlight: the
// pool's gradient is nowhere near the border colour, so a flat model calls the
// whole lit area "subject" and the measured silhouette becomes the spotlight
// instead of the bike (caught by the synthetic dark-bg case in testing).
// A quadratic tracks that falloff, and on a plain white card it just converges
// to a constant, so one code path serves every deck.
//
// x*x, x*y and y*y let the surface bend both ways; anything higher order starts
// fitting the subject itself.
function basisAt(x, y, out) {
  out[0] = 1;
  out[1] = x;
  out[2] = y;
  out[3] = x * x;
  out[4] = x * y;
  out[5] = y * y;
}

const BASIS = 6;

// Gaussian elimination with partial pivoting on the 6x6 normal equations.
function solveSymmetric(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < BASIS; col++) {
    let pivot = col;
    for (let r = col + 1; r < BASIS; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-9) return null; // singular: caller falls back
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < BASIS; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= BASIS; c++) m[r][c] -= f * m[col][c];
    }
  }
  // Fully reduced, so row i holds its pivot at column i.
  return m.map((row, i) => row[BASIS] / row[i]);
}

function fitChannels(data, w, h, isBg) {
  const phi = new Float64Array(BASIS);
  const ata = Array.from({ length: BASIS }, () => new Float64Array(BASIS));
  const atb = [new Float64Array(BASIS), new Float64Array(BASIS), new Float64Array(BASIS)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isBg[i]) continue;
      basisAt(x / w, y / h, phi);
      for (let a = 0; a < BASIS; a++) {
        for (let b = 0; b < BASIS; b++) ata[a][b] += phi[a] * phi[b];
        for (let c = 0; c < 3; c++) atb[c][a] += phi[a] * data[i * 4 + c];
      }
    }
  }
  // Ridge term keeps the solve stable when the background set is nearly
  // degenerate (a thin ring, or a subject filling almost the whole crop).
  for (let a = 0; a < BASIS; a++) ata[a][a] += 1e-6;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const solved = solveSymmetric(ata, atb[c]);
    if (!solved) return null;
    out.push(solved);
  }
  return out;
}

function residual2(coeffs, data, i, x, y, phi) {
  basisAt(x, y, phi);
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    let v = 0;
    for (let a = 0; a < BASIS; a++) v += coeffs[c][a] * phi[a];
    const d = data[i * 4 + c] - v;
    sum += d * d;
  }
  return sum;
}

// Refit two more times after the first pass so the surface stops being dragged
// by the subject pixels the border ring happened to include. The ring is always
// kept as a background sample: the crop is padded before it gets here, so its
// outermost pixels are background by construction and they anchor the fit
// against collapsing onto the subject.
function fitBackground(data, w, h, cut) {
  const isBg = new Uint8Array(w * h);
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.06));
  const onRing = (x, y) => x < ring || y < ring || x >= w - ring || y >= h - ring;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (onRing(x, y)) isBg[y * w + x] = 1;

  const phi = new Float64Array(BASIS);
  let coeffs = null;
  for (let iter = 0; iter < 3; iter++) {
    const next = fitChannels(data, w, h, isBg);
    if (!next) break;
    coeffs = next;
    if (iter === 2) break;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        isBg[i] = onRing(x, y) || residual2(coeffs, data, i, x / w, y / h, phi) <= cut ? 1 : 0;
      }
    }
  }
  return coeffs;
}

// Drop everything not connected to the largest blob. Card art carries drop
// shadows, spotlight pools and stray label pixels inside the crop; the subject
// is reliably the biggest connected region.
function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let bestId = -1;
  let bestSize = 0;
  let id = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = id; queue[tail++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = id; queue[tail++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = id; queue[tail++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = id; queue[tail++] = p + w; }
    }
    if (tail > bestSize) { bestSize = tail; bestId = id; }
    id++;
  }

  const out = new Uint8Array(mask.length);
  if (bestId < 0) return out;
  for (let i = 0; i < mask.length; i++) if (label[i] === bestId) out[i] = 1;
  return out;
}

// Flood the background inward from the border; anything left unreached is an
// interior hole (a bike's wheel gaps, a giraffe's leg gap) and belongs to the
// subject. Without this the print mask is hollow and IoU under-reports.
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  const seed = (i) => {
    if (!mask[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; }
  };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (y > 0) seed(p - w);
    if (y < h - 1) seed(p + w);
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || !outside[i] ? 1 : 0;
  return out;
}

/**
 * Mask the printed subject inside `box` (normalized [x, y, w, h], top-left
 * origin) of a card image. `threshold` is colour distance from the background
 * clusters, 0-255.
 *
 * Returns the mask plus `bounds`, the subject's true bounding box back in
 * normalized image coordinates -- that rect is a better `box` than any
 * hand-drawn one, and a `box` that hugs the print is what keeps cover-fit
 * overflow near zero.
 */
export async function printMask(card, box, threshold = 42) {
  const img = await loadImage(imageUrl(card));
  const [bx, by, bw, bh] = box;
  const sx = Math.round(bx * img.naturalWidth);
  const sy = Math.round(by * img.naturalHeight);
  const sw = Math.max(1, Math.round(bw * img.naturalWidth));
  const sh = Math.max(1, Math.round(bh * img.naturalHeight));

  const w = RASTER_W;
  const h = Math.max(1, Math.round((sh / sw) * RASTER_W));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const cut = threshold * threshold * 3; // squared distance summed over 3 channels
  const coeffs = fitBackground(data, w, h, cut);
  const raw = new Uint8Array(w * h);
  const phi = new Float64Array(BASIS);
  for (let y = 0; y < h && coeffs; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Transparent pixels are background regardless of their colour channels.
      if (data[i * 4 + 3] < 24) continue;
      if (residual2(coeffs, data, i, x / w, y / h, phi) > cut) raw[i] = 1;
    }
  }

  const mask = fillHoles(largestComponent(raw, w, h), w, h);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const covered = maxX >= 0;
  const bounds = covered
    ? [
        round3(bx + (minX / w) * bw),
        round3(by + (minY / h) * bh),
        round3(((maxX - minX + 1) / w) * bw),
        round3(((maxY - minY + 1) / h) * bh)
      ]
    : [...box];

  // `grid`/`aspect` are the shape-normalized form the scorer compares against;
  // `mask`/`w`/`h` stay raw for the editor's mask preview.
  const shape = normalizeMask(mask, w, h);
  return { mask, w, h, bounds, canvas, empty: !covered || shape.empty, grid: shape.grid, aspect: shape.aspect };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/* ------------------------------------------------------------- model masks */

// Normalize both silhouettes into the same square grid before comparing:
// crop each to its own bounding box, then stretch that box to fill the grid.
// Position and size are the placement box's job, so the score must be pure
// shape -- otherwise every candidate is penalised for the model's arbitrary
// source scale rather than for facing the wrong way.
const NORM = 64;

function normalizeMask(mask, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const out = new Uint8Array(NORM * NORM);
  if (maxX < 0) return { grid: out, aspect: 1, empty: true };
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  for (let y = 0; y < NORM; y++) {
    const sy = minY + Math.min(bh - 1, Math.floor((y / NORM) * bh));
    for (let x = 0; x < NORM; x++) {
      const sx = minX + Math.min(bw - 1, Math.floor((x / NORM) * bw));
      out[y * NORM + x] = mask[sy * w + sx];
    }
  }
  return { grid: out, aspect: bw / bh, empty: false };
}

function iou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 0;
}

/**
 * Offscreen silhouette renderer. One WebGL context and one render target are
 * reused for every candidate of every card -- a solve is ~800 renders per
 * model, and a fresh context each time would exhaust the browser's limit long
 * before the deck finished.
 */
export function createSilhouetteRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setSize(NORM, NORM, false);
  const target = new THREE.WebGLRenderTarget(NORM, NORM);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Orthographic down -Z is exactly what the AR camera sees when the card is
  // held head-on, which is the view the print was drawn from.
  // Near/far span both signs so a model centred anywhere along z stays inside
  // the slab; an orthographic camera has no perspective to lose by being wide.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);

  const holder = new THREE.Group();
  scene.add(holder);

  const buffer = new Uint8Array(NORM * NORM * 4);
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  return {
    setModel(object3d) {
      holder.clear();
      holder.add(object3d);
    },

    /** Render `orient` and return its shape-normalized mask. */
    silhouette(orient) {
      orientationQuaternion(orient, holder.quaternion);
      holder.position.set(0, 0, 0);
      holder.scale.setScalar(1);
      holder.updateMatrixWorld(true);

      box.setFromObject(holder);
      if (box.isEmpty()) return { grid: new Uint8Array(NORM * NORM), aspect: 1, empty: true };
      box.getSize(size);
      box.getCenter(center);
      // Frame to the candidate's own extent so the readback is never clipped
      // and never a speck; shape comparison happens after normalizeMask anyway.
      // The 1.4 pad covers skinned meshes, whose Box3 here is the un-skinned
      // bind pose (see the Box3 note in src/placement.js) while the render is
      // fully skinned -- padding is free, a clipped silhouette is not.
      const half = (Math.max(size.x, size.y) * 0.5 || 1) * 1.4;
      camera.left = center.x - half;
      camera.right = center.x + half;
      camera.top = center.y + half;
      camera.bottom = center.y - half;
      camera.updateProjectionMatrix();

      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, NORM, NORM, buffer);
      renderer.setRenderTarget(null);

      // readRenderTargetPixels returns bottom-up; flip so both masks share the
      // image convention (row 0 = top).
      const raw = new Uint8Array(NORM * NORM);
      for (let y = 0; y < NORM; y++) {
        for (let x = 0; x < NORM; x++) {
          raw[(NORM - 1 - y) * NORM + x] = buffer[(y * NORM + x) * 4] > 96 ? 1 : 0;
        }
      }
      return normalizeMask(raw, NORM, NORM);
    },

    dispose() {
      holder.clear();
      target.dispose();
      scene.overrideMaterial.dispose();
      renderer.dispose();
    }
  };
}

/* ------------------------------------------------------------------- search */

const HEADING_STEPS = 24; // 15 degrees
const COARSE_PITCH = [-20, -10, 0, 10, 20];

// Aspect agreement breaks ties between orientations with near-equal overlap:
// a lion seen head-on and in profile can score similarly on a blurred IoU, but
// only one has the print's wide silhouette.
function score(candidate, print) {
  if (candidate.empty || print.empty) return 0;
  const shape = iou(candidate.grid, print.grid);
  const ratio = candidate.aspect / print.aspect;
  const aspect = 1 / (1 + Math.abs(Math.log(ratio > 0 ? ratio : 1e-6)));
  return shape * 0.85 + aspect * 0.15;
}

/**
 * Search orientations for the best silhouette match.
 *
 * Coarse pass covers all 6 up-axes x 24 headings x 5 pitches, because the
 * up-axis is genuinely unknown per file and a wrong one cannot be recovered by
 * refining. The refine pass then walks heading, pitch and roll around the
 * winner. `onProgress(done, total)` is called throughout so a deck solve can
 * report; `signal` aborts between candidates.
 */
export function solveOrientation(silhouettes, print, { onProgress, signal } = {}) {
  const refineHeadings = [-8, -6, -4, -2, 2, 4, 6, 8];
  const refinePitches = [-10, -5, 5, 10];
  const refineRolls = [-10, -5, 5, 10];
  const total =
    UP_AXIS_KEYS.length * HEADING_STEPS * COARSE_PITCH.length +
    refineHeadings.length + refinePitches.length + refineRolls.length;

  let done = 0;
  let best = { up: '+y', heading: 0, pitch: 0, roll: 0 };
  let bestScore = -1;

  const consider = (orient) => {
    if (signal?.aborted) return;
    const s = score(silhouettes.silhouette(orient), print);
    done++;
    if (s > bestScore) {
      bestScore = s;
      best = { ...orient };
    }
    if (onProgress && done % 24 === 0) onProgress(done, total);
  };

  for (const up of UP_AXIS_KEYS) {
    for (let i = 0; i < HEADING_STEPS; i++) {
      const heading = i * (360 / HEADING_STEPS) - 180;
      for (const pitch of COARSE_PITCH) consider({ up, heading, pitch, roll: 0 });
    }
    if (signal?.aborted) break;
  }

  // Each refine pass probes a neighbourhood around the coarse winner, so the
  // base must be frozen before the pass runs. Reading `best` inside the loop
  // instead lets an accepted candidate move the base mid-pass: the heading
  // deltas then compound (h-8, then h-14, ...) rather than covering h+-2..8,
  // and pitch/roll end up searched around a heading that already shifted.
  const headingBase = { ...best };
  for (const d of refineHeadings) consider({ ...headingBase, heading: wrapDeg(headingBase.heading + d) });
  const pitchBase = { ...best };
  for (const d of refinePitches) consider({ ...pitchBase, pitch: pitchBase.pitch + d });
  const rollBase = { ...best };
  for (const d of refineRolls) consider({ ...rollBase, roll: rollBase.roll + d });

  if (onProgress) onProgress(total, total);
  return { orient: { ...best, heading: wrapDeg(Math.round(best.heading)) }, match: Math.round(bestScore * 100) / 100 };
}

function wrapDeg(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
