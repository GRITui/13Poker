// Scoring between players and settlement (RULES.md B1, B2, B4, B5, C6). Pure logic.
import { CAT, compare } from './evaluate.js';
import { validateSet, ROWS } from './validate.js';
import { detectNatural, compareNaturals } from './naturals.js';
import { makeConfig, scoopBonus } from './config.js';

/**
 * Prepare a player's set hand for scoring.
 * set: {front, middle, back}; opts.dealt: the 13 cards dealt (optional);
 * opts.declareNatural: boolean (only used when cfg.naturals is on; defaults to true when a natural exists).
 */
export function preparePlayer(set, cfg = {}, opts = {}) {
  const c = makeConfig(cfg);
  const v = validateSet(set, { allowEqualRows: c.allowEqualRows, wheelRank: c.wheelRank, dealt: opts.dealt });
  let natural = null;
  if (c.naturals && opts.declareNatural !== false) {
    const cards = opts.dealt || [...(set.front || []), ...(set.middle || []), ...(set.back || [])];
    natural = detectNatural(cards, c.naturals, { wheelRank: c.wheelRank });
  }
  return { set, evals: v.evals, fouled: !v.valid, errors: v.errors, natural };
}

/** Royalties earned by one prepared player (B4). `rowsWon` limits payment to won rows when given. */
export function royaltiesFor(player, table, rowsWon = null) {
  if (!table || player.fouled || !player.evals) return 0;
  const { front, middle, back } = player.evals;
  const pay = { front: 0, middle: 0, back: 0 };
  if (front.cat === CAT.TRIPS) pay.front = table.front?.trips || 0;
  const five = (e, t) => (e.cat === CAT.STRAIGHT_FLUSH ? t?.straightFlush : e.cat === CAT.QUADS ? t?.quads
    : e.cat === CAT.FULL_HOUSE ? t?.fullHouse : 0) || 0;
  pay.middle = five(middle, table.middle);
  pay.back = five(back, table.back);
  return ROWS.reduce((s, r) => s + (rowsWon && !rowsWon[r] ? 0 : pay[r]), 0);
}

/**
 * Points A gains from B (B gains the negative). Returns a detail object:
 * { points, kind: 'natural'|'bothFouled'|'foul'|'normal', rows: {front,middle,back} (+1/0/-1 from A's view) | null,
 *   won, lost, scoop: 'A'|'B'|null, bonus, royalties: {a, b} }
 */
export function scorePair(A, B, cfg = {}) {
  const c = makeConfig(cfg);
  const detail = { points: 0, kind: 'normal', rows: null, won: 0, lost: 0, scoop: null, bonus: 0, royalties: { a: 0, b: 0 } };

  // 1. Naturals (B5): paid instead of the normal comparison and royalties.
  if (c.naturals && (A.natural || B.natural)) {
    const cmp = compareNaturals(A.natural, B.natural);
    detail.kind = 'natural';
    detail.points = cmp > 0 ? A.natural.value : cmp < 0 ? -B.natural.value : 0;
    return detail;
  }

  // 2. Fouls (B2).
  if (A.fouled && B.fouled) { detail.kind = 'bothFouled'; return detail; }
  if (A.fouled || B.fouled) {
    detail.kind = 'foul';
    const sign = B.fouled ? 1 : -1;
    const bonus = scoopBonus(c.mode);
    const roy = royaltiesFor(B.fouled ? A : B, c.royalties);
    detail.royalties = B.fouled ? { a: roy, b: 0 } : { a: 0, b: roy };
    detail.rows = { front: sign, middle: sign, back: sign };
    detail.won = sign > 0 ? 3 : 0; detail.lost = sign > 0 ? 0 : 3;
    detail.scoop = sign > 0 ? 'A' : 'B';
    detail.bonus = sign * bonus;
    detail.points = sign * (3 + bonus + roy);
    return detail;
  }

  // 3. Compare each row (A10).
  const rows = {};
  for (const r of ROWS) rows[r] = compare(A.evals[r], B.evals[r]);
  const won = ROWS.filter((r) => rows[r] > 0).length;
  const lost = ROWS.filter((r) => rows[r] < 0).length;
  let s = won - lost;
  detail.rows = rows; detail.won = won; detail.lost = lost;
  if (won === 3) detail.scoop = 'A';
  if (lost === 3) detail.scoop = 'B';

  // 4. Bonus (B1).
  let bonus = 0;
  if (c.mode === '1-6') bonus = won === 3 ? 3 : lost === 3 ? -3 : 0;
  if (c.mode === '2-4') bonus = won > lost ? 1 : lost > won ? -1 : 0;
  detail.bonus = bonus; s += bonus;

  // 5. Royalties (B4).
  if (c.royalties) {
    const wonA = c.royaltyRequiresRowWin ? Object.fromEntries(ROWS.map((r) => [r, rows[r] > 0])) : null;
    const wonB = c.royaltyRequiresRowWin ? Object.fromEntries(ROWS.map((r) => [r, rows[r] < 0])) : null;
    const ra = royaltiesFor(A, c.royalties, wonA);
    const rb = royaltiesFor(B, c.royalties, wonB);
    detail.royalties = { a: ra, b: rb };
    s += ra - rb;
  }
  detail.points = s;
  return detail;
}

