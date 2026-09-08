// Headless driver for MindAR target compilation.
//
// tools/compile-targets.html is the interactive version: it needs a human to
// pick a folder and tick checkboxes. This module does the same compilation with
// no UI, so a browser-automation agent can run it and poll progress:
//
//   const m = await import('/tools/compile-headless.js');
//   m.run(['scientist', 'currency']);          // do not await -- poll instead
//   window.__headless                          // { state, deck, progress, done, errors }
//
// It POSTs each finished .mind to a small local receiver rather than
// downloading it, because a headless page has nowhere to put a download.
// Card order comes from assets/manifest.json, exactly as the interactive page
// does -- MindAR anchors are index-based, so this must match what the app loads.

import { Compiler } from 'mind-ar/dist/mindar-image.prod.js';
import { loadCardImage } from './load-card-image.js';

const RECEIVER = 'http://localhost:5999';

// Reads back the compiled .mind files and checks each holds exactly as many
// targets as its deck has cards. Anchors are index-based, so a target count
// that disagrees with the manifest means every card in that deck points at the
// wrong model -- a failure that is invisible until someone scans a card.
export async function verify(deckIds) {
  const manifest = await (await fetch('/assets/manifest.json')).json();
  const rows = [];

  for (const id of deckIds) {
    const cat = manifest.categories.find((c) => c.id === id);
    if (!cat) {
      rows.push({ deck: id, ok: false, note: 'not in manifest' });
      continue;
    }
    try {
      const res = await fetch(`/assets/targets/${id}.mind`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      const compiler = new Compiler();
      const data = compiler.importData(buffer);
      const targets = data?.length ?? data?.dataList?.length ?? null;
      rows.push({
        deck: id,
        cards: cat.cards.length,
        targets,
        mb: +(buffer.byteLength / 1e6).toFixed(1),
        ok: targets === cat.cards.length
      });
    } catch (err) {
      rows.push({ deck: id, ok: false, note: err.message });
    }
  }

  window.__verify = rows;
  return rows;
}

export async function run(deckIds) {
  const state = {
    state: 'running',
    deck: null,
    progress: 0,
    done: [],
    errors: [],
    log: []
  };
  window.__headless = state;

  try {
    const res = await fetch('/assets/manifest.json');
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    const manifest = await res.json();

    for (const id of deckIds) {
      const cat = manifest.categories.find((c) => c.id === id);
      if (!cat) {
        state.errors.push(`${id}: not in manifest`);
        continue;
      }

      state.deck = id;
      state.progress = 0;
      const started = Date.now();

      try {
        const images = await Promise.all(cat.cards.map((c) => loadCardImage(c.image)));
        const compiler = new Compiler();
        await compiler.compileImageTargets(images, (p) => { state.progress = p; });
        const buffer = await compiler.exportData();

        const post = await fetch(`${RECEIVER}/targets/${id}.mind`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buffer
        });
        if (!post.ok) throw new Error(`receiver HTTP ${post.status}`);

        const seconds = ((Date.now() - started) / 1000).toFixed(0);
        state.done.push(id);
        state.log.push(`${id}: ${cat.cards.length} cards, ${(buffer.byteLength / 1e6).toFixed(1)}MB, ${seconds}s`);
      } catch (err) {
        state.errors.push(`${id}: ${err.message}`);
        state.log.push(`${id}: FAILED ${err.message}`);
      }
    }

    state.deck = null;
    state.state = 'finished';
  } catch (err) {
    state.state = 'failed';
    state.errors.push(err.message);
  }

  return state;
}
