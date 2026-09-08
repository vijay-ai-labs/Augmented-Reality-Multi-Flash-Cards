// Deck/card search over the manifest. DOM-free on purpose: the only input is
// the parsed manifest, so this can be exercised from node
// (tools/check-search.mjs) without a browser.

// \p{M} = every combining mark, so NFD-decomposed accents drop out. Written as
// a property escape rather than a literal range to keep this file plain ASCII.
const COMBINING = /\p{M}/gu;
const NON_ALNUM = /[^a-z0-9]+/g;

// Collapse a display name to a comparable key: "Country Capitals Landmarks"
// and the "country-capitals-landmarks" slug both become "country capitals
// landmarks", and accented card names match their unaccented spelling.
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(COMBINING, '')
    .toLowerCase()
    .replace(NON_ALNUM, ' ')
    .trim();
}

export function buildSearchIndex(categories = []) {
  return categories.map((cat) => ({
    cat,
    nameKey: normalize(cat.name),
    cards: (cat.cards ?? []).map((card) => ({ card, nameKey: normalize(card.name) })),
  }));
}

const matchesAll = (key, terms) => terms.every((term) => key.includes(term));

/**
 * @returns {Array<{ cat: object, matchedCards: object[], reason: 'all'|'deck'|'card' }>}
 * Ranked: deck-name prefix hits, then deck-name substring hits, then decks
 * matched only through a card name. An empty query returns every deck.
 */
export function searchDecks(index, query) {
  const terms = normalize(query).split(' ').filter(Boolean);
  if (!terms.length) {
    return index.map((entry) => ({ cat: entry.cat, matchedCards: [], reason: 'all' }));
  }

  const ranked = [];
  for (const entry of index) {
    if (matchesAll(entry.nameKey, terms)) {
      // A deck matched by its own name lists no cards: the whole deck is the
      // hit, so naming a few of its cards would only be noise.
      ranked.push({
        cat: entry.cat,
        matchedCards: [],
        reason: 'deck',
        rank: entry.nameKey.startsWith(terms[0]) ? 0 : 1,
      });
      continue;
    }
    const matchedCards = entry.cards
      .filter((c) => matchesAll(c.nameKey, terms))
      .map((c) => c.card);
    if (matchedCards.length) {
      ranked.push({ cat: entry.cat, matchedCards, reason: 'card', rank: 2 });
    }
  }

  // Array.sort is stable, so decks keep manifest (alphabetical) order within a rank.
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map(({ cat, matchedCards, reason }) => ({ cat, matchedCards, reason }));
}
