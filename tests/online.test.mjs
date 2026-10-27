import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_ALPHABET, makeCode, normalizeCode, sanitizeTable, sanitizePlayer, sanitizeSettings, foldSeats, sameSeats,
  startingSeats, replaceWithBots, roundHands, botSet, acceptSubmission, seatStatus, scoreRound, appendResult,
  totalsOf, rotation, rotateSettlement, DEFAULT_TABLE_SETTINGS,
} from '../js/online/table.js';
import { seededRng, arrangeHand, validateSet, pairFor, parseCards as P } from '../js/engine/index.js';

const HOST = 'u_host';
const lobby = (extra = {}) => ({
  code: 'K7QM', host: HOST, phase: 'lobby', round: 0, seed: 0, createdAt: 1,
  seats: [{ id: HOST, kind: 'human' }], settings: { mode: '1-6' }, results: [], ...extra,
});
const playing = (extra = {}) => lobby({
  phase: 'arrange', round: 1, seed: 12345,
  seats: [{ id: HOST, kind: 'human' }, { id: 'u_b', kind: 'human' }, { id: 'u_c', kind: 'human' }, { id: 'bot-0', kind: 'bot' }],
  ...extra,
});
const player = (id, extra = {}) => sanitizePlayer({ table: 'K7QM', joinedAt: 10, ...extra }, id);

test('codes: alphabet has no look-alikes, makeCode and normalizeCode', () => {
  for (const ch of 'IL O01') assert.equal(CODE_ALPHABET.includes(ch), false);
  const rng = seededRng(7);
  for (let i = 0; i < 200; i++) {
    const c = makeCode(rng);
    assert.equal(c.length, 4);
    assert.equal(normalizeCode(c), c);
  }
  assert.equal(normalizeCode(' k7-qm '), 'K7QM');
  assert.equal(normalizeCode('K7Q'), null);
  assert.equal(normalizeCode('K7QO'), null); // O is not in the alphabet
  assert.equal(normalizeCode(42), null);
});

test('sanitizeTable accepts a good doc and rejects damaged ones', () => {
  const t = sanitizeTable(lobby(), HOST);
  assert.equal(t.code, 'K7QM');
  assert.equal(t.settings.mode, '1-6');
  assert.deepEqual(t.results, []);
  assert.equal(sanitizeTable(lobby(), 'u_other'), null, 'doc id must be the host');
  assert.equal(sanitizeTable(lobby({ code: 'k7qm' }), HOST), null);
  assert.equal(sanitizeTable(lobby({ phase: 'party' }), HOST), null);
  assert.equal(sanitizeTable(lobby({ seats: [] }), HOST), null);
  assert.equal(sanitizeTable(lobby({ seats: [{ id: 'u_b', kind: 'human' }] }), HOST), null, 'host sits first');
  assert.equal(sanitizeTable(lobby({ seats: [{ id: HOST, kind: 'human' }, { id: HOST, kind: 'human' }] }), HOST), null);
  assert.equal(sanitizeTable(lobby({ seats: [{ id: HOST, kind: 'human' }, { id: 'bot-9', kind: 'bot' }] }), HOST), null);
  assert.equal(sanitizeTable(lobby({ seats: [{ id: HOST, kind: 'human' }, { id: 'a/b', kind: 'human' }] }), HOST), null);
  assert.equal(sanitizeTable(playing({ seats: [{ id: HOST, kind: 'human' }] }), HOST), null, 'a game needs 2+ seats');
  assert.equal(sanitizeTable(playing({ seed: 0 }), HOST), null);
  assert.equal(sanitizeTable(null, HOST), null);
  assert.equal(sanitizeTable('x', HOST), null);
});

