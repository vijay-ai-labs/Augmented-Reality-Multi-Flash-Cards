# Deploying to Vercel with the asset library on Cloudflare R2

Date: 2026-09-09
Status: implemented in the repo, awaiting the manual account steps below

## The problem

`dist/` is 3.4 MB. `assets/` is 6.7 GB, of which ~822 MB is runtime data the app
actually needs. Neither GitHub nor a Vercel deployment can carry the library, and
`.gitignore` has always excluded it on purpose.

So a deploy is two halves:

| Half | Where | Size |
| --- | --- | --- |
| The app | Vercel, from GitHub | 3.4 MB |
| The library | Cloudflare R2, public bucket | ~822 MB |

`src/config.js` joins them. It is the only file in `src/` that builds an asset
URL, so one variable moves the whole library.

Miss the second half and the deployed app loads, opens the camera, and shows
"No Categories Found". Tracking quality itself does not change: it is baked into
the `.mind` files and does not degrade over a network. What changes is latency.

## Runtime library, by directory

| Directory | Size | Files |
| --- | --- | --- |
| models | 348 MB | 541 |
| targets | 232 MB | 30 |
| cards | 220 MB | 541 |
| audios | 32 MB | 541 |

Never uploaded: `cards-original/` (182 MB) and `models-original/` (5.7 GB). Print
masters, local only.

## What changed in the repo

**Restored `.gitignore` and `.gitattributes`.** Both were deleted in the working
tree. Without them a commit would have staged 6.7 GB of assets and 480 MB of
`node_modules`, and hit GitHub's 100 MB per-file limit on
`assets/models-original/seasons/autumn.glb` at 98 MB. `.gitattributes` also marks
`.glb`, `.mind` and image extensions as binary, which stops Windows CRLF
conversion from corrupting them.

**`src/config.js` reads `VITE_ASSET_BASE`.** Defaults to an empty string, which
means same origin, so `npm run dev` and `npm run preview` are unchanged. Any
trailing slash is stripped, because R2 treats `//assets/...` as a different key
and returns 404 where most servers would forgive it.

Vite inlines this at build time. Setting the variable in Vercel without
redeploying changes nothing.

**`.env.example`.** Documents `VITE_ASSET_BASE` plus the four R2 credentials.
`.gitignore` already ignored `.env` and already carved out `!.env.example`.

**`tools/upload-assets.mjs`, as `npm run upload`.** Syncs the four runtime
directories to R2 with rclone, one directory at a time. They are named
explicitly rather than filtered, so the print masters are never in the source
path and no filter bug can publish them. Long-lived assets get
`Cache-Control: public, max-age=31536000, immutable`; the two JSON files get a
60-second TTL and are uploaded last, so the index never points at files that are
not there yet. Credentials reach rclone through `RCLONE_CONFIG_*` environment
variables, not argv, keeping the secret out of the process list.

**`tools/check-cdn.mjs`, as `npm run check:cdn`.** Verifies the live bucket over
the network before you deploy. All 30 targets are checked, never sampled, since
a missing one kills a whole deck. Cards, models and audio are sampled at first,
middle and last card per deck, or all of them with `--all`. Uses HEAD, so
checking 232 MB of targets costs no bandwidth.

It checks status, exact byte length against the local file, the CORS header, the
cache header, and content type. It also probes for `models-original/` and
`cards-original/` and fails loudly if either is public.

**`vercel.json`.** Pins the Vite preset, build command and output directory, and
caches `/draco/` for a year. The Draco decoder is 192 KB of wasm fetched every AR
session and it never changes.

## Verified

- Build with `VITE_ASSET_BASE=https://cdn.example.com/` inlines the base and
  strips the slash at runtime.
- Build with the variable unset produces an empty base, so dev and preview are
  untouched.
- `upload-assets` preflight refuses to run without `.env` and without rclone.
- Upload ran against the real bucket: 1653 asset files plus the two JSON, 0.86 GB,
  about two minutes, exit 0.
- `npm run check:cdn -- --all` then checked all 1655 files across 30 decks:
  0 broken, 0 warnings, 0 rate limited. Every file matched its local byte count,
  carried the CORS header and the cache header, and neither `models-original/`
  nor `cards-original/` is reachable.

### Two bugs found by running it

**`shell: true` broke argument passing on Windows.** The project path contains a
space (`Ar-Multi Flascards`) and so do the `Cache-Control` values, and node
concatenates argv into one string without quoting when a shell is used. rclone
received six arguments where it wanted two. The script now resolves the absolute
path to `rclone.exe` once, through a shell, then spawns without one.

