import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards as P, evaluate, evaluate3, evaluate5, compare, compareCards, CAT, handName } from '../js/engine/index.js';

const ev = (s, o) => evaluate(P(s), o);
const cmp = (a, b, o) => compareCards(P(a), P(b), o);

test('5-card categories (C2)', () => {
  const cases = [
    ['Ts Js Qs Ks As', CAT.STRAIGHT_FLUSH, [14]],
    ['9h Th Jh Qh Kh', CAT.STRAIGHT_FLUSH, [13]],
    ['Ad 2d 3d 4d 5d', CAT.STRAIGHT_FLUSH, [5]],
    ['2s 2d 2c 2h 5c', CAT.QUADS, [2, 5]],
    ['9s 9h 9d 4c 4s', CAT.FULL_HOUSE, [9, 4]],
    ['Ah Kh 8h 6h 2h', CAT.FLUSH, [14, 13, 8, 6, 2]],
    ['7c 8d 9c Th Jc', CAT.STRAIGHT, [11]],
    ['As 2d 3c 4h 5s', CAT.STRAIGHT, [5]],
    ['8s 8d 8c 4h 3d', CAT.TRIPS, [8, 4, 3]],
    ['Ks Kd 5s 5d 2c', CAT.TWO_PAIR, [13, 5, 2]],
    ['Qs 7h Qd 3c 9c', CAT.PAIR, [12, 9, 7, 3]],
    ['Ad Kc 7d 4s 2h', CAT.HIGH_CARD, [14, 13, 7, 4, 2]],
  ];
  for (const [s, cat, key] of cases) {
    const e = ev(s);
    assert.equal(e.cat, cat, s);
    assert.deepEqual(e.key, key, s);
  }
});

test('no wrap-around straight: Q-K-A-2-3 is high card', () => {
  assert.equal(ev('Qs Kd Ac 2h 3s').cat, CAT.HIGH_CARD);
});

test('royal flush named', () => {
  assert.equal(handName(ev('Ts Js Qs Ks As')), 'Royal flush');
  assert.equal(handName(ev('Qd Qc 3h')), 'Pair of Queens');
  assert.equal(handName(ev('9s 9h 9d 4c 4s')), 'Full house, Nines over Fours');
});

test('3-card categories (C3): straights and flushes do not count [A8]', () => {
  assert.deepEqual(evaluate3(P('7h 8h 9h')), { cat: CAT.HIGH_CARD, key: [9, 8, 7], size: 3 });
  assert.equal(ev('2h 3h 4h').cat, CAT.HIGH_CARD);
  assert.deepEqual(ev('Qd Qc 3h').key, [12, 3]);
  assert.equal(ev('Qd Qc 3h').cat, CAT.PAIR);
  assert.deepEqual(ev('5d 5c 5h'), { cat: CAT.TRIPS, key: [5], size: 3 });
  assert.equal(ev('Ad Kc 7d').cat, CAT.HIGH_CARD);
});

test('category ordering', () => {
  const order = ['Ad Kc 7d 4s 2h', 'Qs 7h Qd 3c 9c', 'Ks Kd 5s 5d 2c', '8s 8d 8c 4h 3d', '7c 8d 9c Th Jc',
    'Ah Kh 8h 6h 2h', '9s 9h 9d 4c 4s', '2s 2d 2c 2h 5c', '9h Th Jh Qh Kh'];
  for (let i = 1; i < order.length; i++) assert.equal(cmp(order[i], order[i - 1]), 1, order[i]);
});

