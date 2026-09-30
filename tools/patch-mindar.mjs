// Patches mind-ar 1.2.5's shipped bundle so a camera frame is recognised as
// the card that matches it BEST, not the first card that matches at all.
// Runs on postinstall and before dev/build/tools; idempotent and cheap.
//
//   node tools/patch-mindar.mjs          patch (no-op when already patched)
//   node tools/patch-mindar.mjs --check  exit 1 if the bundle is unpatched
//
// Two changes, both in node_modules/mind-ar/dist/controller-*.js:
//
// 1. The matcher worker (inlined as base64 in that file). Stock MindAR loops
//    the deck in manifest order and `break`s on the first target with >= 6
//    inliers. Template decks -- month calendars, time clocks, jerseys -- share
//    most of their keypoints, so the shared layout alone clears 6 on the first
//    card in the deck whichever card is actually in view: scan "june", get the
//    April model. The patch scores every target and hands the pick to
//    pickRanked() from tools/mindar-ranking.js: most inliers wins, and only if
//    it is clearly ahead of the runner-up. `npm run check:recognition` measures
//    exactly this rule offline.
//
// 2. The controller loop. With maxTrack 1, once a card is tracked MindAR stops
//    detecting entirely and only follows that card's template. Slide a
//    look-alike card into its place and the tracker happily keeps following
//    the shared layout, so the old model sits on the new card indefinitely.
//    The patch re-identifies every VERIFY_EVERY frames while tracking; if a
//    different card wins twice in a row, tracking hands over to it (and the
//    old card is dropped at once rather than lingering for missTolerance
//    frames, which would show two models).
//
// If mind-ar is upgraded the snippets below will not be found and this exits
// non-zero -- re-derive them from the new dist rather than dropping the patch.

import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANK_MARGIN, RANK_MIN_INLIERS, pickRanked } from './mindar-ranking.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'node_modules', 'mind-ar', 'dist');
const checkOnly = process.argv.includes('--check');

const MARK = '/*ar-flashcards:ranked-match v2*/';
const VERIFY_EVERY = 12; // frames between re-identifications while tracking

/* ------------------------------------------------------------------ worker */

const WORKER_STOCK =
  'for(let f=0;f<e.length;f++){const g=e[f],{keyframeIndex:a,screenCoords:j,worldCoords:w,debugExtra:y}=Gt.matchDetection(Kt[g],n.featurePoints);if(r=y,a!==-1){const m=St.estimate({screenCoords:j,worldCoords:w});m&&(t=g,s=m);break}}';

const pick = `((RANK_MIN_INLIERS,RANK_MARGIN)=>${pickRanked.toString()})(${RANK_MIN_INLIERS},${RANK_MARGIN})`;
// `scores` rides along on matchDone ({targetIndex: inliers}) so a page can see
// why a frame was or was not recognised; the controller ignores it.
const WORKER_RANKED =
  `${MARK}var __scores={};{const __res=[],__sc=[];for(let f=0;f<e.length;f++){const R=Gt.matchDetection(Kt[e[f]],n.featurePoints);r=R.debugExtra;__res.push(R);__sc.push(R.keyframeIndex===-1?0:R.screenCoords.length);__sc[f]&&(__scores[e[f]]=__sc[f])}` +
  `const __b=(${pick})(__sc);if(__b!==-1){const R=__res[__b],m=St.estimate({screenCoords:R.screenCoords,worldCoords:R.worldCoords});m&&(t=e[__b],s=m)}}`;
const WORKER_POST_STOCK = 'postMessage({type:"matchDone",targetIndex:t,';
const WORKER_POST_PATCHED = 'postMessage({type:"matchDone",scores:__scores,targetIndex:t,';

/* -------------------------------------------------------------- controller */

const CONTROLLER_STOCK = `          const { targetIndex: i, modelViewTransform: a } = await this._detectAndMatch(s, r);
          i !== -1 && (this.trackingStates[i].isTracking = !0, this.trackingStates[i].currentModelViewTransform = a);
        }`;

