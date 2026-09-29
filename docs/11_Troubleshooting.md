# Troubleshooting

Problems are grouped by where you'll encounter them: using the app, running
it locally, deploying it, or maintaining content.

## Using the app

### "No Categories Found"

**Cause:** `assets/manifest.json` could not be fetched or parsed, or it has
zero categories.

**Fix:**

- Local dev: confirm `assets/manifest.json` exists at the project root and
  run `npm run validate` if it doesn't (or is stale).
- Production: this almost always means `VITE_ASSET_BASE` is unset, wrong,
  or the CDN bucket is missing/misconfigured. See
  [09_Deployment_Guide.md](09_Deployment_Guide.md) and run
  `npm run check:cdn`.
- Check the browser console/network tab for the actual failed request —
  `src/main.js`'s `loadManifest()` swallows the error into a generic empty
  state by design (see [05_API_Documentation.md](05_API_Documentation.md)),
  so the UI alone won't tell you *why* it failed.

### "Could Not Start AR" / camera won't open

**Cause:** one of several specific failures, each with its own message from
`src/camera-error.js`:

| Message shown | Meaning | Fix |
| --- | --- | --- |
| "Camera is blocked on insecure pages..." | The page isn't a secure (HTTPS) context. | Use the HTTPS dev URL, `localhost`, or a real HTTPS deployment — never plain HTTP over a network. |
| "This browser cannot access the camera." | `navigator.mediaDevices.getUserMedia` doesn't exist. | Use a modern browser; very old/embedded webviews may lack this API entirely. |
| "Camera permission was denied..." | The user (or the browser) blocked camera access. | Re-enable camera permission for the site in browser settings and reload. |
| "No camera was found on this device." | No camera hardware detected. | Expected on a desktop with no webcam; use a phone. |
| "The camera is already in use by another app." | Another app or tab holds the camera. | Close the other app/tab and retry. |
| "Camera works, but AR tracking failed to load..." | `getUserMedia` succeeded but MindAR itself failed to start. | Check that `assets/targets/<category>.mind` exists and is a valid, current compile for that category (`npm run check`). |

### The model doesn't appear even though the card is recognized (hint says "found")

**Likely cause:** the model failed to load. Look for "Model failed to load
for `<card name>`" in the on-screen status line.

**Fix:** Check the browser console/network tab for the actual fetch error
on the `.glb` file — usually a wrong path, a missing file on the CDN
(`npm run check:cdn`), or a corrupted upload.

### The model appears but looks wrong (upside down, floating off the card, wrong size)

**Cause:** this is a placement-data problem, not a code bug in most cases —
see the "Solver match-score trap" note in
[14_Admin_Guide.md](14_Admin_Guide.md). The model's `orient`/`box`/`fit`
values in `assets/placements.json` for that card (or its deck's `*`
wildcard) need tuning.

**Fix:** open `tools/place-models.html` (via `npm run tools`), find the
card, and adjust its orientation/box using the Match view.

### The word doesn't play automatically

**This is expected in many cases, not a bug.** Browsers block autoplay
until the page has seen a user gesture. The speaker button is always
enabled once a card is active — tap it. See "Saying the word" in the
project README for the full explanation, including the iOS-specific
silent-audio unlock trick.

### "Place Here" drifts or the model doesn't stay put

**Expected, within limits.** This is a gyroscope-only illusion, not real
world tracking. Rotating the phone in place should look correct; walking a
meaningful distance will visibly desync it — this is a documented,
accepted tradeoff, not a bug to "fix" with more code. See
[12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).
If the model doesn't move *at all* when turning the phone, check for
"...this phone reports no motion data" in the status line — some
devices/browsers expose the orientation event but never fire real
readings.

### On iOS, "Place Here" does nothing / prompts for permission every time

**Cause:** iOS 13+ requires `DeviceOrientationEvent.requestPermission()`,
granted only from a direct tap, and does not persist across page
reloads/sessions by default in all browsers. This is expected browser
behavior, not an app bug.

## Local development

### Certificate warning when opening `https://localhost:5173`

**Expected.** The dev server uses a self-signed certificate so the camera
(which requires a secure context) works locally. Accept the browser's
warning once per browser/device.