test('sanitizeTable cleans settings and results', () => {
  const t = sanitizeTable(playing({
    round: 3,
    settings: { mode: 'evil', unitValue: 99, royalties: 'yes', naturals: true },
    results: [
      { round: 1, net: [6, -2, -2, -2] },
      { round: 1, net: [0, 0, 0, 0] }, // duplicate round
      { round: 2, net: [1, 1, 1, 1] }, // not zero-sum
      { round: 2, net: [1, -1] }, // wrong length
      { round: 5, net: [1, -1, 0, 0] }, // future round
      { round: 2, net: [3, -3, 0, 0] },
      'junk',
    ],
  }), HOST);
  assert.deepEqual(t.settings, { ...DEFAULT_TABLE_SETTINGS, naturals: true });
  assert.deepEqual(t.results, [{ round: 1, net: [6, -2, -2, -2] }, { round: 2, net: [3, -3, 0, 0] }]);
  assert.deepEqual(totalsOf(t.results, 4), [9, -5, -2, -2]);
  assert.deepEqual(sanitizeSettings(undefined), { ...DEFAULT_TABLE_SETTINGS });
});

test('sanitizePlayer keeps only well-formed submissions', () => {
  const ok = player('u_b', { round: 2, front: ['As', 'Kd', '2c'], middle: ['3c', '4c', '5c', '6c', '8d'], back: ['9h', '9d', '9c', '9s', 'Th'] });
  assert.equal(ok.table, 'K7QM');
  assert.equal(ok.sub.round, 2);
  assert.equal(ok.sub.declareNatural, false);
  assert.equal(player('u_b', { round: 2, front: ['As', 'Kd'], middle: [], back: [] }).sub, null);
  assert.equal(player('u_b', { round: 2, front: ['As', 'Kd', 'Xx'], middle: ['3c', '4c', '5c', '6c', '8d'], back: ['9h', '9d', '9c', '9s', 'Th'] }).sub, null);
  assert.equal(sanitizePlayer({ table: 'nope' }, 'u_b'), null);
  assert.equal(sanitizePlayer({ table: 'K7QM' }, 'bad/id'), null);
});

test('foldSeats: host first, keeps order, adds newcomers by join time, max 4, drops leavers', () => {
  const seats = [{ id: HOST, kind: 'human' }];
  const ps = [player(HOST, { joinedAt: 1 }), player('u_c', { joinedAt: 30 }), player('u_b', { joinedAt: 20 })];
  const f1 = foldSeats(seats, ps, HOST);
  assert.deepEqual(f1.map((s) => s.id), [HOST, 'u_b', 'u_c']);
  // more joiners than seats
  const f2 = foldSeats(f1, [...ps, player('u_e', { joinedAt: 50 }), player('u_d', { joinedAt: 40 })], HOST);
  assert.deepEqual(f2.map((s) => s.id), [HOST, 'u_b', 'u_c', 'u_d']);
  // u_b leaves: u_e gets the free seat, existing order kept
  const f3 = foldSeats(f2, [ps[0], ps[1], player('u_d', { joinedAt: 40 }), player('u_e', { joinedAt: 50 })], HOST);
  assert.deepEqual(f3.map((s) => s.id), [HOST, 'u_c', 'u_d', 'u_e']);
  assert.equal(sameSeats(f3, foldSeats(f3, [ps[0], ps[1], player('u_d'), player('u_e')], HOST)), true);
  // host is seated even without a player doc
  assert.deepEqual(foldSeats(seats, [], HOST), seats);
});

test('startingSeats and replaceWithBots', () => {
  const humans = [{ id: HOST, kind: 'human' }, { id: 'u_b', kind: 'human' }];
  assert.deepEqual(startingSeats(humans, false).map((s) => s.id), [HOST, 'u_b']);
  assert.deepEqual(startingSeats(humans, true).map((s) => s.id), [HOST, 'u_b', 'bot-0', 'bot-1']);
  const seats = startingSeats([...humans, { id: 'u_c', kind: 'human' }], true);
  assert.deepEqual(replaceWithBots(seats, ['u_b']).map((s) => s.id), [HOST, 'bot-1', 'u_c', 'bot-0']);
});

test('deals are deterministic and disjoint; bots are deterministic', () => {
  const a = roundHands(12345, 3, 4);
  const b = roundHands(12345, 3, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, roundHands(12345, 4, 4));
  assert.equal(new Set(a.flat()).size, 52);
  const s = sanitizeSettings({});
  assert.deepEqual(botSet(a[3], 12345, 3, 3, s), botSet(a[3], 12345, 3, 3, s));
  assert.equal(validateSet(botSet(a[3], 12345, 3, 3, s).set, { dealt: a[3] }).valid, true);
});

