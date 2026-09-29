# Requirements

These requirements are derived from the current, working implementation — they
describe what the app actually does and depends on today, not a future
wish-list (see [16_Future_Roadmap.md](16_Future_Roadmap.md) for that).

Terms: **must** = required, already true of the shipped app. **Recommend** =
a strong suggestion backed by evidence in the code or its comments, not a
hard rule.

## Functional requirements

### Category browsing

- The app must load `assets/manifest.json` on startup and show one tile per
  category, each with a thumbnail (the first card's image), a name, and a
  card count.
- If the manifest cannot be loaded or has no categories, the app must show a
  "No Categories Found" message with instructions instead of a blank or
  broken screen (`src/main.js`).
- The app must let the user search/filter categories and cards by name,
  live as they type, with no server round-trip (`src/deck-search.js`).
  Search must ignore accents and letter case, and match on partial words.
- A category with more than 25 cards must be visibly flagged in the grid as
  a "Large Deck" (`src/main.js`).

### Camera / AR session

- Selecting a category must request camera access and, on success, start
  live image tracking scoped to that category's compiled target file
  (`assets/targets/<category>.mind`).
- The app must fail with a clear, human-readable reason (not a blank screen
  or a raw browser error) when the camera cannot start — permission denied,
  no camera present, camera busy, or the page is not a secure (HTTPS)
  context (`src/camera-error.js`).
- When a printed card is recognized, the app must load (or reuse, if already
  cached) that card's 3D model and anchor it to the card's position.
- The model must render **upright in the plane of the card** (matching what
  the printed picture shows when the card is viewed head-on), using
  per-card orientation data from `assets/placements.json`.
- Recognizing a card must play that card's spoken-word audio clip once,
  automatically, if the browser's autoplay policy allows it; if not, the
  speaker button must remain available to play it on tap.
- Losing sight of a card (and nothing is placed in the room) must return the
  UI to "Point at one card" and stop that card's audio.

### Model interaction (gestures)

- One-finger drag must rotate the active model (turntable-style).
- Two-finger pinch must scale the active model within a fixed min/max range.
- Press-and-hold then drag must move the model within the card's local
  plane, clamped to a maximum offset.
- A clean tap directly on the model's geometry (no drag, no long press, no
  pinch anywhere in the gesture sequence) must replay its audio clip.
- A **Reset** control must restore the model's rotation, scale, and offset
  to their defaults for that specific card.
- Per-card transform (rotation/scale/offset) must be remembered across
  visits to the same card, using `localStorage`, and must degrade to
  memory-only (no crash) if `localStorage` is unavailable.
- On a device with no Pointer Events support, gesture controls must be
  skipped gracefully rather than breaking the app; the speaker button
  remains the way to hear the word.

### Placement ("Place Here")

- With a card actively tracked, the user must be able to detach its model
  from the card and pin it in the room using only the phone's gyroscope
  (no WebXR, no SLAM). See
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md)
  for the precise, accepted behavior and its limits.
- A **Return to Card** control must put a placed model back on its card in
  exactly the pose it had before placement.
- Only one model may be placed at a time.
- On iOS 13+, placement must request motion-sensor permission through a
  direct user tap, and must gracefully abort (leaving the UI unchanged) if
  the user denies it.
- While a model is placed, other cards coming into camera view must not
  steal focus or disturb the placement.

### Content pipeline (offline / maintainer-facing)

- Adding a new deck must be possible without writing code: drop files into
  `assets/cards/<deck>/`, `assets/models/<deck>/`, and optionally
  `assets/audios/<deck>/`, following the naming rules in
  [14_Admin_Guide.md](14_Admin_Guide.md).
- The validator (`npm run validate`) must catch mismatched or misnamed
  files and refuse to write a manifest if there are errors, rather than
  silently shipping a broken deck.
- Each deck must be compiled into a single `.mind` image-target file whose
  card order matches the manifest's order exactly, since MindAR identifies
  cards by index, not by name.
- A tracking-quality check (`npm run check`) must be available to flag
  cards unlikely to be recognized by the camera, before they reach users.

## Non-functional requirements

### Performance

- Image recognition must stay responsive with up to roughly 25 cards loaded
  in a single category; larger decks are a known degradation risk and
  should be split (see `npm run check`'s "crowded decks" report).
- The app bundle that must download before AR can start should stay small;
  the AR code path (`src/ar-view.js`, MindAR, three.js) is loaded as a
  separate chunk only when a category is opened, not on initial page load.
- 3D models must be Draco-compressed and have textures capped at 1024px,
  applied by `npm run compress`, to keep per-card downloads small on mobile
  data.

### Security / privacy

- The app must not require any account, login, or personal data entry.
- Camera access must only be requested when the user actively opens a
  category (never on page load), and only over a secure (HTTPS) context.
- R2/CDN credentials used by the upload tooling must never be sent to the
  browser — only environment variables prefixed `VITE_` are exposed to
  client code by Vite; the R2 credentials are deliberately unprefixed (see
  [08_Environment_Variables.md](08_Environment_Variables.md)).
- Original, unpublished print-master assets (`assets/cards-original/`,
  `assets/models-original/`) must never be uploaded to public storage; the
  upload and verification tools both enforce this explicitly.

### Compatibility

- Must run in a modern mobile browser with `getUserMedia` (camera),
  `DeviceOrientationEvent` (for placement), and WebGL (for three.js).
- Must degrade gracefully (not crash) on browsers lacking Pointer Events or
  device-orientation sensors — those features become unavailable rather
  than breaking the rest of the app.

### Reliability

- A production deploy must not silently show a blank/broken app when the
  asset library is missing or misconfigured; it must show "No Categories
  Found" with actionable instructions.
- The asset upload pipeline must be verifiable before going live
  (`npm run check:cdn`), rather than trusting the upload succeeded.

## Explicit non-requirements (by design)

- No user accounts, no login, no server-side data storage.
- No positional/world AR tracking (WebXR/ARKit/ARCore/SLAM) — see
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).
- No automated test suite exists today (see
  [10_Testing_Guide.md](10_Testing_Guide.md)); correctness is checked with
  purpose-built scripts and manual device testing instead.
