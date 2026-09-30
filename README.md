# AR Multi Flashcards

Web AR app: pick a category, point the phone camera at a printed flashcard, and
the matching 3D model appears on the card. Built with
[MindAR](https://hiukim.github.io/mind-ar-js-doc/),
[three.js](https://threejs.org/), and Vite.

## How it works

1. You open the app and tap a category.
2. The app loads that category's compiled image-target file
   (`assets/targets/<category>.mind`) and starts the camera.
3. When a card is recognized, its `.glb` model is fetched, cached, anchored to
   the card, positioned with `assets/placements.json` when available, and
   animated if the model has animations.

Recognition is scoped per category on purpose. MindAR is fast and accurate with
smaller target sets, but tracking quality drops when too many cards are loaded
at once.

## Asset drop-in rules

Use this folder layout when adding new cards and models:

```text
assets/
  cards/<category>/<card-name>.jpg
  models/<category>/<card-name>.glb
  audios/<category>/<card-name>.mp3
```

- **Names:** Use lowercase letters, digits, and hyphens only. Don't use spaces.
  Example: `cards/animals/red-panda.jpg` and
  `models/animals/red-panda.glb`.
- **Pairing:** The card image and model must share the same base name.
- **Audio:** Optional, and the base name must match too. `.mp3`, `.m4a`, `.ogg`
  or `.wav`. A card with no clip still works — its speaker button stays greyed
  out. A misnamed clip is an error, since that is a rename and not a gap.
- **Words:** Hyphenate multi-word names — the card's spoken/displayed name is
  the slug title-cased on hyphens, so `leaning-tower-of-pisa` reads "Leaning
  Tower Of Pisa" while `leaningtowerofpisa` reads "Leaningtowerofpisa". A few
  country codes are upper-cased instead (`ACRONYMS` in `tools/validate-assets.mjs`).
- **Images:** Use flat scans cropped to the card border, with no glare or
  shadow. Use at least 500px on the short side. Print masters above 1200x1700
  are wasted at runtime and can exhaust the browser target compiler's memory on
  a large deck — run `node tools/resize-cards.mjs <deck>` to bring them down
  (originals are kept in `assets/cards-original/`).
- **Tracking:** Feature-rich artwork tracks well. Plain text and large
  flat-color areas track poorly.

## Pipeline

Run these commands after dropping assets into the project:

```bash
npm install
npm run validate            # catches naming/pairing errors
npm run compress            # or: node tools/compress-models.mjs <deck> [deck...]
npm run validate            # again: stamps each model URL with the compressed file's hash
# compile targets (below), then:
npm run validate            # again: stamps each target URL with the compiled .mind's hash
npm run check               # see Cards that cannot track
npm run dev
```

Compressing re-reads the pristine backup every time, so a whole-library run is
always safe — it is just slow, one `gltf-transform` process per model. Name the
decks when only some have changed.

Validate writes each model as `assets/models/<deck>/<card>.glb?v=<hash>`, where
the hash is taken from the compressed file. Models go to the CDN with a one-year
immutable cache header, so this is the only way a replaced model reaches a
phone that already cached the old one. That is why validate has to run again
after compress. Audio clips get the same `?v=<hash>`, and so do target files
(`assets/targets/<deck>.mind?v=<hash>`) — so validate runs once more after
compiling. A stale target is the worst case of the three: MindAR anchors are
index-based, so a phone holding the old `.mind` against a manifest with a card
inserted shows every later card with its neighbour's model. `npm run upload`
refuses to send a manifest whose target hashes don't match the files on disk.

Then start the tool server in its own terminal with `npm run tools` (see
[Running the tool pages without a human](#running-the-tool-pages-without-a-human)
for why it is a separate server), open
`http://localhost:5174/tools/compile-targets.html`, choose the
`assets/targets/` folder, tick the categories you need, and compile. Categories
that already have a `.mind` file start unticked, so nothing finished is redone.

### Replacing a model

Put the new source `.glb` in **`assets/models-original/<deck>/<card>.glb`**,
never in `assets/models/`. Compress always builds from the backup, so a file
dropped straight into `models/` gets overwritten by the old model. Then:

```bash
node tools/compress-models.mjs assets/models/<deck>/<card>.glb   # one or more
npm run validate
```

**Start the tool server with an empty asset base** when `.env` sets
`VITE_ASSET_BASE` (it does once you deploy): `VITE_ASSET_BASE= npm run tools`
in Git Bash, or `$env:VITE_ASSET_BASE='/'; npm run tools` in PowerShell (there
`''` deletes the variable and `.env` wins again; `/` is stripped to empty by
`src/config.js`). Otherwise every tool
page loads models, cards and `placements.json` from the live CDN — you see
the old model, not the one you just compressed, and a solve POSTs the CDN's
`placements.json` back over your local one.

Re-solve that card's placement (see [Placing models on cards](#placing-models-on-cards)):
its stored `orient` was tuned for the old mesh. With `npm run tools` and
`npm run receiver` running, `run(['<deck>'], {}, { only: ['<card>'] })` from
`tools/solve-headless.js` re-solves only that card and leaves the rest of
`placements.json` alone. Review the result in Match view, then upload
`models` and `--json`.

### Replacing an audio clip

Overwrite `assets/audios/<deck>/<card>.mp3` in place. The name must match the
card exactly, or validate drops that card's audio and `upload -- audios`
deletes the live clip. Clips get the same `?v=<hash>` treatment as models, so
no other step is needed:

```bash
npm run validate
npm run upload -- audios
npm run upload -- --json
```

Cards, models, targets and placements are unaffected, so there is no target
recompile and no re-solve.

### Running the tool pages without a human

`tools/compile-headless.js` and `tools/solve-headless.js` do the same work as
the two tool pages with no UI, for scripted or agent-driven runs. Both write
their output by POSTing to a small local receiver rather than using
`showDirectoryPicker()` or a download, since a driven browser has nowhere to put
a file:

```js
const m = await import('/tools/compile-headless.js');
m.run(['scientist', 'currency']);   // do not await
window.__headless                   // { state, deck, progress, done, errors }
```

`solve-headless.js` is the same shape with `window.__solve`, and reuses the
editor's own defaults (mask threshold 42, box from the printed subject) so a
card solved headlessly lands where the editor would have put it. It still only
does the mechanical part — read the resulting `match` scores and review anything
below ~0.55 by hand in `place-models.html`.

A solve overwrites every key it touches, `yaw` included, so re-solving a deck
that already has hand-tuned cards throws that work away — the `locked` flag the
solver writes is never read back as a guard. Pass `only` or `skip` to hold a
deck's finished cards out of the run, which is how the 52 cards added to
`alphabets` were solved without disturbing the original 26:

```js
m.run(['alphabets'], {}, { only: ['a-apple', 'b-ball', /* ... */] });
```

A whole deck scoring low usually means the deck default box is wrong, not that
the models are. If the box reaches into a caption ribbon or the title, the mask
measures that too and every card in the deck solves against an inflated
silhouette. `sweep()` tries a grid of thresholds and boxes and reports the mean
and worst match for each, without writing anything:

```js
const m = await import('/tools/solve-headless.js');
await m.sweep('freedom-fighter', {
  thresholds: [42, 70],
  boxes: [null, [0.17, 0.22, 0.66, 0.44]]   // null = the deck's current default
});
```

**A high mean does not mean the deck is placed correctly.** The score says the
model's silhouette matches whatever the mask found — not that the mask found the
subject. The `month` deck solved at mean 0.90 with every card wrong: its printed
calendar is white-on-white, so the mask only ever saw the red header, and the
solver happily matched an edge-on word model to that bar. Skim the boxes as well
as the scores. A box that is a thin strip, sits low on the card, or covers a few
percent of it has usually locked onto a caption ribbon, a title, or one bright
fragment of the subject:

```bash
node -e "const p=require('./assets/placements.json');for(const[k,v]of Object.entries(p))\
{if(k.endsWith('/*')||!v.box)continue;const[x,y,w,h]=v.box;\
if(w*h<0.06||y>0.62||h<0.15)console.log(k,v.match,JSON.stringify(v.box))}"
```

Feed the winner back as per-deck tuning, which also rewrites that deck's
`<deck>/*` box so the editor starts from the corrected default:

```js
m.run(['freedom-fighter'], {
  'freedom-fighter': { threshold: 70, box: [0.17, 0.22, 0.66, 0.44] }
});
```

This is what lifted `freedom-fighter` from mean 0.60 / worst 0.46 to mean 0.74 /
worst 0.66 — its cards carry a caption ribbon the original box was including.

Both need two processes of their own, one per terminal:

```bash
npm run tools       # plain-HTTP Vite on :5174 for the tool pages
npm run receiver    # write-back server on :5999
```

`npm run tools` uses [vite.tools.config.js](vite.tools.config.js) rather than
the app's config, for two reasons:

- The app's dev server is HTTPS (basic-ssl) and a headless browser stops at the
  self-signed cert. The tool pages don't use the camera, so they don't need a
  secure context.
- Two Vite servers on this project must not share `node_modules/.vite`. They
  fight over the dep-optimize cache and the html-proxy registry, and the tool
  pages' inline `<script type="module">` starts answering 500 "No matching HTML
  proxy module found". The tools config gets its own `cacheDir`.

`npm run receiver` ([tools/receiver.mjs](tools/receiver.mjs)) is where both
drivers POST their output — `.mind` files to `assets/targets/`, placements to
`assets/placements.json`. Without it running, a driven run does all the work and
then fails at the last step with `receiver HTTP ...`.

Driving them from a browser automation tool means running the module's `run()`
without awaiting it and polling its state object instead — a solve or compile
call takes minutes and will time out any single evaluate:

```js
window.__m = await import('/tools/compile-headless.js');
window.__m.run(['fruits']);        // no await
JSON.stringify(window.__headless); // poll this
```

Re-run `npm run validate` and recompile the affected category's targets whenever
cards are added, renamed, or removed. MindAR anchors are index-based, so target
order must match manifest order.

## Cards that cannot track

`npm run check` (`tools/check-targets.mjs`) reads the compiled `.mind` files and
reports, per card, the two numbers that decide whether MindAR can find and hold
that target:

- **features** — keypoints in the full-scale matching keyframe, which is what a
  camera frame is matched against. Too few and the card is rarely recognised.
- **tracking** — points in the 128px tracking keyframe. `tracker.js` pins
  `TRACKING_KEYFRAME = 1`, so that single level is the entire basis of
  frame-to-frame tracking, and `controller.js` drops the target once fewer than
  4 survive. A card in single digits gets found and lost again immediately,
  which looks like flicker rather than failure.

Nothing else in the pipeline can tell you this. `validate` only sees file names
and byte sizes, and the compiler reports success as long as it wrote a file — a
card whose art is one flat shape compiles into a perfectly valid target that the
camera can never match.

**Low counts are a property of the card art, not of the compile.** Flat vector
shapes, large uniform areas and thin line work give the detector nothing to hold,
and recompiling will not change the numbers. The fix is re-arting those cards
with texture and detail — a photo or a shaded illustration instead of a solid
silhouette. Across the current library the median card scores 191 features and
21 tracking points, so those are the numbers to aim at.

`check` also lists decks over 25 cards. Detection compares a camera frame
against every target in the loaded `.mind`, so a crowded deck slows every scan
and lets weak targets lose to their neighbours; splitting one is a real fix for
"some cards in this deck are never recognised".

### Transparent card art

Card images are matted onto white before compiling — `tools/load-card-image.js`,
used by both the interactive page and the headless driver. MindAR's compiler
greys pixels with `(R+G+B)/3` and never reads alpha, and a fresh canvas starts
transparent *black*, so any transparent region of a card would otherwise compile
as solid black. Ten of the `numbers` cards are rounded white artwork with a
transparent margin outside the corner radius: they had compiled with a hard black
frame that does not exist on the printed card, and that frame — the strongest
edge in the image — dominated feature extraction against a card the camera only
ever sees on white paper.

## Placing models on cards

Models stand **upright in the card plane** — up along the card's up, front toward
the camera — so a card viewed head-on shows the same view as its printed picture.
`assets/placements.json` says where on the card each model sits, which way it
faces, and how big it is. Two kinds of key, exact wins over the wildcard:

```json
"animals/*":    { "box": [0.17, 0.29, 0.64, 0.48] },
"animals/lion": {
  "box":    [0.178, 0.299, 0.625, 0.459],
  "orient": { "up": "+y", "heading": 26, "pitch": 0, "roll": 0 },
  "fit":    "cover",
  "match":  0.72,
  "locked": true
}
```

- `box` is `[x, y, w, h]` normalized to the card image, origin top-left — the
  bounds of the printed picture. The model is centered on it and sized from it.
- `orient.up` names the model-local axis that should point up (`+x -x +y -y +z
  -z`); `heading` / `pitch` / `roll` are degrees applied after that. Source
  `.glb` files share no authoring convention, so this is per-card data.
- `fit` is `cover` (default — model is at least as large as the printed picture
  on both axes) or `contain`. `scale` multiplies whichever you pick.
- `match` is the solver's silhouette score, 0–1. Informational; it sorts the
  editor's card list worst-first for review.
- `yaw` is the legacy form of `orient.heading` and still works.
- `<category>/*` is the deck default — enough on its own for decks where every
  card uses the same printed template.

Tune these at `http://localhost:5174/tools/place-models.html`, served by
`npm run tools` — not the app's HTTPS dev server, which the two Vite instances
must not share:

1. **Solve deck** matches every model's silhouette against its printed art and
   writes `orient`, `match`, and a `box` measured from the print itself.
2. Review in **Match view** — the exact head-on view the AR camera gets, with a
   model-opacity slider to compare against the print behind it. The card list is
   sorted worst-match-first, so start at the top.
3. Fix stragglers with the up-axis / heading / pitch / roll controls, then save.

**The solver cannot tell front from back.** A model's back view is the mirror
image of its front view, so for any roughly symmetric subject both score the
same — this is why frogs, cars and figures shipped showing their backs. Two
tool pages check and fix that by eye:

- `tools/review-sheet.html?deck=animals` (or `?cards=animals/frog,birds/ibis`)
  shows each print beside its model rendered alone, in full colour, exactly as
  the AR view places it — plus a mid-clip frame for animated models. Use it
  after every solve or model swap.
- `tools/pick-orient.html?cards=animals/frog` renders the model at every
  up-axis × 8 headings next to the print (with a 0.1 grid for reading a `box`).
  Pick the matching cell and write its `up`/`heading` into `placements.json`.
  `&ups=cur`, `&headings=…`, `&pitches=…` narrow the grid.

- `tools/float-test.html?deck=animals` checks the pop-out-and-float motion
  (`src/float-motion.js`) on every card numerically — starts on the card,
  no jerky frames, never dips through the card, pop survives a slow first
  frame, shadow on the card. `&film=1&cards=…` renders a film strip from a
  phone-over-table angle instead.

Most source models face the camera at `up +y, heading 0`; heading −90 turns the
face to the viewer's left, +90 to the right. `fit: "contain"` is the safer
default for anything long or tall (vehicles, flags on poles, towers).

If the solver picks out the wrong subject, use **preview** next to the mask
threshold to see what it masked, and adjust the threshold. The preview renders
through the same `src/placement.js` the AR view uses, so what you see is what
the camera will show.

## Saying the word

Each card carries a short clip of its own name. When the model appears, the clip
plays once by itself; after that the 🔊 button, or a tap on the model, replays it
from the start.

The whole app shares **one** `Audio` element ([src/audio-player.js](src/audio-player.js)).
Its `src` is swapped as the active card changes — never one element per card,
which at 105 cards would mean 105 media elements and 105 preload fetches. The
previous card is always stopped and rewound before the next `src` is assigned,
so one card's word can never bleed into the next.

- **Auto-play** fires when the card is already built (every sighting after the
  first, since the GLTF is cached), otherwise when the model finishes loading —
  so the word lands with the model rather than over an empty screen.
- **Blocked autoplay is expected, not an error.** Browsers refuse to play until
  the page has seen a user gesture; the rejection is swallowed silently. The
  speaker button is enabled before the attempt, so the word is always one tap
  away. Tapping a deck tile primes the element with 8 samples of silence, which
  is what makes auto-play work on iOS at all.
- The button means "a word is loaded", not "playing" — it is enabled whenever a
  card with a clip is active, whatever the playback state. It is not a
  play/pause toggle and there is no progress UI.
- Both replay triggers funnel through one `replayActiveAudio()` in
  [src/ar-view.js](src/ar-view.js) so they cannot drift apart. The model tap
  needs a real hit on the model's geometry: no drag, no long press, no pinch
  anywhere in the sequence, and tapping empty space beside the model does
  nothing.

## Place Here — pinning a model in the room

Once a card is recognized and its model is on screen, **Place Here** detaches
the model from the card and pins it in place. Put the card away and the model
stays where it was, so you can look around it. **Return to Card** puts it back.

### It is a 3DOF illusion, on purpose

There is no positional tracking here — no WebXR, no ARKit/ARCore, no SLAM. The
only signal is the phone's gyroscope, via `DeviceOrientationEvent`.

MindAR keeps its camera at the origin and moves the anchors, so scene space *is*
camera space. Detach the model into the scene root and it is stuck to the
screen; counter-rotate its position by however much the phone has turned since
placement and it appears stuck to the **room** instead:

```text
deltaWorld = deviceQuatNow * deviceQuatAtPlacement⁻¹   // world frame: Q1 * Q0⁻¹
model.position = placedWorldPosition.applyQuaternion(deltaWorld.invert())
```

Only the position is compensated — the model keeps the orientation it was placed
with, so it does not spin as you move around it.

**Rotating the phone in place works. Walking a long way desyncs the illusion,**
because translation is never compensated. That is the accepted tradeoff, not a
bug — fixing it would mean real world tracking, which is exactly what this
avoids.

The compensation is exact for yaw with the phone held upright, which is the
motion that matters. Off-axis tilt and landscape drift slightly; see the comment
in [src/placement-manager.js](src/placement-manager.js) for why.

### Where things live

[src/placement-manager.js](src/placement-manager.js) is a standalone class whose
only dependency is three.js. It holds no DOM or UI code — it moves three.js
objects and owns its own state. Buttons, status text and haptics belong to the
caller.

[src/ar-view.js](src/ar-view.js) is that caller, with three wire-up points
marked in comments:

1. The `Place Here` / `Return to Card` button elements.
2. `target.anchorGroup` — each trackable model's own marker anchor group, which
   the manager reparents out of and back into.
3. The `placementManager.update()` call in the render loop, after per-model
   animation.

What gets pinned is the per-card `placementGroup`, not the bare model, so the
card's placement offset and the user's own rotate/zoom survive placement — a
placed model can still be spun and pinched, and returning it to the card lands
it exactly where it was.

While a model is placed: other markers coming into view are ignored rather than
stealing focus, and losing the marker does not hide it.

### Notes

- **Single-model placement by design.** One `PlacementManager`, one placed model.
  Several at once would need one manager per model, each with its own reference
  quaternion — not this shared instance.
- **iOS 13+** needs `DeviceOrientationEvent.requestPermission()`, and only grants
  it from a direct tap. If it is denied the placement is aborted, nothing is
  reparented, and the UI returns to where it was. Android and older iOS skip the
  permission step entirely.
- A phone that exposes the event but no sensor never fires usable data. The
  status line says so instead of the model appearing silently stuck.

## Testing on a phone

Camera access requires HTTPS. You can test on a phone by using one of these
options:

- Use the HTTPS LAN URL printed by `npm run dev` and accept the local
  certificate warning on the phone.
- Use `npx localtunnel --port 5173`, ngrok, or Cloudflare Tunnel.
- Deploy a draft build to a static host.

## Production

`npm run build` emits `dist/`, which holds the app **and nothing else** —
`assets/` is not part of the build. It is ~800MB of runtime data (plus
`cards-original/` and `models-original/`, which are backups and must never
ship), and Vite copies `publicDir` into `dist/` on every build, so putting the
library there would make each build copy the lot.

That means a deploy is two halves:

1. Deploy `dist/` to Cloudflare Pages, Netlify, Vercel, or another static host.
2. Serve `assets/manifest.json`, `assets/placements.json`, and the
   `assets/cards/`, `assets/models/`, `assets/targets/`, `assets/audios/`
   directories from the same origin under `/assets/` — or put them on object
   storage or a CDN and set `ASSET_BASE` in [src/config.js](src/config.js) to
   that public URL.

Miss the second half and the app loads, finds no manifest, and shows "No
Categories Found". `npm run preview` serves those directories from the project
root (see the middleware in [vite.config.js](vite.config.js)) so a production
build can be checked locally without staging 800MB into `dist/`.

`public/draco/` **does** ship in `dist/`, and must. Every model in the library is
Draco-compressed, so `public/draco/` (three r160's own glTF decoder build, which
`src/placement.js` points `DRACOLoader` at) is what makes any model load at all.
It stays with the app even when `ASSET_BASE` moves the library to a CDN.
