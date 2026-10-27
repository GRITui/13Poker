// Cards, deck, shuffling. Pure logic, no DOM.
// A card is a 2-character string: rank char + suit char, e.g. "As", "Td", "7c".

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['s', 'h', 'd', 'c'];

export const RANK_VALUE = Object.freeze(
  Object.fromEntries(RANKS.map((r, i) => [r, i + 2]))
);

export const RANK_NAME = Object.freeze({
  2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight',
  9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace',
});
export const RANK_PLURAL = Object.freeze({
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights',
  9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens', 13: 'Kings', 14: 'Aces',
});
export const RANK_SHORT = Object.freeze({
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
});
export const SUIT_NAME = Object.freeze({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' });
export const SUIT_SYMBOL = Object.freeze({ s: '♠', h: '♥', d: '♦', c: '♣' });

const VALID = new Set(RANKS.flatMap((r) => SUITS.map((s) => r + s)));

/** Normalise a card string ("as", "10h", "Td") to canonical form ("As", "Th", "Td"). */
export function normalizeCard(c) {
  if (typeof c !== 'string') throw new TypeError(`Card must be a string, got ${c}`);
  let s = c.trim();
  if (s.startsWith('10')) s = 'T' + s.slice(2);
  if (s.length !== 2) throw new Error(`Bad card: ${c}`);
  const out = s[0].toUpperCase() + s[1].toLowerCase();
  if (!VALID.has(out)) throw new Error(`Bad card: ${c}`);
  return out;
}

export function isCard(c) {
  return typeof c === 'string' && VALID.has(c);
}

/** Parse "Qd Qc 3h" (or an array) into canonical card strings. */
export function parseCards(input) {
  const list = Array.isArray(input) ? input : String(input).trim().split(/[\s,]+/).filter(Boolean);
  return list.map(normalizeCard);
}

export const rankOf = (c) => RANK_VALUE[c[0]];
export const suitOf = (c) => c[1];

export function makeDeck() {
  return RANKS.flatMap((r) => SUITS.map((s) => r + s));
}

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function seededRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle; returns a new array. */
export function shuffle(cards, rng = Math.random) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deal 13 cards to each of `players` (2..4) from a freshly shuffled deck. */
export function deal(players, rng = Math.random) {
  if (!Number.isInteger(players) || players < 2 || players > 4) {
    throw new Error('Chinese Poker is played by 2 to 4 players');
  }
  const deck = shuffle(makeDeck(), rng);
  const hands = [];
  for (let p = 0; p < players; p++) hands.push(deck.slice(p * 13, p * 13 + 13));
  return hands;
}

/** Sort by rank (high first), suit as a stable visual tie-break only. */
export function sortByRank(cards) {
  return cards.slice().sort((a, b) => rankOf(b) - rankOf(a) || SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)));
}

/** Sort by suit (s, h, d, c... displayed grouped), then rank high first. */
export function sortBySuit(cards) {
  const order = ['s', 'h', 'c', 'd']; // alternate colours for readability
  return cards.slice().sort((a, b) => order.indexOf(suitOf(a)) - order.indexOf(suitOf(b)) || rankOf(b) - rankOf(a));
}

/** Sort a hand for display: biggest groups first (e.g. the pair), then by rank. */
export function sortForDisplay(cards) {
  const counts = {};
  for (const c of cards) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
  return cards.slice().sort((a, b) =>
    counts[rankOf(b)] - counts[rankOf(a)] || rankOf(b) - rankOf(a) || SUITS.indexOf(suitOf(a)) - SUITS.indexOf(suitOf(b)));
}
