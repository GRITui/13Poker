// Hand evaluation and comparison (RULES.md C2-C4). Pure logic.
import { rankOf, suitOf, RANK_NAME, RANK_PLURAL, RANK_SHORT } from './cards.js';

export const CAT = Object.freeze({
  HIGH_CARD: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
});

export const CAT_NAME = ['High card', 'One pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush',
  'Full house', 'Four of a kind', 'Straight flush'];

/** Rank groups sorted by (count desc, rank desc): [[rank, count], ...]. */
function groups(ranks) {
  const m = new Map();
  for (const r of ranks) m.set(r, (m.get(r) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

/**
 * Evaluate a 5-card hand (Back / Middle).
 * opts.wheelRank: "lowest" (default, A-2-3-4-5 top card 5) or "second" (ranks just below T-J-Q-K-A).
 * Returns { cat, key, size: 5 }.
 */
export function evaluate5(cards, opts = {}) {
  if (cards.length !== 5) throw new Error('evaluate5 needs exactly 5 cards');
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
  const g = groups(ranks);
  let straightTop = 0;
  if (g.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightTop = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightTop = opts.wheelRank === 'second' ? 13.5 : 5;
  }
  if (straightTop && flush) return { cat: CAT.STRAIGHT_FLUSH, key: [straightTop], size: 5 };
  if (g[0][1] === 4) return { cat: CAT.QUADS, key: [g[0][0], g[1][0]], size: 5 };
  if (g[0][1] === 3 && g[1][1] === 2) return { cat: CAT.FULL_HOUSE, key: [g[0][0], g[1][0]], size: 5 };
  if (flush) return { cat: CAT.FLUSH, key: ranks, size: 5 };
  if (straightTop) return { cat: CAT.STRAIGHT, key: [straightTop], size: 5 };
  if (g[0][1] === 3) return { cat: CAT.TRIPS, key: g.map((x) => x[0]), size: 5 };
  if (g[0][1] === 2 && g[1][1] === 2) return { cat: CAT.TWO_PAIR, key: g.map((x) => x[0]), size: 5 };
  if (g[0][1] === 2) return { cat: CAT.PAIR, key: g.map((x) => x[0]), size: 5 };
  return { cat: CAT.HIGH_CARD, key: ranks, size: 5 };
}

/**
 * Evaluate a 3-card Front hand. Straights and flushes do not count [WSGC A8]:
 * only Trips (3), Pair (1) or High card (0), using the same category numbers as 5-card hands.
 */
export function evaluate3(cards) {
  if (cards.length !== 3) throw new Error('evaluate3 needs exactly 3 cards');
  const g = groups(cards.map(rankOf));
  if (g[0][1] === 3) return { cat: CAT.TRIPS, key: [g[0][0]], size: 3 };
  if (g[0][1] === 2) return { cat: CAT.PAIR, key: [g[0][0], g[1][0]], size: 3 };
  return { cat: CAT.HIGH_CARD, key: g.map((x) => x[0]), size: 3 };
}

/** Evaluate a 3- or 5-card hand. */
export function evaluate(cards, opts = {}) {
  if (cards.length === 3) return evaluate3(cards);
  if (cards.length === 5) return evaluate5(cards, opts);
  throw new Error(`Cannot evaluate a ${cards.length}-card hand`);
}

/**
 * Compare two evaluated hands (RULES.md C4). Returns -1, 0 or +1.
 * Works across sizes (Front vs Middle): if keys agree as far as both go, the longer key is higher.
 */
export function compare(h1, h2) {
  if (h1.cat !== h2.cat) return Math.sign(h1.cat - h2.cat);
  const n = Math.min(h1.key.length, h2.key.length);
  for (let i = 0; i < n; i++) {
    if (h1.key[i] !== h2.key[i]) return Math.sign(h1.key[i] - h2.key[i]);
  }
  if (h1.key.length === h2.key.length) return 0;
  return Math.sign(h1.key.length - h2.key.length);
}

/** Convenience: compare two card arrays directly. */
export function compareCards(a, b, opts = {}) {
  return compare(evaluate(a, opts), evaluate(b, opts));
}

const short = (r) => (r === 13.5 ? '5' : RANK_SHORT[r]);

/** Human-readable name for an evaluated hand, e.g. "Pair of Kings", "Flush, A-high". */
export function handName(h) {
  const k = h.key;
  switch (h.cat) {
    case CAT.STRAIGHT_FLUSH:
      return k[0] === 14 ? 'Royal flush' : `Straight flush, ${short(k[0])}-high`;
    case CAT.QUADS: return `Four ${RANK_PLURAL[k[0]]}`;
    case CAT.FULL_HOUSE: return `Full house, ${RANK_PLURAL[k[0]]} over ${RANK_PLURAL[k[1]]}`;
    case CAT.FLUSH: return `Flush, ${short(k[0])}-high`;
    case CAT.STRAIGHT: return `Straight, ${short(k[0])}-high`;
    case CAT.TRIPS: return `Three ${RANK_PLURAL[k[0]]}`;
    case CAT.TWO_PAIR: return `Two pair, ${RANK_PLURAL[k[0]]} & ${RANK_PLURAL[k[1]]}`;
    case CAT.PAIR: return `Pair of ${RANK_PLURAL[k[0]]}`;
    default: return `${short(k[0])}-high`;
  }
}

/** Short category label (for compact UI). */
export function catName(h) {
  if (h.cat === CAT.STRAIGHT_FLUSH && h.key[0] === 14) return 'Royal flush';
  return CAT_NAME[h.cat];
}

export { RANK_NAME };
