// Headless driver for the placement solver.
//
// tools/place-models.html is the interactive version: pick a deck, hit "Solve
// deck", review worst-first, save. This module runs the same solve loop with no
// UI so a browser-automation agent can do the mechanical part, leaving a human
// only the review:
//
//   const m = await import('/tools/solve-headless.js');
//   m.run(['scientist', 'currency']);      // do not await -- poll instead
//   window.__solve                         // { state, deck, card, i, n, results, errors }
//
// It reuses the exact helpers the editor uses (printMask / solveOrientation
// from ./orient-solver.js, loadModelScene from ../src/placement.js) with the
// editor's own defaults -- mask threshold 42, box taken from the printed
// subject, the same 12% padded search box -- so a card solved here lands where
// the editor would have put it.
//
// Existing placements for every deck are loaded first and written back
// untouched; only the solved cards' keys change. Within a deck, `only` / `skip`
// narrow that further -- see run().

import { loadModelScene, loadPlacements } from '../src/placement.js';
import { createSilhouetteRenderer, printMask, solveOrientation } from './orient-solver.js';

const RECEIVER = 'http://localhost:5999';
const MASK_THRESHOLD = 42;
const DEFAULT_BOX = [0.1, 0.1, 0.8, 0.8];

// Same padding the editor applies: a box that clips the art would otherwise cap
// the measured bounds at its own wrong edge.
function searchBox(box) {
  const [x, y, w, h] = box;
  const px = w * 0.12;
  const py = h * 0.12;
  const nx = Math.max(0, x - px);
  const ny = Math.max(0, y - py);
  return [nx, ny, Math.min(1 - nx, w + px * 2), Math.min(1 - ny, h + py * 2)];
}

// Re-solves a deck across a grid of mask thresholds and search boxes and
// reports the mean match for each, without writing anything. Low scores are
// usually the mask picking up something that is not the subject -- a caption
// ribbon, a border, the deck's title text -- so the fix is a tighter box or a
// higher threshold, not a different model. Use this to find which, then pass
// the winner to run().
export async function sweep(deckId, { thresholds = [42], boxes = [null] } = {}) {
  const manifest = await (await fetch('/assets/manifest.json')).json();
  const placements = await loadPlacements();
  const deck = manifest.categories.find((c) => c.id === deckId);
  if (!deck) throw new Error(`${deckId} not in manifest`);

  const wildcard = placements[`${deckId}/*`]?.box ?? DEFAULT_BOX;
  const rows = [];
  let silhouettes = null;

  for (const threshold of thresholds) {
    for (const boxOverride of boxes) {
      const base = boxOverride ?? wildcard;
      const matches = [];
      let failed = 0;

      for (const target of deck.cards) {
        try {
          const print = await printMask(target, searchBox(base), threshold);
          if (print.empty) { failed++; continue; }
          if (!silhouettes) silhouettes = createSilhouetteRenderer();
          const { scene } = await loadModelScene(target);
          silhouettes.setModel(scene);
          matches.push(solveOrientation(silhouettes, print).match);
        } catch {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 0));
      }

      const mean = matches.reduce((s, x) => s + x, 0) / (matches.length || 1);
      const worst = matches.length ? Math.min(...matches) : 0;
      rows.push({
        threshold,
        box: base.map((v) => +v.toFixed(3)),
        n: matches.length,
        failed,
        mean: +mean.toFixed(3),
        worst: +worst.toFixed(3)
      });
      window.__sweep = rows;
    }
  }

  return rows;
}

// `tuning` is an optional per-deck { threshold, box } found with sweep(). A box
// given here also replaces that deck's "<deck>/*" wildcard, so the editor and
// any later solve start from the same corrected default.
//
// `only` / `skip` limit the solve to some of a deck's cards, by card id. A deck
// that already carries hand-tuned placements would otherwise lose them: every
// key this module solves is overwritten, `yaw` included, and the `locked` flag
// it writes is never read back as a guard.
export async function run(deckIds, tuning = {}, { only, skip } = {}) {
  const state = {
    state: 'running',
    deck: null,
    card: null,
    i: 0,
    n: 0,
    results: [],
    errors: []
  };
  window.__solve = state;

  try {
    const manifest = await (await fetch('/assets/manifest.json')).json();
    const placements = await loadPlacements();
    const onlySet = only && new Set(only);
    const skipSet = skip && new Set(skip);
    let silhouettes = null;

    for (const id of deckIds) {
      const deck = manifest.categories.find((c) => c.id === id);
      if (!deck) {
        state.errors.push(`${id}: not in manifest`);
        continue;
      }

      const cards = deck.cards.filter(
        (c) => (!onlySet || onlySet.has(c.id)) && (!skipSet || !skipSet.has(c.id))
      );

      state.deck = id;
      state.n = cards.length;

      const tune = tuning[id] ?? {};
      const threshold = tune.threshold ?? MASK_THRESHOLD;
      if (tune.box) {
        placements[`${id}/*`] = { ...(placements[`${id}/*`] ?? {}), box: tune.box };
      }

      for (let i = 0; i < cards.length; i++) {
        const target = cards[i];
        state.i = i + 1;
        state.card = target.id;
        const key = `${id}/${target.id}`;

        try {
          const entry = placements[key] ?? placements[`${id}/*`] ?? {};
          // A tuned box wins over the card's stored one: after an earlier solve
          // every card carries a box measured through the *old* mask, so reusing
          // it here would re-inherit the very error the tuning corrects.
          const box = tune.box
            ?? (Array.isArray(entry.box) && entry.box.length === 4 ? entry.box : DEFAULT_BOX);
          const print = await printMask(target, searchBox(box), threshold);
          if (print.empty) throw new Error('printed subject not found');

          if (!silhouettes) silhouettes = createSilhouetteRenderer();
          const { scene } = await loadModelScene(target);
          silhouettes.setModel(scene);
          const { orient, match } = solveOrientation(silhouettes, print);

          const next = { ...entry, orient, match, locked: true, box: print.bounds };
          delete next.yaw;
          placements[key] = next;
          state.results.push({ card: key, match: Number(match.toFixed(3)) });
        } catch (err) {
          state.errors.push(`${key}: ${err.message}`);
        }

        // Yield so a long deck cannot starve the event loop that serves polls.
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Same key sort the editor's save uses: groups by deck, floats "<deck>/*".
    const sorted = Object.fromEntries(
      Object.keys(placements).sort().map((k) => [k, placements[k]])
    );
    const post = await fetch(`${RECEIVER}/placements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sorted, null, 2)
    });
    if (!post.ok) throw new Error(`receiver HTTP ${post.status}`);

    state.deck = null;
    state.card = null;
    state.state = 'finished';
  } catch (err) {
    state.state = 'failed';
    state.errors.push(err.message);
  }

  return state;
}
