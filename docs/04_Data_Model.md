# Data model

There is no database in this project. All "data" is either a JSON file
served as a static asset, a compiled binary asset, or a small amount of
browser `localStorage`. This page documents each one as if it were a table —
its fields, its meaning, and how it relates to the others.

## Overview of data files

| File | Format | Written by | Read by |
| --- | --- | --- | --- |
| `assets/manifest.json` | JSON | `tools/validate-assets.mjs` (`npm run validate`) | `src/main.js`, `src/ar-view.js`, and the authoring tool pages |
| `assets/placements.json` | JSON | Hand-edited via `tools/place-models.html`, or written by `tools/solve-headless.js` / `tools/compile-headless.js` through `tools/receiver.mjs` | `src/placement.js` (used by both the AR runtime and the placement editor) |
| `assets/targets/<category>.mind` | Binary (MessagePack-encoded, MindAR's own format) | Compiled via `tools/compile-targets.html` or `tools/compile-headless.js` | MindAR, inside `src/ar-view.js` |
| `localStorage: ar-flashcards.transforms.v2` | JSON, browser-local | `src/transform-store.js` via `src/ar-view.js` | Same |

## `assets/manifest.json` — the card catalog

This is the closest thing this project has to a "database table of records."
It is regenerated in full every time `npm run validate` runs — it is never
hand-edited.

```json
{
  "generated": "2026-09-08T12:00:00.000Z",
  "categories": [
    {
      "id": "alphabets",
      "name": "Alphabets",
      "cards": [
        {
          "id": "a-apple",
          "name": "A Apple",
          "image": "assets/cards/alphabets/a-apple.png",
          "model": "assets/models/alphabets/a-apple.glb?v=3f9a1c07",
          "audio": "assets/audios/alphabets/a-apple.mp3?v=5d02e8b1",
          "w": 800,
          "h": 1200
        }
      ]
    }
  ]
}
```

### `categories[]` (a "deck")

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Folder-name slug (lowercase, digits, hyphens). Identifies the deck everywhere else — it is the key into `assets/targets/<id>.mind` and into `placements.json` (`<id>/*` and `<id>/<cardId>`). |
| `name` | string | Display name, derived automatically from `id` by title-casing on hyphens (a short list of `ACRONYMS` like `uk`, `us` stay upper-case). Not stored separately by a human — always derived from the folder name. |
| `cards[]` | array | The cards in this deck, sorted alphabetically by `id`. This order **must** match the order used when the deck's `.mind` file was compiled, because MindAR anchors are index-based, not name-based. |

### `cards[]` (one flashcard)

| Field | Type | Required? | Meaning |
| --- | --- | --- | --- |
| `id` | string | always | Slug, unique within its deck. Shared base name across the image/model/audio triplet (for example `red-panda`). |
| `name` | string | always | Display/spoken name, derived from `id` the same way as the deck name. |
| `image` | string (path) | always | Path to the card's flat scan/photo, relative to the project root — joined with `ASSET_BASE` at runtime by `src/config.js`. |
| `model` | string (URL path) | always | Path to the card's 3D model (`.glb`) plus `?v=<hash>`, the first 8 hex characters of the compressed file's sha256. Models are cached for a year as immutable, so the hash is what makes a replaced model load fresh. Not a file-system path: strip the query before using it as one. |
| `audio` | string (URL path) | optional | Path to the card's spoken-name clip plus `?v=<hash>` (first 8 hex characters of the file's sha256), for the same cache reason as `model`; strip the query before using it as a file-system path. **Absent, not null or empty string**, when no clip exists — the app checks for the field's presence to decide whether to enable the speaker button. |
| `w`, `h` | number | optional | Pixel dimensions of the source image, read from the file itself (PNG/JPEG headers) by the validator. Used by `tools/check-targets.mjs` to detect a stale `.mind` file (compiled from a different, since-replaced image) and by `src/placement.js` to compute the card's aspect ratio for scaling models. Falls back to a default aspect ratio (`DEFAULT_CARD_ASPECT = 1.4167`, roughly a 5x7 card) when absent. |

### Relationships

- A card's `id` is a foreign key of sorts into `placements.json`, formed as
  `"<categoryId>/<cardId>"`.
- A card's `image`/`model`/`audio` paths are relative references resolved at
  runtime by prefixing `ASSET_BASE` (`src/config.js`) — see
  [08_Environment_Variables.md](08_Environment_Variables.md).
- A card's position in `cards[]` (its index) is a foreign key into the
  compiled `.mind` file for that deck — the Nth card in the manifest must be
  the Nth target compiled into `assets/targets/<deck>.mind`.

## `assets/placements.json` — per-card 3D placement data

