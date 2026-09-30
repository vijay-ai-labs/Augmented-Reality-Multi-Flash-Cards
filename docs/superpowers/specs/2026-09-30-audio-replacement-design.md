# Replacing wrong audio clips — design

Date: 2026-09-30
Status: approved

## Problem

Some cards shipped with the wrong pronunciation clip. The user has already
overwritten them in place, same names, in `assets/audios/`:

- `national-birds-animals/emu`
- `monuments/konark-sun-temple`, `monuments/mysore-palace`
- `colors/red-car`
- every clip in `fruits` (27), `space` (10), `universe` (10), `cars` (20)

71 clips in all. The old clips are live on Cloudflare R2.

Audio has no `-original/` folder and no processing step, so the file on disk is
the file that ships. The one thing that makes "overwrite and re-upload" fail is
caching: `tools/upload-assets.mjs` uploads audio with
`public, max-age=31536000, immutable`, and the manifest's `audio` field is the
bare file path. A phone (or the Cloudflare edge) that already holds a wrong clip
never asks for the new one. Only a changed URL reaches it.

## Decisions

| Question | Decision |
|---|---|
| Cache busting | Content hash in the manifest URL (`?v=<hash8>`), same as models (2026-09-28 spec). Rejected: renaming files (breaks card/clip pairing by slug) and purging the CDN (does not reach browser caches holding an immutable response). |
| Which clips get a hash | All of them, so any later swap busts the cache with no extra step. |
| Listening review page | Not built. User already paired clips by hand; spot-check in the app. |
| Health check | One-off script in the scratchpad, not a repo tool. |

## Code change

**`tools/validate-assets.mjs`** only. The card entry's `audio` field becomes:

```json
"audio": "assets/audios/<cat>/<file>?v=<hash8>"
```

using the existing `contentHash()` (first 8 hex characters of sha256).

Nothing reads `card.audio` as a file on disk, so the query string needs no
changes elsewhere:

- `src/config.js` `audioUrl()` prefixes `ASSET_BASE`: correct.
- `src/audio-player.js` compares full paths, so a new hash is a new clip.
- `tools/check-cdn.mjs` fetches the URL; R2 ignores the query.
- The Vite dev/tools servers serve static files and ignore the query.

## Workflow

1. **Health check** (scratchpad): each of the 71 files has an ID3 tag or MPEG
   frame sync, non-trivial size, and a plausible duration.
2. **Confirm scope:** `rclone check` local `assets/audios` against R2 — exactly
   the 71 listed clips differ.
3. **Validate:** `npm run validate` writes the manifest with audio hashes.
4. **Upload:** `npm run upload -- audios`, then `npm run upload -- --json`
   (JSON last, so the manifest never points at clips not yet uploaded).
5. **Verify:** `npm run check:cdn`; re-run the `rclone check` — zero
   differences; play a replaced card on a phone that had the old clip.

Cards, models, targets and placements do not change.

Found while running step 2: the new `universe` clip arrived as
`red-gaint-star.mp3` while the card is `red-giant-star`. Renamed before
validate; otherwise the card would have lost audio and the sync would have
deleted the live `red-giant-star.mp3`.

## One-time cost

The first upload after this change gives all 541 audio URLs a new value. Each
phone re-downloads a clip once, the next time it plays it (~30 MB for the whole
library).

## Testing

- Every `audio` field in `manifest.json` ends in `?v=` plus 8 hex characters.
- Validate twice with no changes: hashes identical.
- `rclone check` before upload lists exactly the 71 clips; after upload, none.

## Out of scope

- Loudness normalization.
- Checking each clip says the right word (speech-to-text).
- Finding wrong clips among the other 470.
- Cache-busting card images or targets.
