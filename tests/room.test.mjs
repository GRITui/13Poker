import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Room, RoomError, RateLimiter, parseMessage, cleanName, randomCode, autoSet, LIMITS, BOT_NAMES,
} from '../worker/room.js';
import { CODE_ALPHABET, tableConfig } from '../js/online/table.js';
import { seededRng, arrangeHand, preparePlayer, settle, validateSet, parseCards as P } from '../js/engine/index.js';

const T0 = 1_000_000;
let idSeq = 0;
const opts = (extra = {}) => ({
  random: seededRng(42), randomId: (n) => `id${String(++idSeq).padStart(n > 20 ? 20 : n, '0')}`.slice(0, Math.max(n, 16)).padEnd(16, 'x'),
  ...extra,
});
const newRoom = (settings = {}, extra = {}) => Room.create('K7QM', settings, T0, opts(extra));
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof RoomError && e.code === code, `expected ${code}`);

/** A lobby with the given names joined; returns { room, p: [{pid, token}] }. */
function lobby(names = ['Alice', 'Bob', 'Cara'], settings = {}, extra = {}) {
  const room = newRoom(settings, extra);
  const p = names.map((name) => room.join({ name }, T0));
  return { room, p };
}
/** Start a game: 3 humans + 1 bot by default. */
function started(names, settings, extra) {
  const g = lobby(names, settings, extra);
  g.room.handle(g.p[0].pid, { type: 'start' }, T0 + 10);
  return g;
}
const setOf = (s) => ({ front: s.front, middle: s.middle, back: s.back });
const handMsg = (set, declareNatural = false) => ({ type: 'setHand', ...set, declareNatural });

// ---------- messages ----------
test('parseMessage: accepts each client type and keeps only known fields', () => {
  assert.deepEqual(parseMessage(JSON.stringify({ type: 'hello', name: 'Al', extra: 1 })).msg, { type: 'hello', name: 'Al', token: null });
  assert.equal(parseMessage(JSON.stringify({ type: 'hello', name: 'Al', token: 'abcdefghijklmnop' })).msg.token, 'abcdefghijklmnop');
  for (const type of ['start', 'nextRound', 'leave']) assert.deepEqual(parseMessage(JSON.stringify({ type, x: 1 })).msg, { type });
  assert.deepEqual(parseMessage(JSON.stringify({ type: 'kick', seat: 2 })).msg, { type: 'kick', seat: 2 });
  assert.equal(parseMessage(JSON.stringify({ type: 'setSettings', settings: { mode: 'wsgc' } })).ok, true);
  const hand = { type: 'setHand', front: P('2c 3d 4h'), middle: P('5c 6d 7h 8s 9c'), back: P('Tc Jd Qh Ks Ac') };
  assert.deepEqual(parseMessage(JSON.stringify(hand)).msg, { ...hand, declareNatural: false });
});

test('parseMessage: rejects bad input', () => {
  const code = (raw) => parseMessage(raw).error?.code;
  assert.equal(code(new ArrayBuffer(4)), 'bad-message');
  assert.equal(code('not json'), 'bad-message');
  assert.equal(code('[1,2]'), 'bad-type');
  assert.equal(code('{"type":"dealMeAces"}'), 'bad-type');
  assert.equal(code('{"type":"__proto__"}'), 'bad-type');
  assert.equal(code(JSON.stringify({ type: 'hello', name: 'x'.repeat(5000) })), 'too-large');
  assert.equal(code(JSON.stringify({ type: 'hello', name: 'é'.repeat(2100) })), 'too-large', 'limit is in bytes');
  assert.equal(code(JSON.stringify({ type: 'hello', name: 5 })), 'bad-name');
  assert.equal(code(JSON.stringify({ type: 'hello', name: 'a', token: 'short' })), 'bad-message');
  assert.equal(code(JSON.stringify({ type: 'hello', name: 'a', token: 'a/b'.repeat(8) })), 'bad-message');
  assert.equal(code(JSON.stringify({ type: 'kick', seat: 4 })), 'bad-message');
  assert.equal(code(JSON.stringify({ type: 'kick', seat: '1' })), 'bad-message');
  assert.equal(code(JSON.stringify({ type: 'setSettings', settings: [] })), 'bad-message');
  assert.equal(code(JSON.stringify({ type: 'setHand', front: P('2c 3d'), middle: P('5c 6d 7h 8s 9c'), back: P('Tc Jd Qh Ks Ac') })), 'bad-hand');
  assert.equal(code(JSON.stringify({ type: 'setHand', front: ['2c', '3d', 'Zz'], middle: P('5c 6d 7h 8s 9c'), back: P('Tc Jd Qh Ks Ac') })), 'bad-hand');
  assert.equal(code(JSON.stringify({ type: 'setHand', front: P('2c 3d 4h'), middle: P('5c 6d 7h 8s 9c'), back: P('Tc Jd Qh Ks Ac'), declareNatural: 'yes' })), 'bad-message');
});