**`check-cdn` reported throttling as missing files.** The first full sweep at
concurrency 12 produced 884 reports of "not uploaded" against a bucket that was
complete. All of them were HTTP 429 from `r2.dev`. The checker now retries 429
and 5xx with jittered backoff, drops concurrency to 6, and counts a surviving 429
separately from a real failure, since a throttled response says nothing about
whether the file exists.

## Manual steps

### 1. Cloudflare account and bucket

Sign up, open R2, add a payment method. The 10 GB free tier still requires one.
Create a bucket named `ar-flashcards-assets`. If you pick another name, put it in
`.env` as `R2_BUCKET`.

### 2. Enable public access

Bucket, then Settings, then Public Development URL, then Enable. Copy the URL. It
looks like `https://pub-<32 hex chars>.r2.dev`.

Cloudflare rate-limits this URL and states it is not for production. It is fine
to launch on and worth replacing with a custom domain later.

### 3. CORS policy

Same Settings page, CORS Policy, Add. Paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

The wildcard origin is deliberate. You do not know the Vercel URL yet, and an
`r2.dev` bucket is world-readable regardless, so a wildcard gives away nothing a
locked policy would protect. Tighten it to the real origin once you have a custom
domain.

Skip this step and every asset serves perfectly to curl and not at all to the
browser. It is the most common cause of a deploy that works locally and is blank
in production.

### 4. API token

R2, then API, then Manage API Tokens, then Create. Permission "Object Read &
Write", scoped to this one bucket. Copy the Access Key ID and the Secret Access
Key. The secret is shown once.

### 5. Install rclone

```
winget install Rclone.Rclone
```

Open a new terminal afterwards so PATH picks it up.

### 6. Fill in `.env`

```
Copy-Item .env.example .env
```

Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and
`VITE_ASSET_BASE` to the `r2.dev` URL from step 2.

Leaving `VITE_ASSET_BASE` set locally is fine. It only affects `npm run build`,
and `npm run dev` continues to serve assets from the project root.

### 7. Upload

```
npm run upload -- --dry-run
npm run upload
```

The dry run prints the file counts and sizes per directory and transfers
nothing. The real run moves ~822 MB across ~1,650 files, so expect a while on a
home connection. It is resumable: rerunning syncs only what is missing.

### 8. Verify before deploying

```
npm run check:cdn
```

Fix everything under BROKEN before continuing. Optionally run `npm run check:cdn -- --all`
once for a full sweep of all 1,650 files.

### 9. Push

```
git add -A
git commit -m "Add R2 asset pipeline and CDN verification for Vercel deploy"
git push
```

Check `git status` first and confirm `assets/` is not listed.

### 10. Vercel

Import `vijay-ai-labs/Augmented-Reality-Multi-Flash-Cards`. The settings come
from `vercel.json`. Add an environment variable `VITE_ASSET_BASE` set to the
`r2.dev` URL, then redeploy, since adding a variable does not rebuild.

### 11. Test on a real phone

Open the Vercel URL, pick a deck, point at a card. Test on iOS specifically. The
camera needs HTTPS, which Vercel provides, and needs a user gesture to start,
which desktop testing will not surface.

## Known rough edges

**First open is slow on a cold cache.** `alphabets.mind` is 26 MB and the largest
model, `assets/models/seasons/autumn.glb`, is 8.5 MB. A first category open can
be 30 MB before anything appears, which is a blank camera on mobile data. The
immutable cache header makes the second open instant. A loading indicator would
help and is not built.

**`public/draco/` must stay with the app.** Every model is Draco-compressed and
`src/placement.js` points the decoder at a local path. Moving it to the CDN
breaks every model while the manifest and tracking still look healthy.

**Content type on `.glb` and `.mind`.** rclone maps unknown extensions to
`application/octet-stream`. Three.js and MindAR do not inspect content type, so
this is correct in practice. `check-cdn` reports it as a warning, not an error.

**`r2.dev` throttles under bursts.** Measured, not theoretical: 1653 HEAD
requests at concurrency 12 drew 884 HTTP 429s. Children opening one deck at a
time will rarely trigger it, and a deck's files are fetched over seconds rather
than all at once. It is still the strongest argument for moving to a custom
domain, which is not rate limited and gets full Cloudflare edge caching.

**Adding a deck later** means `npm run validate`, recompile targets,
`npm run check`, then `npm run upload` and `npm run check:cdn` again. The
manifest has a 60-second TTL, so a new deck appears within a minute.
