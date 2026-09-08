// Exercises src/deck-search.js against the real manifest: npm run check:search
//
// Why this exists: the search module is the one piece of app logic that is
// pure and DOM-free, so it is the one piece that can be checked without a
// browser and a camera. The cases below are written against the shipped
// library (30 decks, 541 cards) and assert the behaviours that are easy to
// regress by "tidying" the matcher -- slug/display-name equivalence, the
// deck-before-card ranking, and multi-term AND.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchIndex, searchDecks, normalize } from '../src/deck-search.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'assets', 'manifest.json'), 'utf8'));
const index = buildSearchIndex(manifest.categories);

let failures = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

const ids = (query) => searchDecks(index, query).map((r) => r.cat.id);
const reasons = (query) => searchDecks(index, query).map((r) => `${r.cat.id}:${r.reason}`);

console.log('normalize');
check('slug and display name agree', normalize('country-capitals-landmarks'), normalize('Country Capitals Landmarks'));
check('accents are folded', normalize('Pokémon'), 'pokemon');
check('trims and collapses', normalize('  Math   Symbols!! '), 'math symbols');

console.log('\nempty query');
check('returns every deck', ids('').length, manifest.categories.length);
check('returns every deck for whitespace', ids('   ').length, manifest.categories.length);
check('carries no card subtext', searchDecks(index, '').every((r) => r.matchedCards.length === 0), true);

console.log('\ndeck-name matching');
check('exact deck name', ids('animals'), ['animals', 'national-birds-animals']);
check('prefix outranks contains', ids('animals')[0], 'animals');
check('hyphenated slug found by words', ids('country capitals'), ['country-capitals-landmarks']);
check('deck hit lists no cards', searchDecks(index, 'fruits')[0].matchedCards.length, 0);

console.log('\ncard-name matching');
const lion = searchDecks(index, 'lion');
check('lion reaches decks via cards', lion.length > 0, true);
check('lion hits are card-reason', lion.every((r) => r.reason === 'card'), true);
check('lion hits carry the card', lion.every((r) => r.matchedCards.length > 0), true);
check(
  'every returned card actually matches',
  lion.every((r) => r.matchedCards.every((c) => normalize(c.name).includes('lion'))),
  true,
);

console.log('\nranking');
// "a" matches deck names and card names alike; every deck-reason result must
// sort ahead of every card-reason one.
const mixed = reasons('a');
const lastDeck = mixed.map((r) => r.split(':')[1]).lastIndexOf('deck');
const firstCard = mixed.map((r) => r.split(':')[1]).indexOf('card');
check('decks sort before cards', firstCard === -1 || lastDeck < firstCard, true);

console.log('\nmulti-term and misses');
check('all terms must match', ids('lion zzzz'), []);
check('nonsense finds nothing', ids('zzzz'), []);
check('no duplicate decks', new Set(ids('a')).size, ids('a').length);

console.log(failures === 0 ? '\nAll search checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
