# Environment variables

All environment variables are defined in [.env.example](../.env.example),
which you copy to `.env` for local use. `.env` is git-ignored; `.env.example`
is committed and must never contain real secret values — only placeholders
and explanatory comments.

<!-- prettier-ignore -->
> [!WARNING]
> Never commit `.env`, and never paste real R2 credentials into `.env.example`,
> a commit message, an issue, or a chat log. If a secret is ever committed,
> rotate it (create a new API token and delete the old one in the Cloudflare
> dashboard) rather than relying on removing it from history.

## Summary table

| Variable | Required? | Used by | Reaches the browser? |
| --- | --- | --- | --- |
| `VITE_ASSET_BASE` | Only for a production build / pointing at a remote CDN | The app (`src/config.js`) | **Yes** — inlined into the built JS |
| `R2_ACCOUNT_ID` | Only for `npm run upload` | `tools/upload-assets.mjs` | No |
| `R2_ACCESS_KEY_ID` | Only for `npm run upload` | `tools/upload-assets.mjs` | No |
| `R2_SECRET_ACCESS_KEY` | Only for `npm run upload` | `tools/upload-assets.mjs` | No |
| `R2_BUCKET` | Only for `npm run upload` (has a default) | `tools/upload-assets.mjs` | No |

Nothing here is required for plain local development — `npm run dev` and
`npm run preview` serve `assets/` straight from the project root when
`VITE_ASSET_BASE` is empty/unset, and the R2 variables only matter when
you're actually uploading to or checking a Cloudflare bucket.

## `VITE_ASSET_BASE`

**Purpose:** The public base URL the app fetches all card images, models,
audio, targets, and the manifest/placements JSON from.

**Example value:** `https://pub-abc123def456abc123def456abc123de.r2.dev`
(no trailing path, no trailing slash — see below).

**How it's used:** Read in `src/config.js` via
`import.meta.env.VITE_ASSET_BASE`, defaulting to `''` (empty string) when
unset, which means "same origin as the app" — exactly what local dev and
`npm run preview` want, since both serve `assets/` from the project root.
Every asset URL in the app is built by joining this base with a path like
`/assets/manifest.json`.

**Where to get it:** The public URL of your Cloudflare R2 bucket (or
equivalent static host/CDN), created following
[09_Deployment_Guide.md](09_Deployment_Guide.md).

**Important behavior notes:**

- Any trailing slash is stripped automatically by `src/config.js` — the
  bucket at `https://cdn.example.com/` and `https://cdn.example.com` behave
  identically in the app. This matters because some servers (including R2)
  treat a doubled slash (`//assets/...`) as a completely different, missing
  key and return 404, where a more forgiving server would have just ignored
  the duplicate slash.
- **Must have no trailing path** — the bucket must hold the literal
  `assets/` folder at its root, because `assets/manifest.json` stores paths
  like `assets/models/<deck>/<card>.glb` and this variable is joined onto
  them unchanged.
- **Vite inlines this at build time, not at runtime.** Setting or changing
  the variable in your hosting provider's dashboard does nothing to an
  already-built deploy — you must trigger a new build/redeploy for it to
  take effect. This trips people up because it looks like a normal runtime
  config variable but behaves like a compile-time constant.
- Leave it empty (or don't set `.env` at all) for local development.

## `R2_ACCOUNT_ID`

**Purpose:** Your Cloudflare account ID, needed by `rclone` to reach the
correct R2 endpoint.

**Where to get it:** The R2 page of the Cloudflare dashboard.

**Reaches the browser?** No — read only by the Node script
`tools/upload-assets.mjs`, which runs on your machine (or CI), never in the
browser. Vite only exposes variables prefixed `VITE_` to client code, which
is exactly why this one is intentionally unprefixed.

## `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`

**Purpose:** R2 API token credentials with read/write access to the asset
bucket, used by `rclone` (via `tools/upload-assets.mjs`) to sync files.

**Where to get it:** Cloudflare dashboard → R2 → API → Manage API Tokens →
Create, with permission "Object Read & Write," scoped to just this one
bucket (least-privilege — don't grant account-wide access). The secret is
shown once at creation time and never again; if you lose it, revoke the
token and create a new one.

**Reaches the browser?** No. `tools/upload-assets.mjs` passes these to
`rclone` through `RCLONE_CONFIG_*` environment variables rather than as
command-line arguments, specifically so the secret never appears in the
process list (visible to other processes/users on a shared machine).

<!-- prettier-ignore -->
> [!WARNING]
> Scope this token to exactly one bucket. If it leaks, the blast radius is
> "someone can read/write this one asset bucket," not your whole Cloudflare
> account.

## `R2_BUCKET`

**Purpose:** The name of the R2 bucket to upload to and check.

**Default:** `ar-flashcards-assets` (set in `.env.example`; change it if you
created the bucket under a different name).

**Reaches the browser?** No.

## How to obtain each credential — quick reference

1. Sign up for Cloudflare, add a payment method (required even for the free
   tier), open R2, create a bucket.
2. Bucket → Settings → Public Development URL → Enable. This is your
   `VITE_ASSET_BASE`.
3. Bucket → Settings → CORS Policy → add a policy allowing `GET`/`HEAD` from
   any origin (see [09_Deployment_Guide.md](09_Deployment_Guide.md) for the
   exact JSON — skipping this step is, per the deploy design notes, "the
   most common cause of a deploy that works locally and is blank in
   production").
4. R2 → API → Manage API Tokens → Create, with "Object Read & Write" scoped
   to the bucket. This gives you `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY`.
5. Your `R2_ACCOUNT_ID` is shown on the main R2 dashboard page.

## Setting variables per environment

| Environment | How |
| --- | --- |
| Local development | `.env` file at the project root, loaded automatically by Vite/Node. Leave `VITE_ASSET_BASE` empty. |
| Local upload/check (`npm run upload`, `npm run check:cdn`) | Same `.env` file, with the R2 variables filled in. |
| Production build (Vercel or similar) | Set `VITE_ASSET_BASE` in the hosting provider's environment-variable settings, then trigger a redeploy. The R2 variables are **not** needed here — the production app only ever reads assets, it never uploads them. |
