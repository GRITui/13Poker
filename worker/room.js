// Server-side table logic for the Cloudflare Worker: one Room per table, owned by a Durable Object.
// Pure module: no Cloudflare APIs, no I/O, so node tests can drive it. Time comes in as `now` (ms) on every call and
// randomness from opts.random / opts.randomId (crypto by default). The Durable Object (./table-do.js) persists
// room.toJSON() and wakes the room with tick() at room.nextWake().
//
// The server is the authority: it deals, keeps every hand secret until the showdown, validates each set hand against
// the cards it dealt, auto-sets late hands when the turn timer runs out, and scores with the shared engine.
import { deal, arrangeHand, detectNatural, preparePlayer, settle, isCard, DEFAULT_NATURALS } from '../js/engine/index.js';
import {
  sanitizeSettings, tableConfig, tableRuleOpts, acceptSubmission, normalizeCode, CODE_ALPHABET, CODE_LENGTH, MAX_SEATS,
} from '../js/online/table.js';

export const LIMITS = Object.freeze({
  MAX_MESSAGE_BYTES: 4096,
  NAME_MAX: 16,
  RATE_PER_SEC: 5, // sustained messages per second per socket
  RATE_BURST: 15, // bucket size
  HOST_GRACE_MS: 30_000, // a disconnected host keeps the role this long
  IDLE_MS: 60 * 60_000, // a table nobody is connected to is deleted after this
  TURN_MS: 90_000, // time to set a hand
  KEEP_RESULTS: 200, // per-round results kept (totals cover every round)
});

export const BOT_NAMES = ['Lin', 'Rosa', 'Kai', 'Ada'];
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const CLIENT_TYPES = ['hello', 'setSettings', 'start', 'setHand', 'nextRound', 'leave', 'kick', 'seatBot'];

// ---------- randomness (crypto by default) ----------
/** A float in [0, 1) with 53 random bits from crypto.getRandomValues. */
export function cryptoRandom() {
  const u = new Uint32Array(2);
  globalThis.crypto.getRandomValues(u);
  return (u[0] * 2 ** 21 + (u[1] >>> 11)) / 2 ** 53;
}
/** A random URL-safe id with `n` characters (6 bits each). */
export function cryptoId(n = 24) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += abc[x & 63];
  return s;
}
/** A table code from CODE_ALPHABET without modulo bias. */
export function randomCode(random = cryptoRandom) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}
export { normalizeCode };

