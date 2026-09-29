import { MANIFEST_URL, imageUrl } from './config.js';
import { getPronunciationPlayer } from './audio-player.js';
import { buildSearchIndex, searchDecks } from './deck-search.js';

const screen = document.getElementById('screen');
const title = document.getElementById('title');
const backBtn = document.getElementById('back-btn');

const MAX_MATCH_NAMES = 3;

let manifest = null;
let searchIndex = [];
let activeAR = null; // { stop } handle returned by ar-view
let starting = null; // token for the in-flight startAR() call, if any

// Survives a trip into AR and back: the common flow is "wrong deck, try the
// next hit", so retyping the query on every Back would be busywork.
let searchQuery = '';

// Rebuilt by showCategories(); filtering only toggles these, never re-creates
// them, so thumbnails are not re-fetched and the pop-in stagger fires once.
let tileNodes = [];
let searchUI = null; // { input, clearBtn, status, empty }

async function loadManifest() {
  try {
    // Always revalidate. The manifest is the index that points at every model
    // (by ?v= hash), so a device holding a stale copy keeps loading the old
    // models no matter what is on the CDN. Headers alone cannot be trusted to
    // prevent that: an object uploaded without Cache-Control gets heuristic
    // browser caching (~10% of its age — days, for a weeks-old file). A 304
    // costs a few hundred bytes.
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch {
    manifest = null;
  }
  searchIndex = buildSearchIndex(manifest?.categories ?? []);
}

function renderSearchBar() {
  const form = document.createElement('form');
  form.className = 'deck-search';
  form.setAttribute('role', 'search');
  // Filtering is live, so submitting (mobile "search" key) has nothing to do
  // beyond dismissing the keyboard.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    input.blur();
  });

  const label = document.createElement('label');
  label.className = 'visually-hidden';
  label.htmlFor = 'deck-search-input';
  label.textContent = 'Search Decks or Cards';

  const field = document.createElement('div');
  field.className = 'deck-search-field';

  const icon = document.createElement('span');
  icon.className = 'deck-search-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none"
      stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
    <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.4 15.4 21 21" />
  </svg>`;

  const input = document.createElement('input');
  input.id = 'deck-search-input';
  input.type = 'search';
  input.placeholder = 'Search decks or cards...';
  input.value = searchQuery;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('enterkeyhint', 'search');
  input.setAttribute('aria-describedby', 'deck-search-status');
  // No autofocus: kids should land on the picture grid, not a keyboard that
  // covers two thirds of it.

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'deck-search-clear';
  clearBtn.setAttribute('aria-label', 'Clear Search');
  clearBtn.textContent = '✕';

  const status = document.createElement('p');
  status.className = 'deck-search-status';
  status.id = 'deck-search-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  input.addEventListener('input', () => {
    searchQuery = input.value;
    applyFilter();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault(); // keep Safari from also clearing via its native affordance
      clearSearch();
    }
  });
  clearBtn.addEventListener('click', () => clearSearch());

  field.append(icon, input, clearBtn);
  form.append(label, field, status);
  searchUI = { input, clearBtn, status, empty: null };
  return form;
}

function clearSearch() {
  searchQuery = '';
  if (searchUI) {
    searchUI.input.value = '';
    searchUI.input.focus();
  }
  applyFilter();
}

function renderTile(cat, i) {
  const tile = document.createElement('button');
  tile.className = 'category-tile';
  tile.style.setProperty('--d', `${Math.min(i * 45, 900)}ms`);
  tile.setAttribute('aria-label', `Open ${cat.name}, ${cat.cards.length} cards`);

  const thumb = document.createElement('span');
  thumb.className = 'tile-thumb';
  if (cat.cards.length) {
    const img = document.createElement('img');
    img.src = imageUrl(cat.cards[0]);
    img.alt = '';
    img.width = 96;
    img.height = 136;
    img.loading = 'lazy';
    thumb.appendChild(img);
  } else {
    thumb.textContent = cat.name.slice(0, 1).toUpperCase();
  }

  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = cat.name;

  const count = document.createElement('small');
  count.textContent = `${cat.cards.length} Cards`;

  // Filled in by applyFilter() when this deck was reached through a card name.
  const matches = document.createElement('span');
  matches.className = 'tile-matches';
  matches.hidden = true;

  tile.append(thumb, name, count, matches);
  if (cat.cards.length > 25) {
    const warning = document.createElement('span');
    warning.className = 'tile-warning';
    warning.textContent = 'Large Deck';
    tile.appendChild(warning);
  }

  tile.addEventListener('click', () => {
    // Synchronously, inside the tap: this is the only user gesture that
    // happens before a marker is found, so it is the one chance to let iOS
    // mark the shared Audio element as user-activated. Without it the very
    // first card's auto-play is always blocked.
    getPronunciationPlayer().unlock();
    openCategory(cat);
  });

  return { cat, el: tile, matchesEl: matches };
}

function matchSummary(cards) {
  const names = cards.slice(0, MAX_MATCH_NAMES).map((c) => c.name);
  const extra = cards.length - names.length;
  return names.join(' · ') + (extra > 0 ? ` +${extra} more` : '');
}

function applyFilter() {
  if (!searchUI) return;
  const results = searchDecks(searchIndex, searchQuery);
  const byId = new Map(results.map((r, order) => [r.cat.id, { ...r, order }]));

  tileNodes.forEach(({ cat, el, matchesEl }) => {
    const hit = byId.get(cat.id);
    // `hidden` (not display:none) so filtered-out decks leave the a11y tree.
    el.hidden = !hit;
    if (!hit) return;
    // Grid order follows result rank; DOM order stays alphabetical.
    el.style.order = String(hit.order);
    if (hit.matchedCards.length) {
      matchesEl.textContent = matchSummary(hit.matchedCards);
      matchesEl.hidden = false;
    } else {
      matchesEl.textContent = '';
      matchesEl.hidden = true;
    }
  });

  const trimmed = searchQuery.trim();
  searchUI.clearBtn.hidden = !trimmed;
  searchUI.status.textContent = trimmed
    ? `${results.length} ${results.length === 1 ? 'deck matches' : 'decks match'} "${trimmed}"`
    : '';
  if (searchUI.empty) {
    searchUI.empty.hidden = !(trimmed && results.length === 0);
    searchUI.empty.querySelector('.deck-search-empty-query').textContent = trimmed;
  }
}

function renderEmptyState() {
  const empty = document.createElement('section');
  empty.className = 'notice deck-search-empty';
  empty.hidden = true;
  empty.innerHTML = `
    <h2>No Decks Match "<span class="deck-search-empty-query"></span>"</h2>
    <p>Try part of a deck name, or the name of a card inside it.</p>
  `;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'deck-search-reset';
  reset.textContent = 'Show All Decks';
  reset.addEventListener('click', () => clearSearch());
  empty.appendChild(reset);
  return empty;
}

function showCategories() {
  title.textContent = 'AR Flashcards';
  backBtn.hidden = true;
  tileNodes = [];
  searchUI = null;

  if (!manifest || !manifest.categories?.length) {
    screen.innerHTML = `<section class="notice" role="status">
      <h2>No Categories Found</h2>
      <p>
        Drop card images into <code>assets/cards/&lt;category&gt;/</code> and models into
        <code>assets/models/&lt;category&gt;/</code>, then run <code>npm run validate</code>.
      </p>
    </section>`;
    return;
  }

  const totalCards = manifest.categories.reduce((sum, cat) => sum + cat.cards.length, 0);
  const shell = document.createElement('div');
  shell.className = 'home-shell';

  const intro = document.createElement('section');
  intro.className = 'scanner-panel';
  intro.innerHTML = `
    <div>
      <p class="eyebrow">Real-Time Image Tracking</p>
      <h2>Pick a deck, scan a card, and bring the model onto the page.</h2>
      <p class="panel-copy">Use good light, keep the card flat, and fill the camera view with one flashcard.</p>
    </div>
    <dl class="deck-stats" aria-label="Library Stats">
      <div><dt>${manifest.categories.length}</dt><dd>Decks</dd></div>
      <div><dt>${totalCards}</dt><dd>Cards</dd></div>
    </dl>
  `;

  const searchBar = renderSearchBar();

  const grid = document.createElement('div');
  grid.className = 'category-grid';
  tileNodes = manifest.categories.map((cat, i) => renderTile(cat, i));
  grid.append(...tileNodes.map((t) => t.el));

  const empty = renderEmptyState();
  searchUI.empty = empty;

  shell.append(intro, searchBar, grid, empty);
  screen.replaceChildren(shell);
  applyFilter();
}

async function openCategory(category) {
  title.textContent = category.name;
  backBtn.hidden = false;
  screen.innerHTML = `<section class="notice" role="status" aria-live="polite">
    <div class="loader"></div>
    <h2>Starting Camera...</h2>
    <p>Allow camera access when the browser asks.</p>
  </section>`;

  // Claimed BEFORE the dynamic import, not after. ar-view.js is a ~2.7MB chunk
  // and on a phone that download is long enough to press Back in. With the
  // token taken afterwards, a Back during the import cancelled nothing --
  // `starting` was still null, so this call happily adopted the screen the
  // picker had just rendered and left the user in AR with no Back button.
  const token = (starting = {});
  const { startAR } = await import('./ar-view.js');
  if (starting !== token) return;

  let ar;
  try {
    ar = await startAR(screen, category);
  } catch (err) {
    if (starting === token) {
      starting = null;
      screen.innerHTML = `<section class="notice error" role="alert">
        <h2>Could Not Start AR</h2>
        <p>${err?.message ?? 'Camera failed to start.'}</p>
        <p>Check camera permission and confirm <code>assets/targets/${category.id}.mind</code> exists.</p>
      </section>`;
    } else if (starting === null && !activeAR) {
      // Cancelled, and startAR's own failure cleanup emptied the screen it had
      // already claimed. Same restore as the success-after-Back path below.
      showCategories();
    }
    return;
  }
  if (starting !== token) {
    // Back was pressed while the camera was still starting: tear this one
    // down instead of handing back a live camera nothing will ever stop.
    await ar.stop();
    // startAR() takes over #screen before it awaits the camera, so a Back that
    // landed in that window has already had its picker wiped out and stop()
    // then leaves the screen blank. Re-render it -- unless another deck is
    // already opening, which owns the screen now.
    if (starting === null && !activeAR) showCategories();
    return;
  }
  starting = null;
  activeAR = ar;
}

backBtn.addEventListener('click', async () => {
  starting = null; // cancel any in-flight startAR()
  if (activeAR) {
    await activeAR.stop();
    activeAR = null;
  }
  showCategories();
});

loadManifest().then(showCategories);
