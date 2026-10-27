// Checking a set hand (RULES.md C5). Pure logic.
import { isCard } from './cards.js';
import { evaluate3, evaluate5, compare } from './evaluate.js';

export const ROW_SIZES = Object.freeze({ front: 3, middle: 5, back: 5 });
export const ROWS = ['front', 'middle', 'back'];

/**
 * Validate a set hand {front, middle, back}.
 * opts: { allowEqualRows=false, wheelRank, dealt (optional 13 dealt cards) }.
 * Returns { valid, errors: [{code, message}], evals: {front, middle, back} | null }.
 */
export function validateSet(set, opts = {}) {
  const errors = [];
  const allowEq = !!opts.allowEqualRows;
  for (const row of ROWS) {
    const n = (set?.[row] || []).length;
    if (n !== ROW_SIZES[row]) {
      errors.push({ code: 'count', row, message: `${cap(row)} needs ${ROW_SIZES[row]} cards (has ${n})` });
    }
  }
  if (errors.length) return { valid: false, errors, evals: null };

  const all = [...set.front, ...set.middle, ...set.back];
  if (!all.every(isCard)) errors.push({ code: 'card', message: 'Unknown card in hand' });
  if (new Set(all).size !== all.length) errors.push({ code: 'duplicate', message: 'Duplicate card in hand' });
  if (opts.dealt) {
    const dealt = new Set(opts.dealt);
    if (dealt.size !== 13 || !all.every((c) => dealt.has(c))) {
      errors.push({ code: 'dealt', message: 'Hand does not match the cards dealt' });
    }
  }
  if (errors.length) return { valid: false, errors, evals: null };

  const evals = {
    front: evaluate3(set.front),
    middle: evaluate5(set.middle, opts),
    back: evaluate5(set.back, opts),
  };
  const bm = compare(evals.back, evals.middle);
  const mf = compare(evals.middle, evals.front);
  if (allowEq ? bm < 0 : bm <= 0) {
    errors.push({ code: 'order-back', message: bm === 0 ? 'Back ties Middle; it must be strictly higher' : 'Back must be higher than Middle' });
  }
  if (allowEq ? mf < 0 : mf <= 0) {
    errors.push({ code: 'order-middle', message: mf === 0 ? 'Middle ties Front; it must be strictly higher' : 'Middle must be higher than Front' });
  }
  return { valid: errors.length === 0, errors, evals };
}

export const isFouled = (set, opts) => !validateSet(set, opts).valid;

function cap(s) { return s[0].toUpperCase() + s.slice(1); }
