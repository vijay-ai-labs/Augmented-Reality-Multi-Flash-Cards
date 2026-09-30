# Add `sweet-potato` to the vegetables deck

## Inputs

- `assets/cards-original/vegetables/sweet-potato.png` (1200x1801, flat vector art)
- `assets/models-original/vegetables/sweet-potato.glb` (15.7MB, 1 mesh, triangles, 3 JPEG textures, no spec/gloss)
- `assets/audios/vegetables/sweet-potato.mp3`

## Steps

1. Copy the card original into `assets/cards/vegetables/`, then `node tools/resize-cards.mjs vegetables`
   (fits inside 1200x1700 -> 1133x1700). The tool also re-derives every other card whose backup is oversized;
   the output is byte-identical, which was confirmed with `rclone check` against R2.
2. `npm run validate`: the manifest gains the card (54 in the deck).
3. `node tools/compress-models.mjs assets/models/vegetables/sweet-potato.glb`, then `npm run validate` again
   to stamp `?v=<hash>`. Check that the output has geometry.
4. Start `VITE_ASSET_BASE= npm run tools` and `npm run receiver`, then recompile all of `vegetables.mind`.
   Recompiling the whole deck is required: the new card sorts between `squash` and `tomato`, so every later
   anchor index shifts.
5. Solve the placement with `only: ['sweet-potato']`, then review the pose at full size. Hand-fix it if the
   solver is wrong (a high match score does not prove the placement is correct).
6. `npm run check`: record the card's features and tracking counts against the library median (191/21).

## Outcome

- Uploaded after review. On phones that had opened the deck before, the upload exposed a stale-target bug:
  `.mind` was served under a bare immutable URL, so those phones kept the 53-target file against the
  54-card manifest, and tomato showed Sweet Potato, wasabi showed Vidalia Onions, and so on. Fixed in
  a5fc9bb: target URLs now carry `?v=<hash>`, and upload refuses a stale hash. The bug was reproduced and
  the fix verified with a fake-camera run against production.
- `rclone sync` stripped Cache-Control from the byte-identical re-derived cards (a modtime-only server-side
  copy). They were re-uploaded with the header, and upload now passes `--no-update-modtime`.

## Known risk

The flat vector art may track poorly. If `check` shows low counts, that is a problem with the art, not the
pipeline: report it and do not try to fix it by recompiling.