test('tie-breaks at every key position', () => {
  // High card, position 0..4
  assert.equal(cmp('Ad Kc 7d 4s 2h', 'Kd Qc 7c 4h 2c'), 1);
  assert.equal(cmp('Ad Kc 7d 4s 2h', 'Ac Qc 7c 4h 2c'), 1);
  assert.equal(cmp('Ad Kc 8d 4s 2h', 'Ac Kd 7c 4h 2c'), 1);
  assert.equal(cmp('Ad Kc 8d 5s 2h', 'Ac Kd 8c 4h 2c'), 1);
  assert.equal(cmp('Ad Kc 8d 5s 3h', 'Ac Kd 8c 5h 2c'), 1);
  // Pair: pair rank, then kickers
  assert.equal(cmp('Js Jd 4c 3h 2s', 'Ts Td Ac Kh Qs'), 1);
  assert.equal(cmp('Js Jd Ac 3h 2s', 'Jh Jc Kc Qh Ts'), 1);
  assert.equal(cmp('Js Jd Ac Kh 3s', 'Jh Jc Ad Kd 2s'), 1);
  // Two pair: high pair, low pair, kicker
  assert.equal(cmp('Ks Kd 3s 3d 2c', 'Qs Qd Js Jd Ac'), 1);
  assert.equal(cmp('Ks Kd 4s 4d 2c', 'Kh Kc 3h 3c Ac'), 1);
  assert.equal(cmp('Qs Qh 8d 8c Ac', 'Qd Qc 8s 8h Kd'), 1);
  // Trips: trips rank then kickers
  assert.equal(cmp('8s 8d 8c 4h 3d', '7s 7d 7c Ah Kd'), 1);
  // Full house: trips first
  assert.equal(cmp('9s 9h 9d 2c 2s', '8s 8h 8d Ac As'), 1);
  // Flush: all five cards
  assert.equal(cmp('Ah Kh 9h 5h 3h', 'As Ks 9s 5s 2s'), 1);
  // Quads kicker (completeness)
  assert.equal(compare({ cat: CAT.QUADS, key: [9, 5] }, { cat: CAT.QUADS, key: [9, 4] }), 1);
  // Front: pair kicker, high cards
  assert.equal(cmp('Qd Qc 4h', 'Qh Qs 3d'), 1);
  assert.equal(cmp('Kd 9c 3h', 'Kh 9s 2d'), 1);
});

test('exact ties ignore suits (B6)', () => {
  assert.equal(cmp('Ah Kh 9h 5h 3h', 'Ad Kd 9d 5d 3d'), 0);
  assert.equal(cmp('Js Jd 4c', 'Jh Jc 4d'), 0);
  assert.equal(cmp('As Kd 9c 7h 3s', 'Ah Kc 9d 7s 3c'), 0);
});

test('wheel is the lowest straight; wheelRank "second" option', () => {
  assert.equal(cmp('As 2d 3c 4h 5s', '2c 3d 4s 5h 6c'), -1);
  assert.equal(cmp('As 2d 3c 4h 5s', 'Ts Jd Qc Kh Ad'), -1);
  assert.equal(cmp('As 2d 3c 4h 5s', 'Ks Kd Kc 4h 2d'), 1); // still a straight
  const o = { wheelRank: 'second' };
  assert.equal(cmp('As 2d 3c 4h 5s', '9s Td Jc Qh Kd', o), 1);
  assert.equal(cmp('As 2d 3c 4h 5s', 'Ts Jd Qc Kh Ad', o), -1);
});

test('RULES.md Example 4 tie-break edge cases', () => {
  assert.equal(cmp('As 2d 3c 4h 5s', '2c 3d 4s 5h 6c'), -1);
  assert.equal(cmp('Ts Js Qs Ks As', '9h Th Jh Qh Kh'), 1);
  assert.equal(cmp('Ah Kh 9h 5h 3h', 'As Ks 9s 5s 2s'), 1);
  assert.equal(cmp('Ah Kh 9h 5h 3h', 'Ad Kd 9d 5d 3d'), 0);
  assert.equal(cmp('Qs Qh 8d 8c Ac', 'Qd Qc 8s 8h Kd'), 1);
  assert.equal(cmp('2h 3h 4h', 'As Kd 5c'), -1);
  // Front Kd Kc Qs higher than Middle Kh Ks Jd 9c 8h -> foul
  assert.equal(cmp('Kd Kc Qs', 'Kh Ks Jd 9c 8h'), 1);
});

test('front vs middle comparison (C4)', () => {
  assert.equal(cmp('Kh Ks Qd 7c 2h', 'Kd Kc 9h'), 1);
  assert.equal(cmp('Kd Kc Qh', 'Kh Ks Jd 9c 8h'), 1);
  // keys equal as far as they go: the longer (Middle) is higher
  assert.equal(cmp('Kh Qs Jd 5c 3h', 'Kd Qc Jh'), 1);
  assert.equal(cmp('Kd Qc Jh', 'Kh Qs Jd 5c 3h'), -1);
  // pair vs pair with same kicker prefix
  assert.equal(cmp('9h 9s 4d 3c 2h', '9d 9c 4h'), 1);
});

test('bad input is rejected', () => {
  assert.throws(() => evaluate(P('As Kd')));
  assert.throws(() => P('Zz'));
  assert.equal(evaluate5(P('10h Jh Qh Kh Ah')).cat, CAT.STRAIGHT_FLUSH);
});