test('cleanName strips control and invisible characters and limits length', () => {
  assert.equal(cleanName('  Alice  '), 'Alice');
  assert.equal(cleanName(`A${String.fromCharCode(0x202e)}li${String.fromCharCode(0x200b)}ce\n\tB`), 'Alice B');
  assert.equal(cleanName('x'.repeat(40)).length, LIMITS.NAME_MAX);
  assert.equal(cleanName(String.fromCharCode(0x200b, 0x00, 0x7f)), null);
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(42), null);
  assert.equal(cleanName('<img src=x>'), '<img src=x>', 'kept as text; the client escapes it on display');
});

test('rate limiter: bursts, then refills at the sustained rate', () => {
  const r = new RateLimiter(5, 10);
  let ok = 0;
  for (let i = 0; i < 30; i++) if (r.allow(T0)) ok++;
  assert.equal(ok, 10, 'burst size');
  assert.equal(r.dropped, 20);
  assert.equal(r.allow(T0 + 100), false, 'half a token after 100 ms');
  assert.equal(r.allow(T0 + 300), true, 'refilled');
  ok = 0;
  for (let t = 0; t < 10_000; t += 10) if (r.allow(T0 + 1000 + t)) ok++;
  assert.ok(ok >= 50 && ok <= 61, `about 5/s sustained over 10 s, got ${ok}`);
});

test('randomCode uses the unambiguous alphabet', () => {
  for (let i = 0; i < 300; i++) {
    const c = randomCode();
    assert.match(c, /^[A-Z2-9]{4}$/);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
  }
});

// ---------- seats and host ----------
test('join: first is host, names deduplicated, max 4, no joining after the start', () => {
  const room = newRoom();
  const a = room.join({ name: 'Alice' }, T0);
  const b = room.join({ name: 'alice' }, T0);
  assert.equal(room.s.host, a.pid);
  assert.equal(room.s.seats[1].name, 'alice 2');
  assert.notEqual(a.token, b.token);
  throwsCode(() => room.join({ name: String.fromCharCode(0x200b) }, T0), 'bad-name');
  room.join({ name: 'C' }, T0);
  room.join({ name: 'D' }, T0);
  throwsCode(() => room.join({ name: 'E' }, T0), 'full');
  const g = lobby(['A', 'B']);
  g.room.handle(g.p[0].pid, { type: 'start' }, T0);
  throwsCode(() => g.room.join({ name: 'Late' }, T0), 'started');
  throwsCode(() => g.room.join({ name: 'Late', token: 'notarealtokenatall' }, T0), 'started');
});