const CONTROLLER_PATCHED = `          const { targetIndex: i, modelViewTransform: a } = await this._detectAndMatch(s, r);
          i !== -1 && (this.trackingStates[i].isTracking = !0, this.trackingStates[i].currentModelViewTransform = a);
        } else if (this.maxTrack === 1 && this.interestedTargetIndex === -1 && (this.__verifyTick = (this.__verifyTick || 0) + 1) >= ${VERIFY_EVERY}) {
          ${MARK}
          this.__verifyTick = 0;
          const cur = this.trackingStates.findIndex((x) => x.isTracking);
          const { targetIndex: i, modelViewTransform: a } = await this._detectAndMatch(s, this.trackingStates.map((x, l) => l));
          if (i !== -1 && i !== cur) {
            if (this.__challenger === i) {
              this.__challenger = -1;
              const o = this.trackingStates[cur];
              o.isTracking = !1, o.showing = !1, o.trackCount = 0, o.trackMiss = 0, o.trackingMatrix = null;
              this.onUpdate && this.onUpdate({ type: "updateMatrix", targetIndex: cur, worldMatrix: null });
              this.trackingStates[i].isTracking = !0, this.trackingStates[i].currentModelViewTransform = a;
            } else this.__challenger = i;
          } else this.__challenger = -1;
        }`;

/* --------------------------------------------------------------------- run */

function fail(msg) {
  console.error(`patch-mindar: ${msg}`);
  process.exit(1);
}

let files;
try {
  files = (await readdir(distDir)).filter((f) => /^controller-.*\.js$/.test(f));
} catch {
  fail(`no ${path.relative(root, distDir)} -- run npm install`);
}

// The image controller is the one whose inlined worker handles "match".
// Every patch starts from a pristine copy (<file>.stock, saved on first run),
// so bumping MARK re-applies a changed patch instead of stacking on the old.
let target = null;
for (const f of files) {
  const live = await readFile(path.join(distDir, f), 'utf8');
  const stockPath = path.join(distDir, `${f}.stock`);
  let src = live;
  try {
    src = await readFile(stockPath, 'utf8');
  } catch {
    if (live.includes('/*ar-flashcards:')) fail(`${f} is patched but ${f}.stock is missing -- npm install mind-ar --force`);
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*) = "([A-Za-z0-9+/=]{20000,})"/g)) {
    const worker = Buffer.from(m[2], 'base64').toString('utf8');
    if (worker.includes('case"match":')) target = { file: f, live, src, stockPath, varName: m[1], b64: m[2], worker };
  }
}
if (!target) fail('could not find the image-target matcher worker in mind-ar/dist');

// Judged on the live file: the stock copy is never patched.
const liveWorker = [...target.live.matchAll(/"([A-Za-z0-9+/=]{20000,})"/g)]
  .map((m) => Buffer.from(m[1], 'base64').toString('utf8'))
  .find((w) => w.includes('case"match":')) ?? '';
const workerDone = liveWorker.includes(MARK);
const controllerDone = target.live.includes(`${MARK}\n`);

if (checkOnly) {
  if (workerDone && controllerDone) {
    console.log('patch-mindar: patched');
    process.exit(0);
  }
  fail(`unpatched (worker ${workerDone}, controller ${controllerDone}) -- run node tools/patch-mindar.mjs`);
}

if (workerDone && controllerDone) process.exit(0);

await writeFile(target.stockPath, target.src, { flag: 'wx' }).catch((err) => {
  if (err.code !== 'EEXIST') throw err;
});
if (!target.worker.includes(WORKER_STOCK)) fail('worker match loop not found -- mind-ar changed? re-derive WORKER_STOCK');
if (!target.worker.includes(WORKER_POST_STOCK)) fail('worker matchDone post not found -- mind-ar changed?');
if (!target.src.includes(CONTROLLER_STOCK)) fail('controller detect block not found -- mind-ar changed? re-derive CONTROLLER_STOCK');

const worker = target.worker.replace(WORKER_STOCK, WORKER_RANKED).replace(WORKER_POST_STOCK, WORKER_POST_PATCHED);
const src = target.src
  .replace(`${target.varName} = "${target.b64}"`, `${target.varName} = "${Buffer.from(worker, 'utf8').toString('base64')}"`)
  .replace(CONTROLLER_STOCK, CONTROLLER_PATCHED);
await writeFile(path.join(distDir, target.file), src);

// Vite pre-bundles mind-ar into these caches and would keep serving the stock
// copy; drop them so the next dev/tools start re-optimises from the patch.
for (const dir of ['.vite', '.vite-tools']) await rm(path.join(root, 'node_modules', dir), { recursive: true, force: true });

console.log(`patch-mindar: patched ${target.file} (ranked matching, re-identify every ${VERIFY_EVERY} frames)`);
