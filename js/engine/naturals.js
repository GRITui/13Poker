// Naturals / special hands (RULES.md B5) [OPTIONAL VARIANT]. Pure logic.
import { rankOf, suitOf, sortForDisplay } from './cards.js';
import { evaluate5, compare, CAT } from './evaluate.js';
import { combinations } from './combos.js';

export const NATURAL_ORDER = ['dragon', 'sixPairs', 'threeFlushes', 'threeStraights'];
export const NATURAL_LABEL = {
  dragon: 'Dragon',
  sixPairs: 'Six pairs',
  threeFlushes: 'Three flushes',
  threeStraights: 'Three straights',
};

function isThreeStraight(cards) {
  const r = cards.map(rankOf).sort((a, b) => a - b);
  if (r[0] === r[1] || r[1] === r[2]) return false;
  if (r[2] - r[0] === 2) return true;
  return r[0] === 2 && r[1] === 3 && r[2] === 14; // A-2-3
}

function orderRows(a, b, opts) {
  // Put the stronger 5-card hand in the Back.
  return compare(evaluate5(a, opts), evaluate5(b, opts)) >= 0 ? { back: a, middle: b } : { back: b, middle: a };
}

function findThreeFlushes(cards, opts) {
  const bySuit = {};
  for (const c of cards) (bySuit[suitOf(c)] ||= []).push(c);
  const suits = Object.keys(bySuit);
  for (const fs of suits) for (const ms of suits) for (const bs of suits) {
    const need = {};
    need[fs] = (need[fs] || 0) + 3; need[ms] = (need[ms] || 0) + 5; need[bs] = (need[bs] || 0) + 5;
    if (!Object.keys(need).every((s) => need[s] === bySuit[s].length)) continue;
    if (Object.keys(bySuit).some((s) => !need[s])) continue;
    const pool = Object.fromEntries(suits.map((s) => [s, bySuit[s].slice()]));
    const front = pool[fs].splice(0, 3);
    const m = pool[ms].splice(0, 5);
    const b = pool[bs].splice(0, 5);
    return { front, ...orderRows(m, b, opts) };
  }
  return null;
}

function findThreeStraights(cards, opts) {
  for (const fIdx of combinations(13, 3)) {
    const front = fIdx.map((i) => cards[i]);
    if (!isThreeStraight(front)) continue;
    const rest = cards.filter((_, i) => !fIdx.includes(i));
    for (const mIdx of combinations(10, 5)) {
      const m = mIdx.map((i) => rest[i]);
      const b = rest.filter((_, i) => !mIdx.includes(i));
      const em = evaluate5(m, opts); const eb = evaluate5(b, opts);
      const st = (e) => e.cat === CAT.STRAIGHT || e.cat === CAT.STRAIGHT_FLUSH;
      if (st(em) && st(eb)) return { front, ...orderRows(m, b, opts) };
    }
  }
  return null;
}

/**
 * Detect the best natural in 13 cards. Returns { type, label, value, set|null } or null.
 * `set` is a suggested arrangement (for three flushes / straights) used for display.
 */
export function detectNatural(cards, table, opts = {}) {
  if (!table || cards.length !== 13) return null;
  const counts = {};
  for (const c of cards) counts[rankOf(c)] = (counts[rankOf(c)] || 0) + 1;
  const found = {};
  if (Object.keys(counts).length === 13) found.dragon = null;
  if (Object.values(counts).reduce((s, n) => s + Math.floor(n / 2), 0) >= 6) found.sixPairs = null;
  if (table.threeFlushes != null) { const s = findThreeFlushes(cards, opts); if (s) found.threeFlushes = s; }
  if (table.threeStraights != null) { const s = findThreeStraights(cards, opts); if (s) found.threeStraights = s; }
  for (const type of NATURAL_ORDER) {
    if (type in found && table[type] != null) {
      const set = found[type];
      return {
        type, label: NATURAL_LABEL[type], value: table[type],
        set: set && { front: sortForDisplay(set.front), middle: sortForDisplay(set.middle), back: sortForDisplay(set.back) },
      };
    }
  }
  return null;
}

/** Compare two naturals: +1 if a is higher, -1 if lower, 0 if same type. Null = no natural. */
export function compareNaturals(a, b) {
  const ia = a ? NATURAL_ORDER.indexOf(a.type) : 99;
  const ib = b ? NATURAL_ORDER.indexOf(b.type) : 99;
  return Math.sign(ib - ia);
}