// ---------- names ----------
// Control, format and invisible characters (bidi overrides, zero-width, fillers, variation selectors).
const INVISIBLE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xffff]];
const hex4 = (n) => n.toString(16).padStart(4, '0');
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? `\\u${hex4(a)}` : `\\u${hex4(a)}-\\u${hex4(b)}`)).join('')}]`, 'g');
/** Clean a nickname: strip control/invisible characters, collapse spaces, trim, 1-16 characters. Null if unusable. */
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (!chars.length) return null;
  return chars.slice(0, LIMITS.NAME_MAX).join('').trim();
}

// ---------- inbound messages ----------
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const cardRow = (r, n) => Array.isArray(r) && r.length === n && r.every(isCard);
const err = (code, message) => ({ ok: false, error: { code, message } });

/**
 * Parse and validate one client message. Returns { ok: true, msg } or { ok: false, error: {code, message} }.
 * Only the fields each type needs are kept.
 */
export function parseMessage(raw) {
  if (typeof raw !== 'string') return err('bad-message', 'Messages must be JSON text.');
  if (raw.length > LIMITS.MAX_MESSAGE_BYTES || new TextEncoder().encode(raw).length > LIMITS.MAX_MESSAGE_BYTES) {
    return err('too-large', 'Message too large.');
  }
  let m;
  try { m = JSON.parse(raw); } catch { return err('bad-message', 'Messages must be JSON.'); }
  if (!isObj(m) || typeof m.type !== 'string' || !CLIENT_TYPES.includes(m.type)) return err('bad-type', 'Unknown message type.');
  switch (m.type) {
    case 'hello': {
      if (typeof m.name !== 'string' || m.name.length > 200) return err('bad-name', 'Choose a nickname (1–16 characters).');
      if (m.token != null && (typeof m.token !== 'string' || !TOKEN_RE.test(m.token))) return err('bad-message', 'Bad rejoin token.');
      return { ok: true, msg: { type: 'hello', name: m.name, token: m.token || null } };
    }
    case 'setSettings':
      if (!isObj(m.settings)) return err('bad-message', 'settings must be an object.');
      return { ok: true, msg: { type: 'setSettings', settings: m.settings } };
    case 'setHand':
      if (!cardRow(m.front, 3) || !cardRow(m.middle, 5) || !cardRow(m.back, 5)) return err('bad-hand', 'A hand is Front 3, Middle 5 and Back 5 cards.');
      if (m.declareNatural != null && typeof m.declareNatural !== 'boolean') return err('bad-message', 'declareNatural must be true or false.');
      return { ok: true, msg: { type: 'setHand', front: m.front.slice(), middle: m.middle.slice(), back: m.back.slice(), declareNatural: m.declareNatural === true } };
    case 'kick':
    case 'seatBot':
      if (!Number.isInteger(m.seat) || m.seat < 0 || m.seat >= MAX_SEATS) return err('bad-message', 'Bad seat.');
      return { ok: true, msg: { type: m.type, seat: m.seat } };
    default:
      return { ok: true, msg: { type: m.type } };
  }
}

/** Token bucket: `rate` messages per second sustained, bursts up to `burst`. */
export class RateLimiter {
  constructor(rate = LIMITS.RATE_PER_SEC, burst = LIMITS.RATE_BURST) {
    this.rate = rate; this.burst = burst; this.tokens = burst; this.at = null; this.dropped = 0;
  }
  allow(now) {
    if (this.at != null) this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    this.dropped++;
    return false;
  }
}

// ---------- the room ----------
class RoomError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RoomError(code, message); };

/** A bot's (or a timed-out player's) arrangement: a natural when it has one, else the AI's best split. */
export function autoSet(hand, settings) {
  const opts = tableRuleOpts(settings);
  if (settings.naturals) {
    const nat = detectNatural(hand, DEFAULT_NATURALS, opts);
    if (nat) return { set: nat.set || arrangeHand(hand, opts).set, declareNatural: true };
  }
  return { set: arrangeHand(hand, opts).set, declareNatural: false };
}

export class Room {
  /**
   * opts: { turnMs, hostGraceMs, idleMs, random (float in [0,1)), randomId(n) }.
   * Use Room.create() for a new table and Room.restore() for a persisted one.
   */
  constructor(state, opts = {}) {
    this.s = state;
    this.turnMs = opts.turnMs || LIMITS.TURN_MS;
    this.hostGraceMs = opts.hostGraceMs ?? LIMITS.HOST_GRACE_MS;
    this.idleMs = opts.idleMs || LIMITS.IDLE_MS;
    this.random = opts.random || cryptoRandom;
    this.randomId = opts.randomId || cryptoId;
  }

  static create(code, settings, now, opts = {}) {
    const c = normalizeCode(code);
    if (!c) throw new Error('bad table code');
    return new Room({
      v: 1, code: c, createdAt: now, phase: 'lobby', round: 0,
      settings: sanitizeSettings({ ...settings, fillBots: settings?.fillBots ?? true }),
      seats: [], host: null,
      hands: [], subs: [], deadline: null,
      results: [], totals: [], last: null,
      emptySince: now, updatedAt: now,
    }, opts);
  }
  static restore(json, opts = {}) { return new Room(structuredClone(json), opts); }
  toJSON() { return this.s; }

  get code() { return this.s.code; }
  get phase() { return this.s.phase; }
  seatOf(pid) { return this.s.seats.findIndex((x) => x.pid === pid); }
  humans() { return this.s.seats.filter((x) => x.kind === 'human'); }

  // ----- connections -----
  /**
   * A socket says hello. Returns { pid, token, rejoined } or throws a RoomError (code: bad-name, started, full).
   * A valid token for a seat at this table gets that seat back (same hand, same set hand).
   */
  join({ name, token }, now) {
    const s = this.s;
    if (token) {
      const seat = s.seats.find((x) => x.kind === 'human' && x.token === token);
      if (seat) {
        seat.connected = true; seat.discAt = null;
        s.emptySince = null;
        if (!s.host) s.host = seat.pid;
        this.touch(now);
        return { pid: seat.pid, token: seat.token, rejoined: true };
      }
    }
    const nm = cleanName(name);
    if (!nm) fail('bad-name', 'Choose a nickname (1–16 characters).');
    if (s.phase !== 'lobby') fail('started', 'That game has already started.');
    if (s.seats.length >= MAX_SEATS) fail('full', 'That table is full.');
    const seat = {
      pid: `p_${this.randomId(10)}`, kind: 'human', name: this.uniqueName(nm), token: this.randomId(32),
      connected: true, discAt: null,
    };
    s.seats.push(seat);
    if (!s.host) s.host = seat.pid;
    s.emptySince = null;
    this.touch(now);
    return { pid: seat.pid, token: seat.token, rejoined: false };
  }

  uniqueName(nm) {
    const taken = new Set(this.s.seats.map((x) => x.name.toLowerCase()));
    if (!taken.has(nm.toLowerCase())) return nm;
    for (let k = 2; ; k++) {
      const base = Array.from(nm).slice(0, LIMITS.NAME_MAX - String(k).length - 1).join('');
      const cand = `${base} ${k}`;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
  }

  /** The last socket of a player closed. */
  disconnect(pid, now) {
    const seat = this.s.seats.find((x) => x.pid === pid);
    if (seat && seat.kind === 'human' && seat.connected) { seat.connected = false; seat.discAt = now; }
    if (!this.s.seats.some((x) => x.kind === 'human' && x.connected)) this.s.emptySince ??= now;
    this.touch(now);
    this.tick(now);
  }

  /** Make the connection flags match the sockets that are really open (after the object was restarted). */
  reconcile(openPids, now) {
    const open = new Set(openPids);
    for (const seat of this.s.seats) {
      if (seat.kind !== 'human') continue;
      const on = open.has(seat.pid);
      if (seat.connected && !on) { seat.connected = false; seat.discAt = now; }
      if (!seat.connected && on) { seat.connected = true; seat.discAt = null; }
    }
    if (this.s.seats.some((x) => x.kind === 'human' && x.connected)) this.s.emptySince = null;
    else this.s.emptySince ??= now;
  }

  touch(now) { this.s.updatedAt = now; }

  // ----- messages -----
  /**
   * Apply a validated message (see parseMessage) from player `pid`. Returns { kicked: [pid], left: bool }.
   * Throws a RoomError for anything not allowed.
   */
  handle(pid, msg, now) {
    const s = this.s;
    const me = this.seatOf(pid);
    if (me < 0) fail('not-seated', 'You are not at this table.');
    const isHost = s.host === pid;
    const out = { kicked: [], left: false };
    switch (msg.type) {
      case 'setSettings': {
        if (!isHost) fail('not-host', 'Only the host can change the rules.');
        if (s.phase !== 'lobby') fail('bad-phase', 'Rules can only change before the game starts.');
        s.settings = sanitizeSettings({ ...s.settings, ...msg.settings });
        break;
      }
      case 'start': {
        if (!isHost) fail('not-host', 'Only the host can start.');
        if (s.phase !== 'lobby') fail('bad-phase', 'The game has already started.');
        if (s.settings.fillBots) this.fillBots();
        if (s.seats.length < 2) fail('need-players', 'You need at least one more player, or turn on AI bots.');
        s.results = []; s.totals = s.seats.map(() => 0);
        this.startRound(now);
        break;
      }
      case 'setHand': {
        if (s.phase !== 'arrange') fail('bad-phase', 'There is no hand to set right now.');
        if (s.subs[me]) fail('already-set', 'Your hand is already set for this round.');
        const set = { front: msg.front, middle: msg.middle, back: msg.back };
        const declareNatural = !!(msg.declareNatural && s.settings.naturals);
        if (!acceptSubmission({ round: s.round, set, declareNatural }, s.hands[me], s.round, s.settings)) {
          fail('bad-hand', 'That hand isn’t valid: use your 13 cards, Back > Middle > Front.');
        }
        s.subs[me] = { set, declareNatural, auto: false };
        this.maybeShowdown(now);
        break;
      }
      case 'nextRound': {
        if (!isHost) fail('not-host', 'Only the host deals the next round.');
        if (s.phase !== 'showdown') fail('bad-phase', 'Finish this round first.');
        this.startRound(now);
        break;
      }
      case 'leave': {
        this.removeHuman(me, now);
        out.left = true;
        break;
      }
      case 'kick': {
        if (!isHost) fail('not-host', 'Only the host can do that.');
        const seat = s.seats[msg.seat];
        if (!seat || seat.kind !== 'human' || seat.pid === pid) fail('bad-seat', 'Pick another player’s seat.');
        out.kicked.push(seat.pid);
        this.removeHuman(msg.seat, now);
        break;
      }
      case 'seatBot': {
        if (!isHost) fail('not-host', 'Only the host can do that.');
        if (s.phase === 'lobby') fail('bad-phase', 'Empty seats are filled with bots when the game starts.');
        const seat = s.seats[msg.seat];
        if (!seat || seat.kind !== 'human' || seat.connected) fail('bad-seat', 'Only a disconnected player’s seat can go to a bot.');
        out.kicked.push(seat.pid);
        this.toBot(msg.seat, now);
        break;
      }
      default:
        fail('bad-type', 'Unknown message type.');
    }
    this.touch(now);
    this.tick(now);
    return out;
  }

  fillBots() {
    const s = this.s;
    const used = new Set(s.seats.filter((x) => x.kind === 'bot').map((x) => x.name));
    for (const nm of BOT_NAMES) {
      if (s.seats.length >= MAX_SEATS) break;
      if (used.has(nm)) continue;
      s.seats.push({ pid: `bot_${nm}`, kind: 'bot', name: nm, token: null, connected: true, discAt: null });
    }
  }

  /** A human leaves (or is kicked): gone from the lobby; mid-game their seat goes to a bot. */
  removeHuman(i, now) {
    const s = this.s;
    const seat = s.seats[i];
    const heir = s.host === seat.pid ? this.nextHost(seat.pid, true) : s.host;
    if (s.phase === 'lobby') s.seats.splice(i, 1);
    else this.toBot(i, now);
    s.host = heir;
    if (!s.seats.some((x) => x.kind === 'human' && x.connected)) s.emptySince ??= now;
  }

  toBot(i, now) {
    const s = this.s;
    const seat = s.seats[i];
    const used = new Set(s.seats.filter((x) => x.kind === 'bot').map((x) => x.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot';
    const heir = s.host === seat.pid ? this.nextHost(seat.pid, true) : s.host;
    s.seats[i] = { pid: `bot_${name}`, kind: 'bot', name, token: null, connected: true, discAt: null, was: seat.name };
    s.host = heir;
    if (s.phase === 'arrange' && !s.subs[i]) {
      s.subs[i] = { ...autoSet(s.hands[i], s.settings), auto: true };
      this.maybeShowdown(now);
    }
  }

  /** The next human after `fromPid` in seat order: connected ones first, then (if allowed) anyone. */
  nextHost(fromPid, anyHuman = false) {
    const seats = this.s.seats;
    const at = seats.findIndex((x) => x.pid === fromPid);
    const order = (at < 0 ? seats : [...seats.slice(at + 1), ...seats.slice(0, at)])
      .filter((x) => x.kind === 'human' && x.pid !== fromPid);
    return (order.find((x) => x.connected) || (anyHuman ? order[0] : null))?.pid || null;
  }

  startRound(now) {
    const s = this.s;
    s.round += 1;
    s.phase = 'arrange';
    s.hands = deal(s.seats.length, this.random);
    s.subs = s.seats.map((x, i) => (x.kind === 'bot' ? { ...autoSet(s.hands[i], s.settings), auto: true } : null));
    s.deadline = now + this.turnMs;
    s.last = null;
    this.maybeShowdown(now);
  }

  /** Everyone is set: score with the engine, record the round, reveal. */
  maybeShowdown(now) {
    const s = this.s;
    if (s.phase !== 'arrange' || !s.subs.every(Boolean)) return false;
    const cfg = tableConfig(s.settings);
    const players = s.subs.map((sub, i) => preparePlayer(sub.set, cfg, { dealt: s.hands[i], declareNatural: sub.declareNatural }));
    const st = settle(players, cfg);
    const settlement = { net: st.net, dollars: st.dollars, pairs: st.pairs, zeroSum: st.zeroSum };
    s.results = [...s.results, { round: s.round, net: st.net.slice() }].slice(-LIMITS.KEEP_RESULTS);
    if (s.totals.length !== s.seats.length) s.totals = s.seats.map((_, i) => s.totals[i] || 0);
    s.totals = s.totals.map((t, i) => t + st.net[i]);
    s.last = {
      round: s.round,
      sets: s.subs.map((x) => x.set),
      declared: s.subs.map((x) => x.declareNatural),
      auto: s.subs.map((x) => x.auto),
      settlement: JSON.parse(JSON.stringify(settlement)),
    };
    s.phase = 'showdown';
    s.deadline = null;
    this.touch(now);
    return true;
  }

  // ----- time -----
  /** Run whatever is due: the turn timer, host hand-over, idle expiry. Returns { expired } (delete the table). */
  tick(now) {
    const s = this.s;
    if (s.phase === 'arrange' && s.deadline != null && now >= s.deadline) {
      s.subs = s.subs.map((sub, i) => sub || { ...autoSet(s.hands[i], s.settings), auto: true });
      this.maybeShowdown(now);
    }
    const host = s.seats.find((x) => x.pid === s.host);
    if (!host || host.kind !== 'human') {
      s.host = this.nextHost(s.host, true);
    } else if (!host.connected && host.discAt != null && now - host.discAt >= this.hostGraceMs) {
      const next = this.nextHost(host.pid, false);
      if (next) s.host = next;
    }
    const nobody = !s.seats.some((x) => x.kind === 'human' && x.connected);
    if (nobody) s.emptySince ??= now;
    return { expired: nobody && now - s.emptySince >= this.idleMs };
  }

  /** When tick() next has something to do (ms timestamp), or null. */
  nextWake() {
    const s = this.s;
    const t = [];
    if (s.phase === 'arrange' && s.deadline != null) t.push(s.deadline);
    const host = s.seats.find((x) => x.pid === s.host);
    if (host && host.kind === 'human' && !host.connected && host.discAt != null && this.nextHost(host.pid, false)) {
      t.push(host.discAt + this.hostGraceMs);
    }
    if (s.emptySince != null) t.push(s.emptySince + this.idleMs);
    return t.length ? Math.min(...t) : null;
  }

  // ----- what each player may see -----
  /**
   * The state message for player `pid`. Before the showdown it holds only that player's own cards and set hand;
   * other players' hands appear only in `showdown` once everyone is set.
   */
  snapshot(pid, now) {
    const s = this.s;
    const me = this.seatOf(pid);
    const inGame = s.phase !== 'lobby';
    const mine = me >= 0 && inGame ? s.subs[me] : null;
    return {
      type: 'state',
      code: s.code,
      now,
      phase: s.phase,
      round: s.round,
      you: me,
      host: this.seatOf(s.host),
      settings: { ...s.settings },
      turnMs: this.turnMs,
      deadline: s.phase === 'arrange' ? s.deadline : null,
      seats: s.seats.map((x, i) => ({
        name: x.name,
        kind: x.kind,
        connected: x.kind === 'bot' ? true : !!x.connected,
        ready: inGame ? !!s.subs[i] : false,
        was: x.was || null,
      })),
      results: s.results.map((r) => ({ round: r.round, net: r.net.slice() })),
      totals: inGame ? s.totals.slice() : [],
      hand: me >= 0 && inGame ? s.hands[me].slice() : null,
      submitted: mine ? { set: clone(mine.set), declareNatural: mine.declareNatural, auto: mine.auto } : null,
      showdown: s.phase === 'showdown' && s.last ? clone(s.last) : null,
    };
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
export { RoomError };