test('host-only actions and settings', () => {
  const { room, p } = lobby();
  throwsCode(() => room.handle(p[1].pid, { type: 'setSettings', settings: { mode: 'wsgc' } }, T0), 'not-host');
  throwsCode(() => room.handle(p[1].pid, { type: 'start' }, T0), 'not-host');
  throwsCode(() => room.handle(p[1].pid, { type: 'kick', seat: 2 }, T0), 'not-host');
  throwsCode(() => room.handle('p_stranger', { type: 'start' }, T0), 'not-seated');
  room.handle(p[0].pid, { type: 'setSettings', settings: { mode: 'wsgc', unitValue: 99, royalties: 'yes', naturals: true } }, T0);
  assert.equal(room.s.settings.mode, 'wsgc');
  assert.equal(room.s.settings.unitValue, 1, 'sanitized');
  assert.equal(room.s.settings.royalties, false, 'sanitized');
  assert.equal(room.s.settings.naturals, true);
  throwsCode(() => room.handle(p[0].pid, { type: 'kick', seat: 0 }, T0), 'bad-seat');
});

test('start: bots fill empty seats when asked; 2+ players needed', () => {
  const g = started();
  assert.deepEqual(g.room.s.seats.map((x) => x.kind), ['human', 'human', 'human', 'bot']);
  assert.equal(g.room.s.seats[3].name, BOT_NAMES[0]);
  assert.equal(g.room.phase, 'arrange');
  assert.equal(g.room.s.round, 1);
  assert.ok(g.room.s.subs[3], 'the bot is set at once');
  const solo = lobby(['Solo'], { fillBots: false });
  throwsCode(() => solo.room.handle(solo.p[0].pid, { type: 'start' }, T0), 'need-players');
  const duo = lobby(['A', 'B'], { fillBots: false });
  duo.room.handle(duo.p[0].pid, { type: 'start' }, T0);
  assert.equal(duo.room.s.seats.length, 2);
});

test('lobby: leaving and kicking free the seat; the host role passes on', () => {
  const { room, p } = lobby(['A', 'B', 'C']);
  room.handle(p[0].pid, { type: 'kick', seat: 2 }, T0);
  assert.deepEqual(room.s.seats.map((x) => x.name), ['A', 'B']);
  const out = room.handle(p[0].pid, { type: 'leave' }, T0);
  assert.equal(out.left, true);
  assert.deepEqual(room.s.seats.map((x) => x.name), ['B']);
  assert.equal(room.s.host, p[1].pid);
});

test('host migration: a disconnected host keeps the role for the grace period, then it passes on', () => {
  const { room, p } = started();
  room.disconnect(p[0].pid, T0 + 100);
  assert.equal(room.s.host, p[0].pid);
  assert.equal(room.nextWake(), Math.min(room.s.deadline, T0 + 100 + LIMITS.HOST_GRACE_MS));
  room.tick(T0 + 100 + LIMITS.HOST_GRACE_MS - 1);
  assert.equal(room.s.host, p[0].pid);
  room.tick(T0 + 100 + LIMITS.HOST_GRACE_MS);
  assert.equal(room.s.host, p[1].pid, 'next connected human in seat order');
  // the old host comes back: same seat, not host any more
  const back = room.join({ name: 'A', token: p[0].token }, T0 + 50_000);
  assert.equal(back.pid, p[0].pid);
  assert.equal(room.s.host, p[1].pid);
  // skips disconnected players
  room.disconnect(p[2].pid, T0 + 50_000);
  room.disconnect(p[1].pid, T0 + 60_000);
  room.tick(T0 + 60_000 + LIMITS.HOST_GRACE_MS);
  assert.equal(room.s.host, p[0].pid);
});

test('host leaving mid-game: seat goes to a bot, host passes at once', () => {
  const { room, p } = started();
  room.handle(p[0].pid, { type: 'leave' }, T0 + 20);
  assert.equal(room.s.host, p[1].pid);
  assert.equal(room.s.seats[0].kind, 'bot');
  assert.equal(room.s.seats[0].was, 'Alice');
  assert.ok(room.s.subs[0], 'the bot sets the hand it inherited');
  assert.deepEqual(room.s.hands[0].length, 13);
  throwsCode(() => room.join({ name: 'A', token: p[0].token }, T0), 'started');
  const snap = room.snapshot(p[1].pid, T0);
  assert.equal(snap.host, 1);
});

// ---------- secrecy ----------
function cardsIn(json) { return new Set((json.match(/"[2-9TJQKA][shdc]"/g) || []).map((q) => q.slice(1, -1))); }

