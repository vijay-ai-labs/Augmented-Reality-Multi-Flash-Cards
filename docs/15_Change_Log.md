# Change log

This project's git history currently has three commits. This log expands
each into a readable summary. As the project grows, add new entries at the
top (newest first) rather than rewriting old ones.

<!-- prettier-ignore -->
> [!NOTE]
> Earlier, pre-git-history milestones below (platform choice, the "Place
> Here" gyroscope design, the glTF spec/gloss fix, and others) are drawn from
> the project's own working notes rather than commit messages, since the
> repository's git history starts partway through the project's life. Dates
> are as recorded in those notes.

## 2026-09-30 — Replace wrong audio clips and cache-bust audio URLs

71 clips had the wrong recording: `national-birds-animals/emu`,
`monuments/konark-sun-temple`, `monuments/mysore-palace`, `colors/red-car`,
and every clip in `fruits`, `space`, `universe` and `cars`. They were
overwritten in place and uploaded to R2. A second batch the same day replaced
13 more: `numbers/0-1`, `scientist/telephone`,
`country-capitals-landmarks/{cape-of-good-hope, christ-the-redeemer,
gyeongbokgung, st-basil}` and `vegetables/{capsicum, fennel, garlic, jalapeno,
leek, okra, pumpkin}`.

Audio is served with a one-year immutable cache header and its manifest URL
was the bare file path, so a phone that had played a wrong clip would have kept
it. `tools/validate-assets.mjs` now appends `?v=<hash>` to every `audio` URL,
as it already did for models. All 541 clip URLs changed once; each phone
re-downloads a clip the next time it plays it.

## 2026-09-09 — Fix check-cdn treating the `--origin` value as the base URL

`npm run check:cdn -- --origin https://my-app.vercel.app` was silently
checking the wrong thing: the base-URL argument was found with
`argv.find(a => a.startsWith('http'))`, which matched `--origin`'s *value*
first instead of the intended positional bucket URL. This made the checker
probe the deployed app for `/assets/...` paths instead of the CDN bucket,
reporting all sampled files as 404 against a bucket that was actually
complete. Fixed by collecting positional arguments explicitly and rejecting
an `--origin` flag with no URL after it.

## 2026-09-09 — Add R2 asset pipeline and CDN verification for deployment

The largest single change in the project's git history. Established the
two-halves deployment model (app on a static host, asset library on
Cloudflare R2) end to end:

- `src/config.js` now reads `VITE_ASSET_BASE`, defaulting to same-origin so
  local dev/preview are unaffected.
- Added `tools/upload-assets.mjs` (`npm run upload`) to sync the four
  runtime asset directories to R2 via `rclone`, deliberately naming
  directories explicitly rather than filtering, so the local-only
  `*-original/` print masters can never be swept up by a filter bug.
- Added `tools/check-cdn.mjs` (`npm run check:cdn`) to verify a live bucket
  before deploying — byte-size match, CORS header, cache header, content
  type, and an explicit check that the original-asset folders are not
  publicly reachable.
- Added `.env.example` documenting `VITE_ASSET_BASE` and the R2
  credentials, and restored `.gitignore`/`.gitattributes`, which had been
  deleted in the working tree (without them, a commit would have staged
  ~6.7 GB of assets and hit GitHub's 100 MB per-file limit).
- Added `vercel.json` pinning the Vite build preset and caching
  `/draco/` for a year.
- Verified against the real bucket: 1,653 asset files plus the two JSON
  files, 0.86 GB, uploaded in about two minutes; a full `check:cdn --all`
  sweep then reported 0 broken, 0 warnings.
- Found and documented two real bugs while building this: `rclone` spawned
  through a shell mis-split arguments because the project path contains a
  space, and a first full verification sweep misreported throttled (HTTP
  429) responses as missing files.

Full detail: [docs/superpowers/specs/2026-09-09-vercel-r2-deploy-design.md](superpowers/specs/2026-09-09-vercel-r2-deploy-design.md).

## 2026-09-XX (initial commit) — Initial commit: AR Multi Flashcards web app

The baseline commit establishing the working app as it exists today: the
category picker, MindAR + three.js AR session, card placement math, the
"Place Here" gyroscope-pinning feature, shared audio playback, and the
content-authoring tool pages and scripts under `tools/`.

## Earlier milestones (from project working notes, predating recorded git history)

- **2026-07-17 — Project started; platform decision.** Chose a web app
  (MindAR + three.js + Vite, with a category picker) over a native
  Unity/AR Foundation approach, after comparison. The category picker
  exists specifically because MindAR cannot handle the full card library
  (300+ cards planned) loaded as one target set.
- **2026-07-17 — Core MindAR integration issues found and fixed:**
  MindAR's own `<video>` element defaulting to a negative `z-index`
  (worked around with `isolation: isolate` in `src/styles.css`); MindAR
  leaving its own scanning-overlay DOM elements on `<body>` after stop
  (worked around by disabling MindAR's built-in UI and rendering custom
  status text instead); MindAR rejecting `start()` with `undefined` on
  camera failure (worked around by `src/camera-error.js` probing
  `getUserMedia` directly to produce an actual, readable message).
- **2026-09-02 — "Place Here" room-pinning feature designed and built.**
  Explicitly chose a gyroscope-only 3DOF illusion over an initial
  WebXR-plus-fallback implementation. See
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md)
  for the accepted tradeoffs this decision carries.
- **2026-09-03 — Headless/scripted tool driving added.** `npm run tools`
  (a second, plain-HTTP Vite server) and `npm run receiver` (a local
  write-back server) were added so the content-compiling and
  placement-solving tool pages could be driven by scripts/agents instead of
  only by a human clicking through the UI. Per-deck arguments were also
  added to `compress-models.mjs` around this time.
- **2026-09-03 — "Solver match-score trap" identified.** Discovered that a
  high placement-solver match score does not guarantee a correct
  placement — the `month` deck solved at a mean of 0.90 with every card
  wrong, because its white-on-white artwork caused the mask to latch onto
  a caption bar instead of the subject. Documented as a standing review
  practice for anyone tuning placements — see
  [14_Admin_Guide.md](14_Admin_Guide.md).
- **2026-09-04 — `ASSET_BASE` requirement raised.** Identified that a plain
  `dist/` deploy ships zero bytes of `assets/` (Vite only copies
  `public/`), which would render "No Categories Found" in production. The
  decision at the time was to leave the build as-is (no copy step) and
  solve it with a CDN + `ASSET_BASE`, which became the R2 pipeline shipped
  2026-09-09.
- **2026-09-07 — glTF spec/gloss material bug found and fixed.** three.js
  dropped support for the legacy `KHR_materials_pbrSpecularGlossiness`
  extension in r150 and only logs a console warning — 39 models in the
  library were affected and rendered as untextured white blobs.
  `tools/compress-models.mjs` was updated to run `gltf-transform
  metalrough` on affected models before optimizing.
- **2026-09-07 — `npm run check` (`tools/check-targets.mjs`) written.**
  Added the tracking-quality report described throughout this
  documentation set, after confirming that "card not recognized" is almost
  always an art problem invisible to every earlier stage of the pipeline.
  At the time of writing, the library stood at 30 decks, 541 cards, all
  with audio, and a median of 191 features / 21 tracking points per card.
