// Online table state: validation of shared documents, seat folding, deterministic deals and round results.
// Pure logic (no DOM, no network), so it runs in node tests. Everything read from the shared store is untrusted:
// every reader goes through a sanitize* function before using it.
import {
  deal, seededRng, isCard, validateSet, arrangeHand, detectNatural, preparePlayer, settle, makeConfig,
  SCORING_MODES, DEFAULT_ROYALTIES, DEFAULT_NATURALS,
} from '../engine/index.js';

/** Table codes use an alphabet without look-alikes (no I, L, O, 0, 1). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;
export const MAX_SEATS = 4;
export const MAX_ROUND = 100000;
export const PHASES = ['lobby', 'arrange', 'showdown'];
export const BOT_IDS = ['bot-0', 'bot-1', 'bot-2'];
const ID_RE = /^[A-Za-z0-9_.~:@+-]{1,200}$/; // the store's path-segment grammar

export function makeCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return s;
}

/** Normalise user input ("k7qm ", "K7-QM") to a code, or null when it can't be one. */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export const isId = (v) => typeof v === 'string' && ID_RE.test(v) && v !== '.' && v !== '..';
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export const DEFAULT_TABLE_SETTINGS = Object.freeze({
  mode: '1-6', unitValue: 1, royalties: false, royaltyRequiresRowWin: false, naturals: false,
  allowEqualRows: false, wheelSecond: false, fillBots: true,
});

export function sanitizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const b = (k) => (typeof s[k] === 'boolean' ? s[k] : DEFAULT_TABLE_SETTINGS[k]);
  return {
    mode: SCORING_MODES.includes(s.mode) ? s.mode : DEFAULT_TABLE_SETTINGS.mode,
    unitValue: isInt(s.unitValue, 1, 10) ? s.unitValue : 1,
    royalties: b('royalties'),
    royaltyRequiresRowWin: b('royaltyRequiresRowWin'),
    naturals: b('naturals'),
    allowEqualRows: b('allowEqualRows'),
    wheelSecond: b('wheelSecond'),
    fillBots: b('fillBots'),
  };
}

/** Engine config for a table's (sanitized) settings. */
export function tableConfig(settings) {
  return makeConfig({
    mode: settings.mode,
    unitValue: settings.unitValue,
    allowEqualRows: settings.allowEqualRows,
    royalties: settings.royalties ? DEFAULT_ROYALTIES : null,
    royaltyRequiresRowWin: settings.royaltyRequiresRowWin,
    naturals: settings.naturals ? DEFAULT_NATURALS : null,
    wheelRank: settings.wheelSecond ? 'second' : 'lowest',
  });
}
export const tableRuleOpts = (settings) => ({
  allowEqualRows: settings.allowEqualRows, wheelRank: settings.wheelSecond ? 'second' : 'lowest',
});

function sanitizeSeats(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SEATS) return null;
  const seats = [];
  const seen = new Set();
  for (const s of raw) {
    if (!s || typeof s !== 'object') return null;
    if (s.kind === 'bot' ? !BOT_IDS.includes(s.id) : s.kind !== 'human' || !isId(s.id)) return null;
    if (seen.has(s.id)) return null;
    seen.add(s.id);
    seats.push({ id: s.id, kind: s.kind });
  }
  return seats;
}