test('deal secrecy: before the showdown a snapshot only holds your own cards', () => {
  const { room, p } = started();
  const hands = room.s.hands;
  assert.equal(new Set(hands.flat()).size, 52, 'four distinct hands from one deck');
  for (let k = 0; k < 3; k++) {
    const snap = room.snapshot(p[k].pid, T0);
    assert.deepEqual(snap.hand, hands[k]);
    assert.equal(snap.showdown, null);
    const seen = cardsIn(JSON.stringify(snap));
    for (const c of seen) assert.ok(hands[k].includes(c), `seat ${k} sees only its own cards, saw ${c}`);
  }
  // Alice sets her hand: Bob still sees nothing of hers (only that she is ready)
  const aliceSet = arrangeHand(hands[0]).set;
  room.handle(p[0].pid, handMsg(aliceSet), T0 + 5);
  const bob = room.snapshot(p[1].pid, T0 + 5);
  assert.equal(bob.seats[0].ready, true);
  for (const c of cardsIn(JSON.stringify(bob))) assert.ok(hands[1].includes(c));
  assert.deepEqual(room.snapshot(p[0].pid, T0).submitted.set, aliceSet);
  // the bot's set (decided at the deal) isn't visible either
  assert.equal(JSON.stringify(bob).includes(JSON.stringify(room.s.subs[3].set.back)), false);
  // spectators (no seat) see no cards at all
  assert.equal(cardsIn(JSON.stringify(room.snapshot('p_nobody', T0))).size, 0);
});

test('showdown reveals every set, identical for everyone', () => {
  const { room, p } = started();
  for (let k = 0; k < 3; k++) room.handle(p[k].pid, handMsg(arrangeHand(room.s.hands[k]).set), T0 + 5);
  assert.equal(room.phase, 'showdown');
  const snaps = p.map((x) => room.snapshot(x.pid, T0 + 6));
  for (const s of snaps) {
    assert.equal(s.showdown.sets.length, 4);
    assert.deepEqual(s.showdown, snaps[0].showdown);
    assert.deepEqual(s.totals, snaps[0].totals);
  }
  assert.equal(cardsIn(JSON.stringify(snaps[1].showdown)).size, 52);
});

// ---------- setHand validation ----------
test('setHand: exactly your dealt cards, not fouled, once per round', () => {
  const { room, p } = started();
  const mine = room.s.hands[1];
  const other = room.s.hands[2];
  const good = arrangeHand(mine).set;
  // someone else's cards
  throwsCode(() => room.handle(p[1].pid, handMsg(arrangeHand(other).set), T0), 'bad-hand');
  // one card swapped for a card you weren't dealt
  const stolen = { ...good, back: [...good.back.slice(0, 4), other[0]] };
  throwsCode(() => room.handle(p[1].pid, handMsg(stolen), T0), 'bad-hand');
  // duplicate card
  const dup = { ...good, front: [good.front[0], good.front[0], good.front[2]] };
  throwsCode(() => room.handle(p[1].pid, handMsg(dup), T0), 'bad-hand');
  // fouled: put the best row in front order reversed
  const fouled = { front: good.front, middle: good.back, back: good.middle };
  assert.equal(validateSet(fouled, { dealt: mine }).valid, false);
  throwsCode(() => room.handle(p[1].pid, handMsg(fouled), T0), 'bad-hand');
  throwsCode(() => room.handle(p[1].pid, handMsg(fouled, true), T0), 'bad-hand'); // naturals are off
  room.handle(p[1].pid, handMsg(good), T0);
  throwsCode(() => room.handle(p[1].pid, handMsg(good), T0), 'already-set');
  throwsCode(() => room.handle(p[0].pid, { type: 'nextRound' }, T0), 'bad-phase');
});

