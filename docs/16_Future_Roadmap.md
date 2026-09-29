# Future roadmap

This page lists logical next steps and known-unfinished work, grouped by
area. None of this is a committed plan — it's a starting point for
prioritization, drawn from gaps identified elsewhere in this documentation
set and from the project's own working notes. Cross-references point to
where each item is discussed in more depth.

## Near-term, low-risk improvements

- **Move off the free `r2.dev` public URL to a custom domain.** Removes the
  rate-limiting observed during rollout (hundreds of throttled requests
  under a full verification sweep) and gains full Cloudflare edge caching.
  See [09_Deployment_Guide.md](09_Deployment_Guide.md) and
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).
- **Add a loading-progress indicator for the first model/target download of
  a session.** Today's "Loading model..." badge has no percentage or size
  feedback, which is most noticeable on a slow connection opening a large
  category for the first time.
- **Make the placement solver actually respect the `locked` flag** in
  `assets/placements.json`, instead of it being purely informational. Right
  now, protecting hand-tuned cards from an accidental re-solve depends
  entirely on remembering to pass `only`/`skip` — see
  [12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md).
- **Re-art the remaining untrackable cards.** A known set of cards (flat
  color number cards, simple line-art-on-solid-background cards) score
  below reliable tracking thresholds. This is content work, not code work
  — see [14_Admin_Guide.md](14_Admin_Guide.md).

## Testing and quality

- **Add automated tests.** There is currently no unit/integration/E2E test
  suite. Good starting candidates, since they're already pure and
  DOM-free: `src/deck-search.js` (search ranking) and `src/placement.js`
  (placement/orientation math) — both are structured for exactly this kind
  of testing already, since `tools/check-search.mjs` exercises the former
  from Node without a browser.
- **Automate more of the manual QA checklist** in
  [10_Testing_Guide.md](10_Testing_Guide.md) — for example, a scripted
  smoke test that drives the app in a headless browser through "open a
  category, confirm the manifest and target load without error" would
  catch a large class of deployment misconfiguration automatically.
- **Consider CI.** No CI workflow currently runs `npm run validate` or
  `npm run check` automatically; wiring these into a pull-request check
  would catch broken decks before they're merged, rather than during manual
  content review.

## Content pipeline

- **Grow toward the originally planned ~300-card, ~30-category scale (and
  beyond) evenly** — as of the last inventory the library has 30
  categories and 541 cards, already past the original card-count estimate;
  worth revisiting deck-size guidance (currently ~25 cards/category) as the
  library keeps growing.
- **Split any deck that grows past the ~25-card recognition-quality
  guideline** rather than letting it slide — `npm run check`'s "crowded
  decks" report already flags this, but nothing currently blocks a merge
  or upload over it.
- **Bucket versioning / asset rollback strategy.** Deployment currently has
  no documented way to roll back a bad asset upload other than restoring
  local files and re-running `npm run upload` (see
  [09_Deployment_Guide.md](09_Deployment_Guide.md)) — enabling and
  documenting R2 object versioning would close this gap.

## Product ideas (not yet scoped)

<!-- prettier-ignore -->
> [!NOTE]
> These are plausible directions suggested by the current feature set, not
> commitments — flag them to the person setting priorities before starting
> work on any of them.

- A way for a parent/teacher to curate a shorter "favorites" subset of
  cards within a large deck, addressing the recognition-quality tradeoff of
  big categories without splitting content.
- Basic session feedback for the content maintainer — for example, which
  cards get scanned most/least — without adding any account system or
  personal-data collection (this app deliberately has neither today; see
  [02_Requirements.md](02_Requirements.md)).
- An in-app way to preview "how a card looks in AR" without needing a
  printed card physically in hand, useful for remote content review.

## Explicitly out of scope (based on documented product decisions)

These were considered and deliberately rejected — don't re-propose them
without understanding why first (see
[12_Known_Issues_and_Limitations.md](12_Known_Issues_and_Limitations.md)):

- **Real positional AR (WebXR/ARKit/ARCore/SLAM)** for "Place Here." The
  gyroscope-only illusion was chosen deliberately over an earlier
  WebXR-plus-fallback prototype.
- **Loading the entire card library into one MindAR target set.** The
  category-scoped approach exists specifically because MindAR's detection
  degrades with too many simultaneous targets.