function sanitizeResults(raw, n) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const rounds = new Set();
  for (const r of raw.slice(0, MAX_ROUND)) {
    if (!r || typeof r !== 'object' || !isInt(r.round, 1, MAX_ROUND) || rounds.has(r.round)) continue;
    if (!Array.isArray(r.net) || r.net.length !== n || !r.net.every((x) => isInt(x, -10000, 10000))) continue;
    if (r.net.reduce((a, x) => a + x, 0) !== 0) continue;
    rounds.add(r.round);
    out.push({ round: r.round, net: r.net.slice() });
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * Validate a `tables/{hostId}` document. Returns a clean table or null when the document can't be used.
 * docId is the document id, which must be the host's id (only the host can write there).
 */
export function sanitizeTable(raw, docId) {
  if (!raw || typeof raw !== 'object' || !isId(docId)) return null;
  const code = normalizeCode(raw.code);
  if (!code || raw.code !== code) return null;
  if (raw.host !== docId) return null;
  if (!PHASES.includes(raw.phase)) return null;
  const seats = sanitizeSeats(raw.seats);
  if (!seats || seats[0].id !== raw.host || seats[0].kind !== 'human') return null;
  const t = {
    code,
    host: raw.host,
    phase: raw.phase,
    round: isInt(raw.round, 0, MAX_ROUND) ? raw.round : 0,
    seed: isInt(raw.seed, 1, 0x7fffffff) ? raw.seed : 0,
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    seats,
    settings: sanitizeSettings(raw.settings),
    results: [],
  };
  if (t.phase !== 'lobby') {
    if (seats.length < 2 || t.round < 1 || !t.seed) return null;
    t.results = sanitizeResults(raw.results, seats.length).filter((r) => r.round <= t.round);
  }
  return t;
}

/** Validate a `players/{uid}` document: {table, joinedAt, round?, front?, middle?, back?, declareNatural?}. */
export function sanitizePlayer(raw, docId) {
  if (!raw || typeof raw !== 'object' || !isId(docId)) return null;
  const table = normalizeCode(raw.table);
  if (!table || raw.table !== table) return null;
  const p = { id: docId, table, joinedAt: typeof raw.joinedAt === 'number' && Number.isFinite(raw.joinedAt) ? raw.joinedAt : 0, sub: null };
  const okRow = (r, n) => Array.isArray(r) && r.length === n && r.every(isCard);
  if (isInt(raw.round, 1, MAX_ROUND) && okRow(raw.front, 3) && okRow(raw.middle, 5) && okRow(raw.back, 5)) {
    p.sub = {
      round: raw.round,
      set: { front: raw.front.slice(), middle: raw.middle.slice(), back: raw.back.slice() },
      declareNatural: raw.declareNatural === true,
    };
  }
  return p;
}

/**
 * Host-side seat folding while the table is in the lobby. `players` are sanitized player docs for this table's
 * code. Keeps the host first and seated humans who are still at the table (in order), then adds newcomers by
 * join time, up to MAX_SEATS. Bots are only added at start.
 */
export function foldSeats(seats, players, hostId) {
  const here = new Map(players.filter(Boolean).map((p) => [p.id, p]));
  const out = [{ id: hostId, kind: 'human' }];
  for (const s of seats) {
    if (s.kind === 'human' && s.id !== hostId && here.has(s.id) && out.length < MAX_SEATS) out.push({ id: s.id, kind: 'human' });
  }
  const seated = new Set(out.map((s) => s.id));
  const newcomers = [...here.values()].filter((p) => !seated.has(p.id))
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const p of newcomers) {
    if (out.length >= MAX_SEATS) break;
    out.push({ id: p.id, kind: 'human' });
  }
  return out;
}

export const sameSeats = (a, b) => a.length === b.length && a.every((s, i) => s.id === b[i].id && s.kind === b[i].kind);

/** The seats a game starts with: the humans plus, when asked, bots up to four players. */
export function startingSeats(humans, fillBots) {
  const seats = humans.filter((s) => s.kind === 'human').slice(0, MAX_SEATS).map((s) => ({ id: s.id, kind: 'human' }));
  if (fillBots) for (let k = 0; seats.length < MAX_SEATS; k++) seats.push({ id: BOT_IDS[k], kind: 'bot' });
  return seats;
}

/** Turn the given human seats (who left mid-game) into bots, choosing unused bot ids. */
export function replaceWithBots(seats, ids) {
  const used = new Set(seats.filter((s) => s.kind === 'bot').map((s) => s.id));
  return seats.map((s) => {
    if (s.kind !== 'human' || !ids.includes(s.id)) return s;
    const id = BOT_IDS.find((b) => !used.has(b));
    if (!id) return s;
    used.add(id);
    return { id, kind: 'bot' };
  });
}