test('setHand: a fouled arrangement is accepted only with a natural the cards really hold', () => {
  const { room, p } = started(undefined, { naturals: true });
  // give seat 1 six pairs (+ a single), arranged so the rows are out of order
  const six = P('2c 2d 5c 5d 8c 8d Jc Jd Kc Kd Ac Ad 3h');
  const rest = room.s.hands.flat().filter((c) => !six.includes(c));
  room.s.hands = [rest.slice(0, 13), six, rest.slice(13, 26), rest.slice(26, 39)];
  room.s.subs = room.s.seats.map((x, i) => (x.kind === 'bot' ? { ...autoSet(room.s.hands[i], room.s.settings), auto: true } : null));
  const fouled = { front: P('Kc Kd 3h'), middle: P('Ac Ad 2c 2d 5c'), back: P('5d 8c 8d Jc Jd') };
  assert.equal(validateSet(fouled, { dealt: six }).valid, false);
  throwsCode(() => room.handle(p[1].pid, handMsg(fouled, false), T0), 'bad-hand');
  room.handle(p[1].pid, handMsg(fouled, true), T0);
  assert.equal(room.s.subs[1].declareNatural, true);
  // seat 2 has no natural: declaring one doesn't excuse a foul
  const h2 = room.s.hands[2];
  const g2 = arrangeHand(h2).set;
  throwsCode(() => room.handle(p[2].pid, handMsg({ front: g2.front, middle: g2.back, back: g2.middle }, true), T0), 'bad-hand');
});

// ---------- timer ----------
test('turn timer: late hands are auto-set with the AI when the deadline passes', () => {
  const turnMs = 5000;
  const { room, p } = started(undefined, {}, { turnMs });
  const start = T0 + 10;
  assert.equal(room.s.deadline, start + turnMs);
  assert.equal(room.nextWake(), start + turnMs);
  assert.equal(room.snapshot(p[0].pid, start).deadline, start + turnMs);
  room.handle(p[0].pid, handMsg(arrangeHand(room.s.hands[0]).set), start + 100);
  room.disconnect(p[2].pid, start + 200); // a disconnected player is auto-set too
  room.tick(start + turnMs - 1);
  assert.equal(room.phase, 'arrange');
  room.tick(start + turnMs);
  assert.equal(room.phase, 'showdown');
  const sd = room.snapshot(p[0].pid, start + turnMs).showdown;
  assert.deepEqual(sd.auto, [false, true, true, true]);
  assert.deepEqual(sd.sets[1], arrangeHand(room.s.hands[1]).set, 'deterministic AI arrangement');
  for (const s of sd.sets) assert.equal(validateSet(s).valid, true);
  assert.equal(room.snapshot(p[0].pid, start + turnMs).deadline, null);
});

// ---------- scoring ----------
test('scoring is exactly settle() on the revealed hands; totals add up and stay zero-sum', () => {
  const { room, p } = started(undefined, { mode: '1-6', royalties: true });
  let totals = [0, 0, 0, 0];
  for (let round = 1; round <= 4; round++) {
    // seat 1 always sets a deliberately weak (but valid) hand to vary the results
    for (let k = 0; k < 3; k++) {
      const set = arrangeHand(room.s.hands[k], k === 1 ? { weights: { front: 3, middle: 0.2, back: 0.2 } } : {}).set;
      room.handle(p[k].pid, handMsg(set), T0 + round * 1000);
    }
    assert.equal(room.phase, 'showdown');
    const sd = room.snapshot(p[0].pid, T0).showdown;
    const cfg = tableConfig(room.s.settings);
    const players = sd.sets.map((s, i) => preparePlayer(s, cfg, { dealt: room.s.hands[i], declareNatural: sd.declared[i] }));
    const ref = settle(players, cfg);
    assert.deepEqual(sd.settlement.net, ref.net);
    assert.deepEqual(sd.settlement.pairs, JSON.parse(JSON.stringify(ref.pairs)));
    assert.equal(ref.net.reduce((a, b) => a + b, 0), 0);
    totals = totals.map((t, i) => t + ref.net[i]);
    const snap = room.snapshot(p[2].pid, T0);
    assert.deepEqual(snap.totals, totals);
    assert.equal(snap.results.length, round);
    assert.equal(snap.totals.reduce((a, b) => a + b, 0), 0);
    room.handle(p[0].pid, { type: 'nextRound' }, T0 + round * 1000 + 500);
    assert.equal(room.s.round, round + 1);
  }
  throwsCode(() => room.handle(p[0].pid, { type: 'nextRound' }, T0), 'bad-phase');
});