A flat JSON object. Keys are either a deck wildcard (`"<deck>/*"`, the
default for every card in that deck) or an exact card (`"<deck>/<cardId>"`,
overriding the wildcard for that one card). Exact match always wins over the
wildcard — see `placementFor()` in `src/placement.js`.

```json
{
  "animals/*": { "box": [0.17, 0.29, 0.64, 0.48] },
  "animals/lion": {
    "box": [0.178, 0.299, 0.625, 0.459],
    "orient": { "up": "+y", "heading": 26, "pitch": 0, "roll": 0 },
    "fit": "cover",
    "match": 0.72,
    "locked": true
  }
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `box` | `[x, y, w, h]`, 0–1 | The printed picture's bounding box on the card image, normalized with the origin at top-left. The model is centered on this box and scaled from it. |
| `orient.up` | one of `+x -x +y -y +z -z` | Which axis of the raw 3D model should be treated as "up," before any further rotation. Source `.glb` files have no shared convention, so this is authored per card. |
| `orient.heading` / `.pitch` / `.roll` | degrees | Additional rotation applied after `up` is corrected. `heading` is the turntable spin most often tuned. |
| `yaw` | degrees | **Legacy** equivalent of `orient.heading`, kept working for backward compatibility with the original 26 hand-tuned `alphabets` cards. New entries should use `orient`. |
| `fit` | `"cover"` (default) or `"contain"` | Whether the model is scaled to at least fill the box on both axes (`cover`) or to fit entirely inside it (`contain`). |
| `scale` | number | Extra multiplier applied on top of whatever `fit` computed. |
| `match` | number, 0–1 | The automatic solver's silhouette-matching confidence score for this placement. Informational only — it is used to sort the placement editor's card list worst-first for human review, and is not read by the AR runtime. |
| `locked` | boolean | A hint, set by a human or the solver, meaning "don't overwrite this by re-solving." **Not actually enforced** — `tools/solve-headless.js`'s `run()` will overwrite a locked card's data unless the caller explicitly excludes it with `only`/`skip`. See [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md). |

## `assets/targets/<category>.mind` — compiled image targets

A binary file, MessagePack-encoded, in MindAR's own internal format. Not
meant to be read or edited directly — always produced by MindAR's compiler,
either through the interactive page (`tools/compile-targets.html`) or the
headless driver (`tools/compile-headless.js`).

Structurally (as read by `tools/check-targets.mjs`), each file has:

- `v` — a format version number; the runtime expects `v === 2`.
- `dataList[]` — one entry per compiled card, in the order they were
  compiled, each holding:
  - `targetImage.width` / `.height` — pixel size of the source image used
    to compile that target, compared against the manifest's `w`/`h` to
    detect a stale `.mind` file.
  - `matchingData[]` — keypoint data at several image scales; the largest
    scale is what a live camera frame is matched against.
  - `trackingData[]` — keypoint data at smaller scales used for
    frame-to-frame tracking once a card is found; specifically level `1`
    (128px), which is the entire basis of tracking continuity.

## Browser `localStorage` — remembered model transforms

Key: `ar-flashcards.transforms.v2` (see `src/ar-view.js`,
`TRANSFORM_STORE_KEY`). The `v2` suffix exists because the meaning of the
stored numbers changed when models moved from lying flat on the card to
standing upright in the card plane — old `v1` data described a pose that no
longer exists, so the key was bumped rather than reinterpreted.

Managed generically by `src/transform-store.js`, which is a small key/value
wrapper, not a real database:

```json
{
  "animals/lion": { "yaw": 0.4, "tilt": -0.1, "scale": 1.2, "offsetX": 0.05, "offsetY": -0.02 }
}
```

| Field | Meaning |
| --- | --- |
| `yaw` | User-applied rotation around the model's vertical axis (radians). |
| `tilt` | User-applied rotation tipping the model toward/away from the viewer (radians). |
| `scale` | User-applied size multiplier, clamped between `MIN_SCALE` (0.45) and `MAX_SCALE` (2.5). |
| `offsetX` / `offsetY` | User-applied position offset within the card plane (card-width units), clamped to `MAX_OFFSET` (0.75). |

This store degrades to memory-only (no error, no persistence) if
`localStorage` is unavailable — private browsing, blocked cookies, or a
corrupt payload all fall back safely.

<!-- prettier-ignore -->
> [!NOTE]
> There is a second, similarly-shaped store key mentioned in
> `src/transform-store.js`'s own comments for "pinned size/heading" state,
> described as deliberately using a different key than the card-plane
> transforms. At the time of writing, `src/ar-view.js` does not appear to
> call `createStore()` a second time for this — Assumption: this second use
> is either not yet wired up or was superseded by `src/placement-manager.js`,
> which keeps its own placement state in memory rather than `localStorage`.
> Treat this as a TODO to verify against the code if you need to rely on it.