test('acceptSubmission: right round, dealt cards, no foul (unless a real natural is declared)', () => {
  const t = sanitizeTable(playing(), HOST);
  const hands = roundHands(t.seed, 1, 4);
  const good = { round: 1, set: arrangeHand(hands[1]).set, declareNatural: false };
  assert.equal(acceptSubmission(good, hands[1], 1, t.settings), true);
  assert.equal(acceptSubmission({ ...good, round: 2 }, hands[1], 1, t.settings), false);
  assert.equal(acceptSubmission(good, hands[2], 1, t.settings), false, 'someone else\'s cards');
  const fouled = { round: 1, set: { front: good.set.front, middle: good.set.back, back: good.set.middle }, declareNatural: false };
  assert.equal(validateSet(fouled.set, { dealt: hands[1] }).valid, false);
  assert.equal(acceptSubmission(fouled, hands[1], 1, t.settings), false);
  // A fouled hand declaring a natural it doesn't have is still rejected.
  assert.equal(acceptSubmission({ ...fouled, declareNatural: true }, hands[1], 1, { ...t.settings, naturals: true }), false);
});

test('seatStatus and scoreRound: everyone sees the same result, zero-sum, rotation', () => {
  const t = sanitizeTable(playing(), HOST);
  const hands = roundHands(t.seed, 1, 4);
  const sub = (i) => ({ round: 1, front: arrangeHand(hands[i]).set.front, middle: arrangeHand(hands[i]).set.middle, back: arrangeHand(hands[i]).set.back });
  const ps = [player(HOST, sub(0)), player('u_b', sub(1))];
  let st = seatStatus(t, ps);
  assert.deepEqual(st.map((s) => s.ready), [true, true, false, true]);
  assert.equal(scoreRound(t, ps), null);
  ps.push(player('u_c', sub(2)));
  st = seatStatus(t, ps);
  assert.deepEqual(st.map((s) => s.ready), [true, true, true, true]);
  const r1 = scoreRound(t, ps);
  const r2 = scoreRound(t, new Map(ps.slice().reverse().map((p) => [p.id, p])));
  assert.deepEqual(r1.settlement.net, r2.settlement.net);
  assert.equal(r1.settlement.net.reduce((a, x) => a + x, 0), 0);
  // A player who left is not ready (and not "here").
  const gone = seatStatus(t, ps.filter((p) => p.id !== 'u_c'));
  assert.equal(gone[2].here, false);
  // rotation: seat 2 sees itself first
  const order = rotation(4, 2);
  assert.deepEqual(order, [2, 3, 0, 1]);
  const rot = rotateSettlement(r1.settlement, order);
  assert.deepEqual(rot.net, order.map((s) => r1.settlement.net[s]));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i !== j) assert.equal(pairFor(rot, i, j).points, pairFor(r1.settlement, order[i], order[j]).points);
    }
  }
});

test('appendResult is idempotent per round', () => {
  let r = appendResult([], 1, [3, -3]);
  r = appendResult(r, 1, [9, -9]);
  r = appendResult(r, 2, [-1, 1]);
  assert.deepEqual(r, [{ round: 1, net: [3, -3] }, { round: 2, net: [-1, 1] }]);
  assert.deepEqual(totalsOf(r, 2), [2, -2]);
});

test('declared natural with a fouled arrangement is accepted when the natural is real', () => {
  // Six pairs + one card, arranged so that it fouls.
  const hand = P('2s 2h 3s 3h 4s 4h 5s 5h 6s 6h 7s 7h As');
  const settings = sanitizeSettings({ naturals: true });
  const fouled = { round: 1, set: { front: P('7s 7h As'), middle: P('4h 5s 5h 6s 6h'), back: P('2s 2h 3s 3h 4s') }, declareNatural: true };
  assert.equal(acceptSubmission(fouled, hand, 1, settings), true);
  assert.equal(acceptSubmission({ ...fouled, declareNatural: false }, hand, 1, settings), false);
  assert.equal(acceptSubmission(fouled, hand, 1, sanitizeSettings({ naturals: false })), false);
});