test('nextRound: host only, deals fresh cards', () => {
  const { room, p } = started();
  const first = room.s.hands.map((h) => h.join());
  room.tick(room.s.deadline);
  throwsCode(() => room.handle(p[1].pid, { type: 'nextRound' }, T0), 'not-host');
  room.handle(p[0].pid, { type: 'nextRound' }, T0 + 200_000);
  assert.equal(room.phase, 'arrange');
  assert.equal(room.s.round, 2);
  assert.notDeepEqual(room.s.hands.map((h) => h.join()), first);
  assert.equal(room.snapshot(p[0].pid, T0).submitted, null);
});

// ---------- reconnect ----------
test('reconnect by token: same seat, same hand, same set hand', () => {
  const { room, p } = started();
  const set = arrangeHand(room.s.hands[1]).set;
  room.handle(p[1].pid, handMsg(set), T0 + 50);
  const before = room.snapshot(p[1].pid, T0 + 50);
  room.disconnect(p[1].pid, T0 + 60);
  assert.equal(room.snapshot(p[0].pid, T0 + 60).seats[1].connected, false);
  const again = room.join({ name: 'Whatever', token: p[1].token }, T0 + 70);
  assert.deepEqual(again, { pid: p[1].pid, token: p[1].token, rejoined: true });
  const after = room.snapshot(p[1].pid, T0 + 70);
  assert.deepEqual(after.hand, before.hand);
  assert.deepEqual(after.submitted, before.submitted);
  assert.equal(after.seats[1].name, 'Bob', 'keeps the seat name');
  assert.equal(after.seats[1].connected, true);
  // restored from storage (JSON round trip) the room carries on the same way
  const copy = Room.restore(JSON.parse(JSON.stringify(room.toJSON())), opts());
  assert.deepEqual(copy.snapshot(p[1].pid, T0), room.snapshot(p[1].pid, T0));
  copy.reconcile([p[0].pid], T0 + 80); // only Alice's socket survived a restart
  assert.deepEqual(copy.snapshot(p[0].pid, T0).seats.map((x) => x.connected), [true, false, false, true]);
});

test('seatBot: the host can give a disconnected player’s seat to a bot', () => {
  const { room, p } = started();
  throwsCode(() => room.handle(p[0].pid, { type: 'seatBot', seat: 1 }, T0), 'bad-seat');
  room.disconnect(p[1].pid, T0 + 5);
  const out = room.handle(p[0].pid, { type: 'seatBot', seat: 1 }, T0 + 6);
  assert.deepEqual(out.kicked, [p[1].pid]);
  assert.equal(room.s.seats[1].kind, 'bot');
  assert.ok(room.s.subs[1].auto);
  assert.notEqual(room.s.seats[1].name, room.s.seats[3].name);
});

test('idle tables expire an hour after the last player disconnects', () => {
  const fresh = newRoom();
  assert.equal(fresh.nextWake(), T0 + LIMITS.IDLE_MS, 'a table nobody joined');
  const { room, p } = started();
  for (const x of p) room.disconnect(x.pid, T0 + 1000);
  room.tick(room.s.deadline); // the timer still finishes the round
  assert.equal(room.phase, 'showdown');
  assert.equal(room.tick(T0 + 1000 + LIMITS.IDLE_MS - 1).expired, false);
  assert.equal(room.nextWake(), T0 + 1000 + LIMITS.IDLE_MS);
  room.join({ name: 'x', token: p[2].token }, T0 + 2000);
  assert.equal(room.tick(T0 + 1000 + LIMITS.IDLE_MS).expired, false, 'someone came back');
  room.disconnect(p[2].pid, T0 + 3000);
  assert.equal(room.tick(T0 + 3000 + LIMITS.IDLE_MS).expired, true);
});