/** The 13-card hands for a round, in seat order. Every client computes the same deal. */
export function roundHands(seed, round, n) {
  return deal(n, seededRng(seed * 1000 + round));
}

/** A bot's arrangement for a round (deterministic, so every client agrees without anyone writing it). */
export function botSet(hand, seed, round, seatIndex, settings) {
  const opts = tableRuleOpts(settings);
  if (settings.naturals) {
    const nat = detectNatural(hand, DEFAULT_NATURALS, opts);
    if (nat?.set) return { set: nat.set, declareNatural: true };
  }
  const rng = seededRng(seed * 7919 + round * 31 + seatIndex);
  return { set: arrangeHand(hand, { ...opts, rng }).set, declareNatural: settings.naturals };
}

/**
 * Is a player's submission usable for this round? It must be for this round, use exactly the dealt cards and be a
 * valid (unfouled) hand, unless it declares a natural that the dealt cards really contain.
 */
export function acceptSubmission(sub, hand, round, settings) {
  if (!sub || sub.round !== round) return false;
  const opts = tableRuleOpts(settings);
  const v = validateSet(sub.set, { ...opts, dealt: hand });
  if (v.valid) return true;
  if (v.errors.some((e) => e.code !== 'order-back' && e.code !== 'order-middle')) return false;
  return !!(settings.naturals && sub.declareNatural && detectNatural(hand, DEFAULT_NATURALS, opts));
}

/**
 * Status of every seat for the table's current round.
 * players: Map or array of sanitized player docs. Returns [{id, kind, here, ready, sub}] in seat order.
 */
export function seatStatus(table, players, hands = roundHands(table.seed, table.round, table.seats.length)) {
  const byId = players instanceof Map ? players : new Map(players.filter(Boolean).map((p) => [p.id, p]));
  return table.seats.map((s, i) => {
    if (s.kind === 'bot') return { id: s.id, kind: 'bot', here: true, ready: true, sub: null };
    const p = byId.get(s.id);
    const here = !!p && p.table === table.code;
    const sub = here && p.sub && acceptSubmission(p.sub, hands[i], table.round, table.settings) ? p.sub : null;
    return { id: s.id, kind: 'human', here, ready: !!sub, sub };
  });
}

/**
 * Score the current round once every seat is ready. Returns null if someone is still arranging.
 * Result: { hands, sets, players (prepared), settlement } with everything in seat order.
 */
export function scoreRound(table, players) {
  const hands = roundHands(table.seed, table.round, table.seats.length);
  const status = seatStatus(table, players, hands);
  if (!status.every((s) => s.ready)) return null;
  const cfg = tableConfig(table.settings);
  const sets = [];
  const prepared = status.map((s, i) => {
    const { set, declareNatural } = s.kind === 'bot'
      ? botSet(hands[i], table.seed, table.round, i, table.settings)
      : s.sub;
    sets.push(set);
    return preparePlayer(set, cfg, { dealt: hands[i], declareNatural });
  });
  return { hands, sets, players: prepared, settlement: settle(prepared, cfg) };
}

/** Results with this round's net appended (idempotent: an existing entry for the round is kept). */
export function appendResult(results, round, net) {
  if (results.some((r) => r.round === round)) return results;
  return [...results, { round, net: net.slice() }].sort((a, b) => a.round - b.round);
}

export function totalsOf(results, n) {
  const t = new Array(n).fill(0);
  for (const r of results) r.net.forEach((x, i) => { t[i] += x; });
  return t;
}

/** Seat order seen from seat `me`: me first, then the others clockwise. */
export function rotation(n, me) {
  return Array.from({ length: n }, (_, k) => (me + k) % n);
}

/** A settlement re-indexed for display (order[k] = seat index shown at position k). */
export function rotateSettlement(st, order) {
  const pos = new Map(order.map((seat, k) => [seat, k]));
  return {
    ...st,
    net: order.map((s) => st.net[s]),
    dollars: order.map((s) => st.dollars[s]),
    pairs: st.pairs.map((p) => ({ a: pos.get(p.a), b: pos.get(p.b), detail: p.detail })),
  };
}
