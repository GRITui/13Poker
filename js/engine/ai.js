// AI hand setting: exhaustive search over all Back/Middle/Front splits, scored by a heuristic
// estimate of how often each row wins at that position. Pure logic.
import { sortForDisplay } from './cards.js';
import { evaluate3, evaluate5, compare, CAT } from './evaluate.js';
import { combinations } from './combos.js';

// [base, span] per category: estimated win-probability range for a hand of that category in that row.
// Hand-tuned approximations of typical Chinese Poker row strength (not exact statistics).
const BACK = [[0.00, 0.02], [0.02, 0.10], [0.13, 0.23], [0.37, 0.13], [0.51, 0.13], [0.65, 0.15], [0.81, 0.14], [0.96, 0.03], [0.995, 0.005]];
const MIDDLE = [[0.02, 0.08], [0.10, 0.33], [0.44, 0.27], [0.72, 0.09], [0.81, 0.07], [0.88, 0.06], [0.95, 0.035], [0.99, 0.008], [0.998, 0.002]];
const FRONT_TRIPS = [0.97, 0.03];
const FRONT_PAIR = [0.42, 0.53];

/** Position of a hand within its category, 0..1, from its first two tie-break ranks. */
function within(e) {
  const k0 = Math.min(e.key[0], 14);
  const k1 = e.key.length > 1 ? e.key[1] : 2;
  return Math.min(1, ((k0 - 2) + (k1 - 2) / 13) / 12.9);
}

export function rowStrength(e, row) {
  if (row === 'front') {
    if (e.cat === CAT.TRIPS) return FRONT_TRIPS[0] + FRONT_TRIPS[1] * within(e);
    if (e.cat === CAT.PAIR) return FRONT_PAIR[0] + FRONT_PAIR[1] * within(e);
    const t = (e.key[0] - 2) / 12;
    return 0.38 * t ** 1.6 + 0.02 * ((e.key[1] - 2) / 12);
  }
  const [base, span] = (row === 'back' ? BACK : MIDDLE)[e.cat];
  return base + span * within(e);
}

/** Numeric strength for fast comparison of two 5-card evals (same ordering as compare()). */
function value5(e) {
  let v = e.cat;
  for (let i = 0; i < 5; i++) v = v * 16 + (e.key[i] || 0);
  return v;
}

/**
 * Choose an arrangement for 13 cards.
 * opts: { allowEqualRows=false, wheelRank, weights={front,middle,back}, rng (for tiny tie-break noise) }
 * Returns { set: {front, middle, back}, score, valid }.
 */
export function arrangeHand(cards, opts = {}) {
  if (cards.length !== 13) throw new Error('arrangeHand needs 13 cards');
  const allowEq = !!opts.allowEqualRows;
  const w = { front: 1, middle: 1, back: 1, ...(opts.weights || {}) };
  const noise = opts.rng ? () => opts.rng() * 0.002 : () => 0;

  // Pre-evaluate every 5-card subset (1287) and every 3-card subset (286) by bitmask.
  const five = new Map();
  for (const idx of combinations(13, 5)) {
    let mask = 0; for (const i of idx) mask |= 1 << i;
    const e = evaluate5(idx.map((i) => cards[i]), opts);
    five.set(mask, { e, v: value5(e), sb: rowStrength(e, 'back') * w.back, sm: rowStrength(e, 'middle') * w.middle });
  }
  const three = new Map();
  for (const idx of combinations(13, 3)) {
    let mask = 0; for (const i of idx) mask |= 1 << i;
    const e = evaluate3(idx.map((i) => cards[i]));
    three.set(mask, { e, sf: rowStrength(e, 'front') * w.front });
  }

  const FULL = (1 << 13) - 1;
  let best = null; let bestScore = -Infinity;
  let fallback = null; let fallbackScore = -Infinity;
  for (const [bMask, B] of five) {
    const restIdx = [];
    for (let i = 0; i < 13; i++) if (!(bMask & (1 << i))) restIdx.push(i);
    for (const mi of combinations(8, 5)) {
      let mMask = 0; for (const k of mi) mMask |= 1 << restIdx[k];
      const M = five.get(mMask);
      const F = three.get(FULL & ~bMask & ~mMask);
      const score = B.sb + M.sm + F.sf + noise();
      const okBM = allowEq ? B.v >= M.v : B.v > M.v;
      if (okBM) {
        const mf = compare(M.e, F.e);
        if (allowEq ? mf >= 0 : mf > 0) {
          if (score > bestScore) { bestScore = score; best = [bMask, mMask]; }
          continue;
        }
      }
      if (!best && score > fallbackScore) { fallbackScore = score; fallback = [bMask, mMask]; }
    }
  }
  const pick = best || fallback;
  const take = (mask) => cards.filter((_, i) => mask & (1 << i));
  const set = {
    back: sortForDisplay(take(pick[0])),
    middle: sortForDisplay(take(pick[1])),
    front: sortForDisplay(take(FULL & ~pick[0] & ~pick[1])),
  };
  return { set, score: best ? bestScore : fallbackScore, valid: !!best };
}
