# Known issues and limitations

This page separates **deliberate, accepted tradeoffs** (don't "fix" these
without a product conversation) from **real gaps and technical debt** (worth
picking up). Where an item comes from project history/notes rather than
something directly visible in a single file, that's noted.

## Deliberate, accepted tradeoffs (not bugs)

### "Place Here" is a 3DOF illusion, not real AR tracking

There is no positional tracking anywhere in this app — no WebXR, no
ARKit/ARCore, no SLAM. "Place Here" works by reparenting the model out of
its camera-relative anchor into the scene root and counter-rotating its
*position* using only the phone's gyroscope
(`src/placement-manager.js`). This means:

- Rotating the phone in place (turning to look around) works well.
- **Walking a meaningful distance desyncs the illusion**, because
  translation is never compensated. This is the accepted tradeoff — fixing
  it would mean building real world tracking, which is exactly what this
  approach avoids.
- The compensation is exact for yaw with the phone held upright, but drifts
  slightly for off-axis tilt and landscape orientation, because the fully
  correct correction would need to be conjugated by the camera pose at the
  moment of placement (see the code comment in `src/placement-manager.js`
  for the derivation).
- Only one model can be placed at a time by design — supporting several at
  once would need one `PlacementManager` (with its own reference
  quaternion) per model, not the current shared instance.

**Do not propose SLAM/WebXR/positional correction as a fix for this** — it
was explicitly rejected in favor of the simpler gyroscope-only approach
during development.

### Recognition is scoped per category, not library-wide

MindAR compares each camera frame against every target loaded for the open
category. Loading the whole library (500+ cards) at once would make
detection slow and unreliable, so each category compiles to its own
`.mind` file and categories are recommended to stay under ~25 cards
(enforced only as a warning, not a hard limit — see `npm run check` and the
"Large Deck" tag in the UI).

### Blocked autoplay on first card sighting

Browsers refuse to autoplay audio until the page has seen a user gesture.
The first card's word may not play automatically; the speaker button is
always available as the fallback, and this is expected rather than a bug.

## Real gaps and technical debt

### No automated test suite

There is no unit/integration/end-to-end test tooling in this repository.
"Testing" today is a set of purpose-built verification scripts
(`npm run validate`/`check`/`check:search`/`check:cdn`) plus manual phone
testing — see [10_Testing_Guide.md](10_Testing_Guide.md). This is a real
gap for a future maintainer to weigh, not a design decision.

### `locked` in `placements.json` is not actually enforced

`assets/placements.json` supports a `locked: true` flag on a card, meant to
signal "don't overwrite this hand-tuned placement." In practice,
`tools/solve-headless.js`'s `run()` overwrites every key it touches
(`yaw` included) regardless of `locked` — the flag is written but never
read back as a guard. The only real protection is passing `only`/`skip`
arguments to exclude specific cards from a re-solve run. A future
improvement would be to make the solver actually respect `locked` (or
rename/remove the field if it's meant to stay purely informational).

### High solver "match" scores can still be wrong ("the solver match-score trap")

The placement solver's `match` score measures how well the 3D model's
silhouette overlaps *whatever the print mask detected* — not whether the
mask found the actual printed subject. Concretely observed during content
work: the `month` deck solved at a mean match of 0.90 with **every card
wrong**, because its calendar art is white-on-white, so the mask only ever
picked up the red header bar, and the solver happily matched a 3D word
model edge-on to that bar. `universe` and `yoga` showed the same pattern,
latching onto caption ribbons at 0.68–0.89.

**Takeaway for anyone tuning placements:** always look at the solved *box*
after a solve, not just the score. A box that's a thin strip, sits low on
the card (`y > 0.62`), or covers under roughly 6% of the card area has
almost always locked onto a caption, a title, or one bright fragment
instead of the subject. See [14_Admin_Guide.md](14_Admin_Guide.md).

### Some cards cannot be tracked, and this is an art problem, not a code bug

As of the last full library check, a portion of cards score below the
tracking thresholds in `npm run check` and will realistically never be
recognized reliably — for example, plain flat-color number cards and
simple line-art-on-solid-background cards. **Recompiling does not fix
this.** The only fix is re-authoring that card's artwork with more visual
texture/detail (a photo or shaded illustration instead of a flat
silhouette). This is documented behavior of the underlying detector, not a
defect in this project's code — see the "Cards that cannot track" section
of the project README and [14_Admin_Guide.md](14_Admin_Guide.md).

### Cold-cache first load can be slow on mobile data

The largest compiled target and the largest model in the library are each
several MB to tens of MB. A first-ever open of a large category can mean
tens of MB downloaded before anything appears on screen — a blank camera
view on a slow connection. The CDN's immutable cache header makes the
*second* open instant, but there is currently no loading-progress indicator
for that first download. See the deploy design notes for measured numbers.

### `r2.dev` (the free Cloudflare public URL) throttles under bursts

Measured directly during this project's rollout: a full verification sweep
at high concurrency drew hundreds of HTTP 429 responses against a bucket
that was actually complete. `npm run check:cdn` retries these with
backoff, but it's a real constraint of the free public URL — moving to a
custom domain removes the rate limit and adds full CDN edge caching. Not
yet done as of the last deployment notes.

### Landscape orientation and off-axis tilt drift slightly during placement

Noted directly in `src/placement-manager.js`'s own comments: the yaw
compensation used for "Place Here" is mathematically exact only for the
phone held upright. Off-axis tilt and landscape orientation introduce a
small, accepted drift, because a fully correct correction would need to be
conjugated by the camera's pose at the moment of placement.

### No progress/loading indicator for the first model download of a session

`src/ar-view.js` shows a simple "Loading model..." badge, but there's no
percentage or size indicator — on a slow connection a large model can leave
that badge up for a noticeably long time with no further feedback.

<!-- prettier-ignore -->
> [!NOTE]
> Assumption: the items above are drawn from code comments, the README, and
> the project's own working notes as of the documentation snapshot date.
> Some (like exact "how many cards are untrackable") will drift as content
> changes — re-run `npm run check` for current numbers rather than trusting
> the figures here indefinitely.