/**
 * Settle all players pairwise. players: prepared players.
 * Returns { net: number[], dollars: number[], pairs: [{a, b, detail}], zeroSum: boolean }.
 */
export function settle(players, cfg = {}) {
  const c = makeConfig(cfg);
  const net = players.map(() => 0);
  const pairs = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const detail = scorePair(players[i], players[j], c);
      net[i] += detail.points; net[j] -= detail.points;
      pairs.push({ a: i, b: j, detail });
    }
  }
  applyScoopAll(players.length, pairs, c);
  for (let i = 0; i < net.length; i++) net[i] = 0;
  for (const { a, b, detail } of pairs) { net[a] += detail.points; net[b] -= detail.points; }
  const zeroSum = net.reduce((s, x) => s + x, 0) === 0;
  if (!zeroSum) throw new Error('Zero-sum check failed');
  return { net, dollars: net.map((n) => n * c.unitValue), pairs, zeroSum };
}

/** Row points for a scoop-all: 3 rows x 4. */
export const SCOOP_ALL_POINTS = 12;

/**
 * Scoop-all house rule: in 1-6 mode with 3+ players, a player who scoops every opponent (a fouled
 * opponent counts as scooped) is paid x4 row points by each of them (12 instead of 6). Royalties are
 * kept as they were. Marks the affected pair details with scoopAll = 'A' | 'B'.
 */
function applyScoopAll(n, pairs, c) {
  if (!c.scoopAll || c.mode !== '1-6' || n < 3) return;
  for (let i = 0; i < n; i++) {
    const mine = pairs.filter((p) => p.a === i || p.b === i);
    const scoopedAll = mine.every(({ a, detail }) => detail.kind !== 'natural' && detail.scoop === (a === i ? 'A' : 'B'));
    if (!scoopedAll) continue;
    for (const { a, detail } of mine) {
      const sign = a === i ? 1 : -1;
      const roy = detail.royalties.a - detail.royalties.b;
      detail.points = sign * SCOOP_ALL_POINTS + roy;
      detail.bonus = sign * (SCOOP_ALL_POINTS - 3);
      detail.scoopAll = sign > 0 ? 'A' : 'B';
    }
  }
}

/** Look up a pair result from i's perspective. */
export function pairFor(settlement, i, j) {
  const p = settlement.pairs.find((x) => (x.a === i && x.b === j) || (x.a === j && x.b === i));
  if (!p) return null;
  if (p.a === i) return p.detail;
  const d = p.detail;
  const neg = (v) => (v === 0 ? 0 : -v);
  const flip = (o) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, neg(v)]));
  return {
    ...d, points: neg(d.points), rows: flip(d.rows), won: d.lost, lost: d.won, bonus: neg(d.bonus),
    scoop: d.scoop === 'A' ? 'B' : d.scoop === 'B' ? 'A' : null,
    scoopAll: d.scoopAll === 'A' ? 'B' : d.scoopAll === 'B' ? 'A' : null,
    royalties: { a: d.royalties.b, b: d.royalties.a },
  };
}