### `npm run tools` and `npm run dev` interfere with each other / weird 500 errors mentioning "html proxy"

**Cause:** the two Vite dev servers must not share `node_modules/.vite` —
if run with default config from the same cache, they fight over the
dependency-optimization cache and the tool pages' inline
`<script type="module">` starts failing.

**Fix:** this is already handled — `vite.tools.config.js` gives the tools
server its own `cacheDir`. If you see this error, confirm you're actually
running `npm run tools` (not `npm run dev` a second time) for the
authoring pages, and that nobody has edited `vite.tools.config.js` to drop
the separate `cacheDir`.

### Headless tool driver run fails with `receiver HTTP ...`

**Cause:** `tools/compile-headless.js` / `tools/solve-headless.js` POST
their output to the local receiver server, which isn't running.

**Fix:** start it in its own terminal first: `npm run receiver`.

### `npm run compress` or `npm run upload` fails immediately

**Cause:** these shell out to external binaries (`gltf-transform`/`npx`,
`rclone`) — if the binary isn't installed or isn't on PATH, the script
fails fast rather than partially processing files.

**Fix:** for `npm run upload`, confirm `rclone` is installed
(`winget install Rclone.Rclone` on Windows) and that you opened a new
terminal afterward so PATH picks it up. For `npm run compress`, confirm
`npm install` completed successfully (`@gltf-transform/cli` is a
devDependency).

## Deployment

### App deploys but shows "No Categories Found" in production only

See "No Categories Found" above — in production this is almost always a
`VITE_ASSET_BASE` problem. Specifically check:

1. Is the variable actually set in the hosting provider's dashboard?
2. **Did you redeploy after setting/changing it?** Vite inlines this
   variable at build time — changing it without a new build does nothing.
   This is the single most common mistake here.
3. Does the bucket actually have the files? Run `npm run check:cdn`.

### Assets load fine with `curl`/Postman but fail in the browser (production)

**Cause:** almost always a missing or wrong CORS policy on the bucket.

**Fix:** see the CORS policy JSON in
[09_Deployment_Guide.md](09_Deployment_Guide.md) and confirm it's applied
in the bucket's Settings.

### `npm run check:cdn` reports hundreds of files as missing, but you're sure they were uploaded

**Cause:** this happened for real during this project's own rollout — the
`r2.dev` free public URL rate-limits aggressively, and a fast full sweep
(`--all`) at high concurrency can return HTTP 429 for files that actually
exist. The checker retries 429/5xx with backoff at reduced concurrency by
design, so a large batch of "missing" reports right after a big
`check:cdn -- --all` run is worth a second look before assuming real data
loss.

**Fix:** re-run `npm run check:cdn`. If it's still failing, check
individual URLs by hand and consider moving off the free `r2.dev` URL to a
custom domain (not rate-limited).

### Every model fails to load in production, but the manifest and camera both work

**Cause:** almost always `public/draco/` didn't ship with the app build, or
was accidentally moved to the CDN bucket instead of staying with the app.
Every model is Draco-compressed and `src/placement.js` points the decoder
at the local `/draco/` path — it cannot be relocated to the CDN.

**Fix:** confirm `public/draco/draco_decoder.js`/`.wasm`/`_wrapper.js`
exist in the deployed `dist/` output.

## Content / asset pipeline

### `npm run validate` refuses to write a manifest

**By design.** It never writes a manifest while there are errors, so a
broken deck can't silently ship. Read the `ERROR` lines it prints — each
names the exact file and the exact rule it broke (naming, missing pairing,
duplicate files). Fix those and re-run.

### A whole deck scores badly in `npm run check` / the placement solver

See "A whole deck scoring low usually means the deck default box is wrong"
guidance in [14_Admin_Guide.md](14_Admin_Guide.md) — this is very often a
placement/mask problem (the box measuring a caption ribbon instead of the
subject), not a genuine tracking failure across every card in the deck.

### A card that scored a high "match" value still looks wrong in AR

**This is a known trap, not a contradiction.** A high match score means the
model's silhouette matches whatever the solver's mask found — not that the
mask found the right thing. See the "Solver match-score trap" guidance
referenced in [14_Admin_Guide.md](14_Admin_Guide.md): always visually check
the box shape after every solve, not just the score.
