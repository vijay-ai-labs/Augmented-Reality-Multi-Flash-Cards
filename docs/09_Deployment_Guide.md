# Deployment guide

<!-- prettier-ignore -->
> [!NOTE]
> This page is the practical, step-by-step checklist. For the full reasoning,
> verification evidence, and the two real bugs found while building this
> pipeline, see the detailed engineering record at
> [docs/superpowers/specs/2026-09-09-vercel-r2-deploy-design.md](superpowers/specs/2026-09-09-vercel-r2-deploy-design.md).
> This guide summarizes it; that file is the source of truth for exact
> numbers and history.

## Why deployment has two halves

`dist/` (the built app) is a few MB. The asset library (`assets/`) is
several hundred MB of runtime data (card images, models, audio, compiled
targets) plus several GB more of local-only print masters that must never
ship anywhere. Neither GitHub nor a typical static-app host is a sensible
place for that much data, so deployment is split:

| Half | Goes to | Size (approx., at last recorded upload) |
| --- | --- | --- |
| The app | A static host, built from GitHub (Vercel used here; Netlify/Cloudflare Pages also work — see `vercel.json`/`vite.config.js` for what's Vercel-specific vs. generic Vite) | ~3–4 MB |
| The asset library | Object storage / CDN (Cloudflare R2 used here) | ~800 MB across ~1,650 files |

`src/config.js` is the one file that joins them, via the
`VITE_ASSET_BASE` environment variable. Miss the second half and the
deployed app loads, opens the camera, and shows "No Categories Found" —
tracking quality itself is unaffected (it's baked into the `.mind` files);
only asset availability changes.

## One-time setup: the asset bucket

Do this once per environment (production, and again for staging if you use
one).

1. **Create the bucket.** Cloudflare account → R2 → add a payment method
   (required even on the free tier) → create a bucket (default name in this
   repo: `ar-flashcards-assets`).
2. **Enable public access.** Bucket → Settings → Public Development URL →
   Enable. Copy the resulting URL (`https://pub-<32 hex chars>.r2.dev`).
   This is rate-limited and Cloudflare states it's not meant for production
   — fine to launch on, worth replacing with a custom domain later.
3. **Set the CORS policy.** Same Settings page → CORS Policy → Add:

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

   <!-- prettier-ignore -->
   > [!WARNING]
   > Skipping this step is the most common cause of "works locally, blank in
   > production" — every asset will serve fine to `curl` and fail silently in
   > the browser. The wildcard origin is deliberate here (the bucket is
   > already world-readable and the app's final domain isn't known yet);
   > tighten it to your real origin once you have a stable custom domain.

4. **Create an API token.** R2 → API → Manage API Tokens → Create →
   permission "Object Read & Write," scoped to this one bucket. Copy the
   Access Key ID and Secret Access Key immediately — the secret is shown
   once.
5. **Install rclone locally** (the upload tool shells out to it):
   `winget install Rclone.Rclone` on Windows, then open a new terminal so
   PATH picks it up.
6. **Fill in `.env`** from `.env.example` with `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, and
   `VITE_ASSET_BASE` set to the `r2.dev` URL from step 2. See
   [08_Environment_Variables.md](08_Environment_Variables.md) for what each
   one means.

## Every time you deploy a new/changed asset library

```bash
npm run upload -- --dry-run     # see what would transfer, without sending anything
npm run upload                  # do the real sync (resumable — reruns only sync what's missing/changed)
npm run check:cdn               # verify the live bucket before going further
```

Fix anything reported under "BROKEN" before continuing. Run
`npm run check:cdn -- --all` for a full sweep of every file (not just the
sampled subset) before a first launch.

`npm run upload` uses `rclone sync`, so deleting a deck locally deletes it
on the CDN too — this is intentional, since a stale target file on the CDN
would keep tracking cards the manifest no longer lists.

## Every time you deploy the app

1. **Commit and push.** Double-check `git status` shows `assets/` is not
   staged (it shouldn't be — `.gitignore` excludes it).

   ```bash
   git add -A
   git commit -m "…"
   git push
   ```

2. **Vercel build settings** come from `vercel.json` (framework `vite`,
   build command `npm run build`, output directory `dist`) — nothing extra
   to configure there if you're using Vercel's GitHub integration.
3. **Set `VITE_ASSET_BASE`** in the hosting provider's environment-variable
   settings to the CDN URL from the one-time setup above.
4. **Redeploy.** Vite inlines `VITE_ASSET_BASE` at build time — adding or
   changing the variable does nothing until the next build runs.
5. **Test on a real phone**, specifically iOS as well as Android: open the
   deployed URL, pick a deck, point at a printed card. The camera needs
   HTTPS (which Vercel provides) and a genuine user tap to start, which
   desktop testing won't surface.

## What ships where

| Directory | Ships in `dist/` (app host)? | Ships to the CDN bucket? |
| --- | --- | --- |
| `src/`, `index.html` | Yes (bundled) | No |
| `public/draco/` | Yes (copied as-is — must stay with the app; see below) | No |
| `assets/cards\|models\|targets\|audios` | No | Yes |
| `assets/manifest.json`, `assets/placements.json` | No | Yes |
| `assets/cards-original/`, `assets/models-original/` | No | **Never — anywhere** |

<!-- prettier-ignore -->
> [!IMPORTANT]
> `public/draco/` must ship with the app, not move to the CDN. Every model in
> the library is Draco-compressed, and `src/placement.js` points three.js's
> `DRACOLoader` at the local `/draco/` path. Moving it to the CDN breaks
> every model load while the manifest and tracking still look completely
> healthy — a confusing failure mode if you don't know to check this.

## Verifying a production build locally before pushing

`npm run build` only bundles the app. `npm run preview` serves that build
plus `assets/` from the project root (via middleware in `vite.config.js`),
which is the one local way to catch "the manifest/asset wiring is broken"
before it reaches a real deploy — the same failure a missing/misconfigured
`VITE_ASSET_BASE` would produce in production.

```bash
npm run build
npm run preview
```

## Rolling back

This app has no server-side state and no database, so a rollback is just a
code/asset rollback:

- **App rollback:** redeploy a previous build from your host's dashboard
  (Vercel keeps previous deployments), or revert the commit and push again.
- **Asset rollback:** there is no built-in versioning for the CDN bucket —
  `npm run upload` overwrites/deletes to match local `assets/`. If you need
  to roll back assets, restore the desired state locally (for example from
  a backup or an earlier git-tracked manifest, if you keep one) and run
  `npm run upload` again. Assumption/TODO: if bucket versioning matters for
  your operation, enable it in R2's own settings — this project does not
  currently rely on or document R2 object versioning.

## Known rough edges in production

See the "Known rough edges" section of
[docs/superpowers/specs/2026-09-09-vercel-r2-deploy-design.md](superpowers/specs/2026-09-09-vercel-r2-deploy-design.md)
for details (cold-cache first load being slow, `r2.dev` throttling under
bursts, and the checklist for adding a deck after the app is already live).
Also see [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).
