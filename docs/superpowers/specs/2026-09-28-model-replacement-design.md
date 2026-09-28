# Replacing wrong and damaged models — design

Date: 2026-09-28
Status: approved, not implemented

## Problem

Some cards ship the wrong 3D model, and some models are damaged. The user has
correct replacement `.glb` files with the same names as the cards they belong
to, and will list the affected cards (`deck/card`) in chat. The old models are
already live on Cloudflare R2.

Four things in the current pipeline make a naive "overwrite the file and
re-upload" fail:

1. **Compress reads the backup, not the file you dropped in.**
   `tools/compress-models.mjs` copies a model into `assets/models-original/`
   only if no backup exists yet, then always compresses *from* the backup. A new
   file placed in `assets/models/` gets overwritten by the old model when
   compress runs.
2. **Placements belong to the old model.** `assets/placements.json` keeps a
   per-card `orient` / `yaw` / `box`, most with `locked: true`. The solver and
   the editor both keep locked entries, so a new model would inherit a pose
   tuned for a different mesh.
3. **Models are cached as immutable for a year.** `tools/upload-assets.mjs`
   uploads models with `public, max-age=31536000, immutable`, and
   `modelUrl()` in `src/config.js` builds the URL from the bare filename. Phones
   and the Cloudflare edge that already hold the old model never ask for the
   new one. Changing the header does not fix this for clients that have
   already cached it; only a changed URL does.
4. **Saved poses on each device** (localStorage, keyed by card) will apply a
   kid's old rotation and size to the new model. Accepted: the Reset button
   covers this, so it is out of scope.

## Decisions

| Question | Decision |
|---|---|
| Which cards | User supplies the list; no library-wide detection. |
| Where new files go | Raw source overwrites `assets/models-original/<deck>/<card>.glb`, same name. |
| Placement | Clear the per-card entries, re-run the headless solver, user reviews every card in the editor. |
| Cache busting | Content hash in the manifest URL (`?v=<hash>`). Rejected: renaming files (breaks the card/model pairing by slug) and shortening the cache header (does not reach clients that already cached the file). |
| Resetting saved poses | Not done (YAGNI). |
| Health check | One-off script in the scratchpad, not a repo tool. |

## Code change

**`tools/validate-assets.mjs`** is the only source file that changes.

When building each card entry, read `assets/models/<cat>/<file>`, take the
first 8 hex characters of its sha256, and emit:

```json
"model": "assets/models/<cat>/<file>?v=<hash8>"
```

Every model gets a hash, not only the replaced ones, so any later swap busts the
cache without extra steps.

Nothing that reads `card.model` opens it as a file on disk, so the query string
needs no changes elsewhere:

- `src/config.js` `modelUrl()` puts it in the URL: correct.
- `src/placement.js` `gltfCache` uses it as a key: a new version gets a new key.
- `tools/check-cdn.mjs` fetches it: R2 ignores the query when serving the object.
- `tools/place-models.html` and the headless solver load it through Vite, which
  serves static files and ignores the query.

Because the hash is taken from the **compressed** file, validate has to run
after compress. The pipeline order changes from `validate → compress` to
`validate → compress → validate`: the first run catches naming errors, the
second writes the hashes.

**Docs:** update the README pipeline section and `docs/` (asset pipeline,
troubleshooting) with the new order, plus the rule: *replace a model in
`models-original/`, never in `models/`.*

## Workflow for each replacement batch

1. **User:** posts the list of `deck/card` and copies each new raw `.glb` over
   `assets/models-original/<deck>/<card>.glb`.
2. **Health check (scratchpad script):** for each new file, read the GLB header
   and JSON chunk. Flag any file that is not a binary glTF, has no meshes, or
   references a missing texture or buffer. Report spec/gloss use as
   information only; compress already converts it.
3. **Compress only the listed models:**
   `node tools/compress-models.mjs assets/models/<deck>/<card>.glb ...`
4. **Clear placement:** remove each listed card's `"<deck>/<card>"` key from
   `assets/placements.json`. Leave the deck's `"<deck>/*"` entry and every other
   card alone.
5. **Solve:** run `npm run tools` and `npm run receiver`, then the headless
   solver for the affected decks. Only the cleared cards may change. Check each
   solved box's *shape* against the card art, not only its match score (a high
   match does not mean correct placement). Then the user reviews each replaced
   card in `/tools/place-models.html` and fixes any by hand.
6. **Validate:** `npm run validate` writes the manifest with the new hashes.
7. **Upload:** `npm run upload -- models`, then `npm run upload -- --json`.
8. **Verify:** `npm run check:cdn`, then open a replaced card on a phone that
   previously loaded the old model and confirm the new one appears.

Cards and `.mind` targets do not change, so there is no target recompile.

## One-time cost

The first upload after the validate change gives all 541 model URLs a new
value. Each phone re-downloads a model once, the next time it opens that card,
and caches it again under the immutable header.

## Testing

- After validate: every `model` field in `manifest.json` ends in `?v=` plus 8 hex
  characters. Run validate twice with no changes: the hashes stay the same.
  Re-compress one model: only its hash changes.
- `git diff`-style comparison of `placements.json` before and after solving:
  only the listed keys differ.
- In the dev app: each replaced card loads its new model, textured and facing
  the right way.
- On the CDN: `check:cdn` passes, and a phone with a warm cache shows the new
  model.

## Out of scope

- Detecting wrong or damaged models across the whole library.
- Resetting saved poses on each device.
- Cache-busting cards, audio or targets.
