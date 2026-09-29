# Local setup guide

This guide gets the app running on your own machine so you can browse the
existing decks in AR and make code changes. If you also need to add or edit
flashcard decks (new artwork/models/audio), read
[14_Admin_Guide.md](14_Admin_Guide.md) after finishing this page.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js | Any recent LTS version. `package.json` uses ES modules (`"type": "module"`) throughout. |
| npm | Ships with Node. |
| A phone (optional but recommended) | To actually test AR — a laptop webcam can start the camera, but pointing it at a printed flashcard is awkward. See the phone-testing section below. |

<!-- prettier-ignore -->
> [!NOTE]
> This project's `package.json` sets `"overrides": { "canvas": "npm:empty-npm-package@1.0.0" }`.
> `mind-ar` depends on the `canvas` npm package for Node-side (server) image
> compiling, which this project never does — that native module fails to
> build on some machines (noted in project history: Node 24 on Windows), so
> it's stubbed out. You do not need to install any native build tools for
> `canvas`.

## Step 1: Get the code and install dependencies

```bash
git clone <this repository's URL>
cd "Ar-Multi Flascards"
npm install
```

## Step 2: Get the asset library

The app needs `assets/manifest.json` and the `assets/cards|models|targets|audios`
folders to show anything — without them it will run but display
"No Categories Found." `assets/` is intentionally not committed to git (it's
several hundred MB to several GB), so you need it from one of these sources:

- **You already have the asset library** (for example, copied from another
  machine, or downloaded from the team's storage): place it at the project
  root as `assets/`, matching the layout in
  [06_Folder_Structure.md](06_Folder_Structure.md).
- **You're starting from scratch / adding your own decks**: follow the
  full pipeline in [14_Admin_Guide.md](14_Admin_Guide.md) — drop in card
  images, models, and audio, then run `npm run validate`, `npm run compress`,
  and compile targets.
- **You want to point at an already-deployed asset library** (a CDN bucket
  someone else uploaded to): set `VITE_ASSET_BASE` in `.env` to that URL
  instead of keeping a local copy — see
  [08_Environment_Variables.md](08_Environment_Variables.md).

## Step 3: Set up your `.env` file

For local development against a **local** asset library (Step 2's first two
options), you don't need to create `.env` at all — leave `VITE_ASSET_BASE`
unset and the dev server serves `assets/` from the project root
automatically.

If you're pointing at an already-deployed CDN, or if you plan to upload
assets to R2 yourself later:

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Then fill in whichever variables you need — see
[08_Environment_Variables.md](08_Environment_Variables.md) for what each one
does.

## Step 4: Start the dev server

```bash
npm run dev
```

This starts Vite on `https://localhost:5173` (note: **HTTPS**, required for
camera access — see below). Open that URL in your browser; you should see
the category grid.

<!-- prettier-ignore -->
> [!IMPORTANT]
> The dev server uses a self-signed HTTPS certificate
> (`@vitejs/plugin-basic-ssl`). Your browser will show a certificate
> warning on first load — this is expected for local development. Accept it
> (on Chrome, "Advanced" → "Proceed to localhost").

## Step 5: Test on a real phone (recommended)

A laptop's built-in camera can technically start an AR session, but you'll
want a phone pointed at an actual printed card. Camera access requires
HTTPS, so pick one of these:

- **Same Wi-Fi network:** `npm run dev` prints a `https://<your-LAN-IP>:5173`
  URL alongside the localhost one. Open that on your phone and accept the
  same certificate warning.
- **Tunnel to your laptop:** `npx localtunnel --port 5173`, or use ngrok or
  Cloudflare Tunnel, if your phone isn't on the same network.
- **A draft deployment:** push to a staging environment — see
  [09_Deployment_Guide.md](09_Deployment_Guide.md).

You'll also need the card printed (or shown on a second screen at a decent
size) — see [13_User_Guide.md](13_User_Guide.md) for tips on what tracks
well.

## Step 6: Verify a production build locally (optional but useful)

`npm run build` only bundles the app — it does **not** include `assets/`.
Testing the actual production output requires the preview server, which has
middleware that serves `assets/` from the project root the same way `dev`
does:

```bash
npm run build
npm run preview
```

`npm run preview -- --host` if you need it reachable from your phone too
(this is HTTP, not HTTPS, so the camera will not start over LAN this way —
it's mainly useful for confirming the manifest/asset wiring works, not for
testing AR itself).

## Everyday commands reference

| Command | What it does |
| --- | --- |
| `npm run dev` | HTTPS dev server for the app, with hot reload. |
| `npm run build` | Production build into `dist/`. |
| `npm run preview` | Serves the production build, plus local `assets/`, for a realistic local check. |
| `npm run validate` | Regenerates `assets/manifest.json` from what's on disk in `assets/cards|models|audios`. |
| `npm run check` | Reports which compiled cards are unlikely to track well. |
| `npm run check:search` | Sanity-checks the deck/card search logic. |
| `npm run check:cdn` | Verifies a deployed CDN bucket (requires `.env` filled in). |
| `npm run compress` | Draco-compresses and shrinks 3D models. |
| `npm run upload` | Syncs assets to Cloudflare R2 (requires `.env` and `rclone`). |
| `npm run tools` | Plain-HTTP dev server (port 5174) for the content-authoring tool pages. |
| `npm run receiver` | Local write-back server (port 5999) the tool pages save through. |

## Troubleshooting a fresh setup

See [11_Troubleshooting.md](11_Troubleshooting.md) for solutions to the most
common first-run problems: "No Categories Found," camera not starting, and
certificate warnings.
