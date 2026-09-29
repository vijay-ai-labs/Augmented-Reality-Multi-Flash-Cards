# API documentation

This project has **no application server and no public REST/GraphQL API**.
The AR app talks only to static file hosts — the app itself and, for assets,
a CDN/object-storage bucket — by plain HTTP `GET`/`HEAD` requests for files.

The only things resembling "APIs" in this codebase are:

1. **Static asset endpoints** the app itself depends on (read-only files).
2. **A tiny local write-back HTTP server** used only by content maintainers,
   on their own machine, never deployed.

Both are documented below for completeness.

## 1. Static asset "endpoints" (production, read-only)

These are plain files served over HTTP(S) from `ASSET_BASE` (same origin in
dev, a CDN URL in production — see
[08_Environment_Variables.md](08_Environment_Variables.md)). There is no
server-side logic behind them; a `GET` for a missing file returns whatever
404 your static host returns.

| Path | Method | Returns | Used by |
| --- | --- | --- | --- |
| `/assets/manifest.json` | GET | The full card catalog (see [04_Data_Model.md](04_Data_Model.md)) | `src/main.js` on startup |
| `/assets/placements.json` | GET | Per-card 3D placement data | `src/placement.js`, on opening any category |
| `/assets/targets/<category>.mind` | GET | Compiled MindAR image-target file for one category | `src/ar-view.js`, on opening that category |
| `/assets/cards/<category>/<card>.{jpg,jpeg,png}` | GET | Card thumbnail/scan image | Category tiles, and MindAR's own compiler tooling |
| `/assets/models/<category>/<card>.glb` | GET | 3D model for one card | `src/placement.js`, on first sighting of that card |
| `/assets/audios/<category>/<card>.{mp3,m4a,ogg,wav}` | GET | Spoken-name audio clip | `src/audio-player.js`, on first sighting of that card |

**Authentication:** none. Whatever is uploaded to the bucket is public. See
[08_Environment_Variables.md](08_Environment_Variables.md) and
[09_Deployment_Guide.md](09_Deployment_Guide.md) for why the CORS policy on
the bucket must allow `GET`/`HEAD` from any origin, and why the
`*-original/` print-master folders must never be uploaded.

**Error handling:** every fetch in the app is wrapped to fail soft:

- `src/main.js`'s `loadManifest()` catches any fetch/parse error and sets
  `manifest = null`, which renders the "No Categories Found" screen rather
  than throwing.
- `src/placement.js`'s `loadPlacements()` returns `{}` on any failure, which
  simply means no cards get custom placement (they'd render at a default
  position/size) rather than crashing the AR session.
- Model loads that fail cause a "Model failed to load for `<card name>`"
  message in the AR view's status line (`src/ar-view.js`) rather than a
  frozen or blank camera.

## 2. Local receiver server (authoring tool only — never deployed)

`tools/receiver.mjs`, started with `npm run receiver`, listens on
`http://localhost:5999` and exists purely so the browser-based authoring
tools (`tools/compile-targets.html`, `tools/place-models.html`, and their
headless equivalents) have somewhere to write their output — a browser
script has no direct filesystem access, and `showDirectoryPicker()` needs a
human clicking through a dialog, which a scripted/automated run can't do.

This server:

- Only runs locally, only while a content maintainer is actively working on
  decks.
- Is never part of the deployed app and has no production equivalent.
- Has no authentication — it is meant to be reachable only from
  `localhost` and only accepts writes shaped exactly like MindAR/placement
  output.

### `POST /placements`

Overwrites `assets/placements.json` with the request body.

- **Request body:** raw JSON (the full placements object).
- **Behavior:** the body is parsed as JSON *before* anything is written, so
  a truncated or malformed request cannot corrupt the existing file.
- **Response:** `200 ok` on success; `500` with the error message in the
  body if the JSON fails to parse or the write fails.

### `POST /targets/<deck>.mind`

Writes a compiled MindAR target file to `assets/targets/<deck>.mind`.

- **Path parameter:** `<deck>` — must match the slug pattern
  `^[a-z0-9]+(-[a-z0-9]+)*$` (lowercase letters, digits, hyphens). Anything
  else is rejected with `400 bad deck name: <deck>`. This is the only
  validation standing between an HTTP request and a file write to disk, so
  it is deliberately strict.
- **Request body:** raw binary (the compiled `.mind` bytes).
- **Response:** `200 ok` on success.

### `OPTIONS *`

Answers any path with `204` and CORS headers
(`Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`), because the
authoring tool pages are served from a different port (`npm run tools`,
port 5174) than the receiver (port 5999), which makes every `POST` a
cross-origin request that the browser preflights.

### Everything else

Any other method or path returns `405 POST only` or `404 unknown path`.

## Third-party services this app talks to (not this project's own API)

- **Cloudflare R2** (or equivalent object storage/CDN) — the production home
  for the asset library. The app only ever issues `GET` requests to it; all
  writes go through `tools/upload-assets.mjs`, which shells out to `rclone`
  using credentials from environment variables (see
  [08_Environment_Variables.md](08_Environment_Variables.md)). This is not
  an API this project defines — it's a consumer of R2's own S3-compatible
  API via rclone.
- **Google Fonts** — `index.html` loads the "Fredoka" font from
  `fonts.googleapis.com` / `fonts.gstatic.com`. A pure external asset
  dependency, not an API this app calls with any logic.
