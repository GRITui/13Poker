import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCards as P, validateSet, preparePlayer, scorePair, settle, pairFor, makeConfig, deal, seededRng,
  arrangeHand, DEFAULT_ROYALTIES,
} from '../js/engine/index.js';

const set = (f, m, b) => ({ front: P(f), middle: P(m), back: P(b) });
const prep = (s, cfg) => preparePlayer(s, cfg);
const MODES = ['wsgc', '1-6', '2-4'];
const R16 = { mode: '1-6', royalties: DEFAULT_ROYALTIES };

const A = set('Qd Qc 3h', 'Ah Kh 8h 6h 2h', '9s 9h 9d 4c 4s');
const B = set('Ad Kc 7d', 'Ks Kd 5s 5d 2c', '7c 8c 9c Tc Jc');
const C = set('Js Jd 4c', 'Ts Td Th 6s 6d', '2s 2d 2c 2h 5c');
const D = set('Jh Jc 4d', '8s 8d 7c 7h 3d', 'Ah Ad Kc Ks 9h');
const E = set('Qh Qs 4d', '8s 8d 8c 4h 3d', 'Ah Ad Kc Ks 9h');

test('validation: worked-example hands', () => {
  for (const s of [A, B, C, D]) assert.equal(validateSet(s).valid, true);
  const v = validateSet(E);
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, 'order-back');
});

test('validation: counts, duplicates, dealt cards', () => {
  assert.equal(validateSet({ front: P('As Ks'), middle: [], back: [] }).valid, false);
  assert.equal(validateSet(set('Qd Qc 3h', 'Ah Kh 8h 6h 2h', '9s 9h 9d 4c Qd')).errors[0].code, 'duplicate');
  const dealt = [...A.front, ...A.middle, ...A.back];
  assert.equal(validateSet(A, { dealt }).valid, true);
  assert.equal(validateSet(A, { dealt: [...dealt.slice(0, 12), 'Ts'] }).valid, false);
});

test('validation: front vs middle foul (Example 4 last row)', () => {
  const s = set('Kd Kc Qs', 'Kh Ks Jd 9c 8h', 'Ah Ad Ac 2s 2d');
  const v = validateSet(s);
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, 'order-middle');
  // Valid: Kx Kx 9x vs Kx Kx Qx 7x 2x
  assert.equal(validateSet(set('Kd Kc 9s', 'Kh Ks Qd 7c 2h', 'Ah Ad Ac 3s 3d')).valid, true);
  // Equal-as-far-as-keys: middle has more kickers -> valid
  assert.equal(validateSet(set('Kd Qc Jh', 'Ks Qs Jd 5c 3h', 'Ah Ad Ac 2s 2d')).valid, true);
});

test('allowEqualRows true/false with exactly tied Back and Middle (C8)', () => {
  const s = set('Qd 8c 2h', 'Ah Kc 9d 7s 3c', 'As Kd 9c 7h 3s');
  assert.equal(validateSet(s).valid, false);
  assert.equal(validateSet(s, { allowEqualRows: false }).errors[0].code, 'order-back');
  assert.equal(validateSet(s, { allowEqualRows: true }).valid, true);
});

test('Example 1: split 2-1 in all modes + royalties', () => {
  const expect = { wsgc: 1, '1-6': 1, '2-4': 2 };
  for (const mode of MODES) {
    const d = scorePair(prep(A), prep(B), { mode });
    assert.equal(d.points, expect[mode], mode);
    assert.deepEqual(d.rows, { front: 1, middle: 1, back: -1 });
  }
  assert.equal(scorePair(prep(A), prep(B), R16).points, -4);
  assert.equal(scorePair(prep(B), prep(A), R16).points, 4);
});

test('Example 2: tied front, no scoop', () => {
  const expect = { wsgc: 2, '1-6': 2, '2-4': 3 };
  for (const mode of MODES) {
    const d = scorePair(prep(C), prep(D), { mode });
    assert.equal(d.points, expect[mode], mode);
    assert.equal(d.rows.front, 0);
    assert.equal(d.scoop, null);
  }
  assert.equal(scorePair(prep(C), prep(D), R16).points, 8);
});

