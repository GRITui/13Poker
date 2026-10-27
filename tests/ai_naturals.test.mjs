import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCards as P, arrangeHand, validateSet, deal, seededRng, detectNatural, DEFAULT_NATURALS, preparePlayer,
  scorePair, settle, sortByRank,
} from '../js/engine/index.js';

test('AI always finds a valid arrangement quickly', () => {
  const rng = seededRng(123);
  let worst = 0;
  for (let i = 0; i < 60; i++) {
    const h = deal(4, rng)[i % 4];
    const t = performance.now();
    const r = arrangeHand(h);
    worst = Math.max(worst, performance.now() - t);
    assert.equal(r.valid, true);
    const v = validateSet(r.set, { dealt: h });
    assert.equal(v.valid, true, JSON.stringify(r.set));
  }
  assert.ok(worst < 300, `slowest AI arrangement took ${worst.toFixed(0)}ms`);
});

test('AI uses obvious strength: quads go in the back', () => {
  const h = P('As Ah Ad Ac 2s 7h 9d Jc 3c 4h 8s Td Qh');
  const r = arrangeHand(h);
  assert.equal(r.set.back.filter((c) => c[0] === 'A').length, 4);
});

test('AI beats a naive "sort and split" strategy on average', () => {
  const rng = seededRng(99);
  let total = 0;
  for (let i = 0; i < 150; i++) {
    const [h1, h2] = deal(2, rng);
    const ai = preparePlayer(arrangeHand(h1).set);
    // naive: best-looking split by rank order; fouled ones count as fouls
    const s = sortByRank(h2);
    const naive = preparePlayer({ back: s.slice(0, 5), middle: s.slice(5, 10), front: s.slice(10) });
    total += scorePair(ai, naive).points;
  }
  assert.ok(total > 0, `AI net vs naive: ${total}`);
});

test('naturals detection', () => {
  const dragon = P('2s 3h 4d 5c 6s 7h 8d 9c Ts Jh Qd Kc As');
  assert.equal(detectNatural(dragon, DEFAULT_NATURALS).type, 'dragon');
  const six = P('2s 2h 4d 4c 6s 6h 8d 8c Ts Th Qd Qc As');
  assert.equal(detectNatural(six, DEFAULT_NATURALS).type, 'sixPairs');
  const quadsSix = P('2s 2h 2d 2c 6s 6h 8d 8c Ts Th Qd Qc As');
  assert.equal(detectNatural(quadsSix, DEFAULT_NATURALS).type, 'sixPairs');
  const flushes = P('2h 7h 9h 3s 5s 8s Js Ks 4d 6d Td Qd 2d');
  const nf = detectNatural(flushes, DEFAULT_NATURALS);
  assert.equal(nf.type, 'threeFlushes');
  assert.equal(nf.set.front.length, 3);
  const straights = P('Ah 2s 3d 4c 5h 6d 7s 8h 9c Ts Jd Qh Kc'.split(' ').slice(0, 12).join(' ') + ' 3c');
  const ns = detectNatural(straights, DEFAULT_NATURALS);
  assert.ok(ns && ns.type === 'threeStraights', JSON.stringify(ns));
  assert.equal(detectNatural(P('As Ah 3d 4c 5h 6d 9s 8h 9c Ts Jd Kh Kc'), DEFAULT_NATURALS), null);
  assert.equal(detectNatural(dragon, null), null);
});

test('naturals scoring: paid instead of comparison; higher natural wins; same type ties', () => {
  const cfg = { naturals: true };
  const dragonCards = P('2s 3h 4d 5c 6s 7h 8d 9c Ts Jh Qd Kc Ad');
  const dragon = preparePlayer(arrangeHand(dragonCards).set, cfg);
  assert.equal(dragon.natural.type, 'dragon');
  const plain = preparePlayer({ front: P('Qd Qc 3h'), middle: P('Ah Kh 8h 6h 2h'), back: P('9s 9h 9d 4c 4s') }, cfg);
  assert.equal(scorePair(dragon, plain, cfg).points, 13);
  const sixCards = P('2c 2h 4s 4c 6c 6h 8s 8c Tc Th Qs Qc As');
  const six = preparePlayer(arrangeHand(sixCards).set, cfg);
  assert.equal(six.natural.type, 'sixPairs');
  assert.equal(scorePair(six, dragon, cfg).points, -13);
  assert.equal(scorePair(six, six, cfg).points, 0);
  // declining a natural
  const declined = preparePlayer(arrangeHand(sixCards).set, cfg, { declareNatural: false });
  assert.equal(declined.natural, null);
  // naturals off -> no natural
  assert.equal(preparePlayer(arrangeHand(dragonCards).set, {}).natural, null);
  const st = settle([dragon, six, plain], cfg);
  assert.equal(st.net.reduce((s, x) => s + x, 0), 0);
});
