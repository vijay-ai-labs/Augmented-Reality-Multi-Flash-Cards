# Testing guide

<!-- prettier-ignore -->
> [!NOTE]
> This project has **no automated unit/integration test suite** (no Jest,
> Vitest, Playwright, etc. configured) and no CI test workflow in the repo at
> the time of writing. "Testing" here means the purpose-built verification
> scripts under `tools/`, plus manual checks on a real phone. This is a real
> gap, not a deliberate choice — see
> [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).

## What automated checks exist, and what they actually verify

These are not unit tests in the conventional sense — each is a standalone
script that inspects real data (the manifest, the compiled targets, the live
CDN) and reports problems. Run them after any change that touches assets,
the pipeline, or deployment config.

| Command | Verifies | Exit code |
| --- | --- | --- |
| `npm run validate` | Every card has a matching image + model, names follow the slug rule, images/models/audio are correctly paired. Refuses to write a manifest if there are errors — a broken manifest never ships. | Non-zero on error |
| `npm run check` | Whether each compiled card actually has enough visual detail for MindAR to find and hold it (see below). Also flags decks over 25 cards. | Non-zero if any `.mind` file is stale/misaligned |
| `npm run check:search` | The deck/card search ranking logic (`src/deck-search.js`) behaves as expected against representative queries. | Non-zero on failure |
| `npm run check:cdn` | A deployed CDN bucket has every expected file, with correct byte size, CORS header, cache header, and content type — and that the private `*-original/` folders are not publicly reachable. | Non-zero if anything is BROKEN |

### Why `npm run check` matters (and what "tracking quality" means here)

Nothing else in the pipeline can tell you whether a card will actually be
recognized by the camera. `npm run validate` only checks file names and
sizes; the MindAR compiler reports success as long as it produced a file —
even for card art that is one flat shape and can never be matched. `npm run
check` reads the compiled `.mind` file directly and reports two numbers per
card:

- **features** — keypoints in the full-scale matching keyframe (what a live
  camera frame is compared against). Too few and the card is rarely
  recognized at all.
- **tracking** — points in the 128px tracking keyframe, the entire basis of
  frame-to-frame tracking once a card is found. Single digits here means
  the card is found and immediately lost — it looks like flicker, not
  failure.

**Low counts are a property of the card artwork, not of the compile step.**
Recompiling a flat-color or plain-text card will not fix it — the fix is
re-arting it with more visual texture/detail. See
[14_Admin_Guide.md](14_Admin_Guide.md) for the thresholds and how to
interpret a whole deck scoring low.

## Manual testing checklist

Use this before merging any change that touches `src/`, `tools/`,
`vite.config.js`, or the deployment configuration. Test on a real phone —
desktop browsers can start a webcam but won't surface iOS-specific quirks
(autoplay, motion-permission prompts) or realistic card-scanning conditions.

### Golden path

- [ ] Home screen loads and shows the category grid with correct thumbnails
      and card counts.
- [ ] Search filters the grid live, by both deck name and card name, with
      correct result counts and an empty-state message when nothing matches.
- [ ] Tapping a category starts the camera (accepting the permission
      prompt).
- [ ] Pointing at a printed card from that category shows the correct 3D
      model, correctly oriented on the card.
- [ ] The card's name is spoken automatically on first sighting (or the
      speaker button plays it, if autoplay was blocked).
- [ ] Drag rotates the model; pinch resizes it (within limits); press-and-
      hold then drag moves it; a clean tap on the model replays the audio.
- [ ] **Reset** restores the model's rotation/scale/position.
- [ ] **Place Here** detaches the model into the room; turning the phone in
      place keeps it visually anchored. **Return to Card** puts it back
      exactly as it was.
- [ ] Losing the card from view (with nothing placed) returns to "Point at
      one card" and stops the audio.
- [ ] **Back** returns to the category grid and stops the camera cleanly (no
      leftover camera indicator, no console errors).

### Edge cases worth checking after a relevant change

- [ ] Deny camera permission → a specific, readable error message appears
      (not a blank screen).
- [ ] Open the app over plain HTTP (or otherwise not a secure context) → the
      camera-blocked error message appears.
- [ ] Two cards from the same deck in view at once → the second one does not
      steal audio/focus away unexpectedly (check the intended behavior in
      `src/ar-view.js`'s `onTargetFound`/placement-aware logic).
- [ ] A card with no audio clip → its speaker button stays visibly disabled,
      never silently tappable.
- [ ] Revisit a card you previously rotated/resized → the previous transform
      is remembered (until Reset).
- [ ] iOS specifically: the "Place Here" motion-permission prompt appears
      and, if denied, the UI cleanly reverts (no stuck loading state).
- [ ] A deck with more than 25 cards → still functions, though recognition
      may be visibly slower; confirm it's flagged "Large Deck" in the grid.
- [ ] Rotate the phone to landscape mid-session → nothing crashes (this is a
      documented area of imprecision for "Place Here," not necessarily a
      bug — see
      [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md)).

### After any asset/content change specifically

- [ ] `npm run validate` passes with no errors.
- [ ] `npm run check` shows no new WILL-NOT-TRACK entries for the changed
      deck(s).
- [ ] If deploying, `npm run check:cdn` passes after `npm run upload`.

## Testing on a phone

Camera access requires HTTPS. Options, in order of convenience:

1. Use the HTTPS LAN URL `npm run dev` prints, and accept the local
   certificate warning on the phone.
2. Tunnel to your laptop: `npx localtunnel --port 5173`, ngrok, or
   Cloudflare Tunnel.
3. Test against a draft/staging deployment (see
   [09_Deployment_Guide.md](09_Deployment_Guide.md)).

## What is explicitly not covered by any current test

- No automated check that a model's visual orientation matches the printed
  card — that judgment is made by a human reviewing the placement editor's
  "Match view" (see [14_Admin_Guide.md](14_Admin_Guide.md)) and by manual
  phone testing.
- No automated UI/interaction tests (gesture handling, button states) — all
  manual, per the checklist above.
- No load/performance testing beyond the informal "keep decks under ~25
  cards" guidance baked into `npm run check`'s output and
  `src/main.js`'s "Large Deck" warning.
- No accessibility testing beyond what's implemented in the markup (ARIA
  labels/live regions are present in `src/main.js` and `src/ar-view.js`,
  but there is no automated audit).