test('Example 3: fouled hand vs valid, and vs fouled, in all modes', () => {
  const expect = { wsgc: 3, '1-6': 6, '2-4': 4 };
  const e = prep(E);
  assert.equal(e.fouled, true);
  for (const mode of MODES) {
    assert.equal(scorePair(prep(D), e, { mode }).points, expect[mode], mode);
    assert.equal(scorePair(e, prep(D), { mode }).points, -expect[mode], mode);
    assert.equal(scorePair(e, prep(E), { mode }).points, 0, mode);
  }
  // With royalties: add F's royalties; E gets 0. C has quads back (4) + FH middle (2).
  assert.equal(scorePair(prep(C), e, R16).points, 6 + 6);
  assert.equal(scorePair(prep(C), e, { ...R16, royaltyRequiresRowWin: true }).points, 12);
});

test('scoop bonus in 1-6 and 2-4', () => {
  // C scoops B? B front A-high vs C JJ: C wins; mid FH vs two pair: C; back quads vs SF: B. Not a scoop.
  const strong = set('Ks Kh 2d', 'Qs Qh Qd 3c 3s', 'As Ah Ac Ad 4h');
  const weak = set('7c 5d 3h', 'Jd Jc 8h 6s 4d', 'Tc Td 9c 9d 2s');
  const s = prep(strong); const w = prep(weak);
  assert.equal(scorePair(s, w, { mode: 'wsgc' }).points, 3);
  assert.equal(scorePair(s, w, { mode: '1-6' }).points, 6);
  assert.equal(scorePair(s, w, { mode: '2-4' }).points, 4);
  assert.equal(scorePair(w, s, { mode: '1-6' }).points, -6);
});

test('2-4: one tie and a 1-1 split earns no overall bonus', () => {
  const a = set('Js Jd 4c', '8h 8c 7d 7s 2h', 'Ts Td Th 6s 6d');
  const b = set('Jh Jc 4d', '8s 8d 7c 7h 3d', 'Ah Ad Kc Ks 9h');
  const d = scorePair(prep(a, {}), prep(b), { mode: '2-4' });
  assert.deepEqual(d.rows, { front: 0, middle: -1, back: 1 });
  assert.equal(d.points, 0);
});

test('pairFor flips perspective', () => {
  const st = settle([prep(A), prep(B)], { mode: '2-4' });
  assert.equal(pairFor(st, 0, 1).points, 2);
  assert.equal(pairFor(st, 1, 0).points, -2);
  assert.deepEqual(pairFor(st, 1, 0).rows, { front: -1, middle: -1, back: 1 });
});

test('Example 5 style settlement is zero-sum; dollars use unitValue', () => {
  const st = settle([prep(A), prep(B), prep(C), prep(D), ].slice(0, 3), { mode: '1-6', unitValue: 5 });
  assert.equal(st.net.reduce((s, x) => s + x, 0), 0);
  assert.deepEqual(st.dollars, st.net.map((n) => n * 5));
  // Example 5 nets from the pairwise table
  const net = [1 - 6, -1 + 0, 6 + 0];
  assert.equal(net.reduce((s, x) => s + x, 0), 0);
  assert.deepEqual(net.map((n) => n * 5), [-25, -5, 30]);
});

test('unitValue > 10 is rejected [A9]; bad mode rejected', () => {
  assert.throws(() => makeConfig({ unitValue: 11 }));
  assert.throws(() => makeConfig({ unitValue: 0 }));
  assert.throws(() => makeConfig({ mode: '3-3' }));
  assert.equal(makeConfig({ unitValue: 10 }).unitValue, 10);
  assert.equal(makeConfig().mode, 'wsgc');
});

test('zero-sum over random deals with 2, 3 and 4 players, all modes, with fouls and royalties', () => {
  const rng = seededRng(7);
  for (let n = 2; n <= 4; n++) {
    for (let t = 0; t < 25; t++) {
      const hands = deal(n, rng);
      // Make some hands fouled on purpose: raw deal order is usually invalid.
      const sets = hands.map((h, i) => (i % 2 && t % 3 === 0
        ? { front: h.slice(0, 3), middle: h.slice(3, 8), back: h.slice(8) }
        : arrangeHand(h).set));
      for (const cfg of [{ mode: 'wsgc' }, { mode: '1-6' }, { mode: '2-4' }, { mode: '1-6', royalties: true }, { mode: '2-4', naturals: true }]) {
        const players = sets.map((s, i) => preparePlayer(s, cfg, { dealt: hands[i] }));
        const st = settle(players, cfg);
        assert.equal(st.net.reduce((s, x) => s + x, 0), 0);
        assert.equal(st.pairs.length, (n * (n - 1)) / 2);
      }
    }
  }
});
