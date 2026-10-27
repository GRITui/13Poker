// 13 Poker UI controller. All game rules live in ./engine; this file only handles state, DOM and animation.
import {
  deal, seededRng, sortByRank, sortBySuit, sortForDisplay, rankOf, suitOf, RANK_NAME, SUIT_NAME,
  evaluate3, evaluate5, compare, handName, validateSet, ROWS, ROW_SIZES,
  makeConfig, preparePlayer, settle, pairFor, arrangeHand, detectNatural, DEFAULT_ROYALTIES, DEFAULT_NATURALS,
} from './engine/index.js';
import { attachDnD } from './ui/dnd.js';
import { loadSettings, saveSettings, loadScores, saveScores, totals } from './ui/store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROW_LABEL = { front: 'Front', middle: 'Middle', back: 'Back' };
const OPPONENTS = [
  { name: 'Lin', color: '#f2c14e' },
  { name: 'Rosa', color: '#7cc7ff' },
  { name: 'Kai', color: '#ff9db0' },
];
const CARD_PATH = 'assets/cards/';

// ---------- state ----------
const params = new URLSearchParams(location.search);
const SEED = params.has('seed') ? Number(params.get('seed')) || 1 : null;

let settings = loadSettings();
let scores = null;
let game = null;
let showdownToken = 0;

function playerNames() {
  return ['You', ...OPPONENTS.slice(0, settings.opponents).map((o) => o.name)];
}

function engineConfig() {
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
const ruleOpts = () => ({ allowEqualRows: settings.allowEqualRows, wheelRank: settings.wheelSecond ? 'second' : 'lowest' });

// ---------- card elements ----------
const cardCache = new Map();
function cardLabel(c) { return `${RANK_NAME[rankOf(c)]} of ${SUIT_NAME[suitOf(c)]}`; }
function cardEl(c) {
  let e = cardCache.get(c);
  if (!e) {
    e = el('div', 'card');
    e.dataset.card = c;
    e.tabIndex = 0;
    e.setAttribute('role', 'button');
    e.setAttribute('aria-label', cardLabel(c));
    e.addEventListener('animationend', () => { e.classList.remove('deal-in'); e.style.animationDelay = ''; });
    const img = new Image();
    img.src = `${CARD_PATH}${c}.svg`;
    img.alt = '';
    img.draggable = false;
    e.appendChild(img);
    cardCache.set(c, e);
  }
  return e;
}
function backSrc() { return `${CARD_PATH}${settings.cardBack}.svg`; }
function backEl() {
  const e = el('div', 'card');
  const img = new Image();
  img.src = backSrc(); img.alt = ''; img.draggable = false; img.className = 'back-img';
  e.appendChild(img);
  return e;
}
function flipEl(c) {
  const e = el('div', 'card flip');
  e.setAttribute('aria-label', cardLabel(c));
  const inner = el('div', 'inner');
  const back = new Image(); back.src = backSrc(); back.alt = ''; back.className = 'back-img';
  const face = new Image(); face.src = `${CARD_PATH}${c}.svg`; face.alt = ''; face.className = 'face';
  inner.append(back, face);
  e.appendChild(inner);
  return e;
}

// ---------- game lifecycle ----------
function newGame() {
  scores = loadScores(playerNames());
  saveScores(scores);
  newRound(scores.rounds.length + 1);
}

function newRound(round) {
  showdownToken++;
  const n = settings.opponents + 1;
  const rng = SEED != null ? seededRng(SEED * 1000 + round) : Math.random;
  const hands = deal(n, rng);
  game = {
    round,
    phase: 'arrange',
    hands,
    tray: [],
    rows: { front: [], middle: [], back: [] },
    selected: new Set(),
    sortMode: 'rank',
    ai: hands.slice(1).map(() => ({ set: null, ready: false, natural: null })),
    humanNatural: null,
    declareNatural: false,
    settlement: null,
    players: null,
    justDealt: true,
  };
  game.tray = sortTray(hands[0]);
  game.humanNatural = settings.naturals ? detectNatural(hands[0], DEFAULT_NATURALS, ruleOpts()) : null;
  $('#results').hidden = true;
  $('#results').innerHTML = '';
  renderAll();
  game.justDealt = false;
  scheduleAI();
}

function scheduleAI() {
  const g = game;
  g.ai.forEach((a, i) => {
    setTimeout(() => {
      if (g !== game || a.ready) return;
      computeAI(i);
      renderOpponents();
      updateSubmit();
    }, 350 + 420 * i + Math.floor(Math.random() * 250));
  });
}

function computeAI(i) {
  const a = game.ai[i];
  if (a.ready) return;
  const cards = game.hands[i + 1];
  const rng = SEED != null ? seededRng(SEED * 7919 + game.round * 31 + i) : Math.random;
  const t0 = performance.now();
  a.set = arrangeHand(cards, { ...ruleOpts(), rng }).set;
  a.ms = performance.now() - t0;
  a.ready = true;
}

function sortTray(cards) {
  return game && game.sortMode === 'suit' ? sortBySuit(cards) : sortByRank(cards);
}

// ---------- moves ----------
function locate(c) {
  if (game.tray.includes(c)) return 'tray';
  for (const r of ROWS) if (game.rows[r].includes(c)) return r;
  return null;
}
function zoneCards(z) { return z === 'tray' ? game.tray : game.rows[z]; }
function freeIn(z) { return z === 'tray' ? Infinity : ROW_SIZES[z] - game.rows[z].length; }

function removeCard(c) {
  const z = locate(c);
  if (!z) return;
  const arr = zoneCards(z);
  arr.splice(arr.indexOf(c), 1);
}
function normalize() {
  game.tray = sortTray(game.tray);
  for (const r of ROWS) game.rows[r] = sortForDisplay(game.rows[r]);
}
function moveCards(cards, z) {
  for (const c of cards) { removeCard(c); zoneCards(z).push(c); }
  normalize();
}
function swapCards(a, b) {
  const za = locate(a); const zb = locate(b);
  const arrA = zoneCards(za); const arrB = zoneCards(zb);
  arrA[arrA.indexOf(a)] = b;
  arrB[arrB.indexOf(b)] = a;
  normalize();
}
function afterMove() {
  game.selected.clear();
  renderPlayer();
}

function canDrop(cards, z) {
  if (z === 'tray') return true;
  const incoming = cards.filter((c) => locate(c) !== z);
  return incoming.length <= freeIn(z) || incoming.length === 1;
}

function placeInto(cards, z, target = null) {
  const incoming = cards.filter((c) => locate(c) !== z);
  if (!incoming.length) { afterMove(); return; }
  if (incoming.length <= freeIn(z)) { moveCards(incoming, z); afterMove(); return; }
  if (incoming.length === 1 && target && locate(target) === z) { swapCards(incoming[0], target); afterMove(); return; }
  if (incoming.length === 1) {
    toast(`${ROW_LABEL[z]} is full. Drop on (or tap) one of its cards to swap.`);
  } else {
    const free = freeIn(z);
    toast(free ? `${ROW_LABEL[z]} has room for ${free} more card${free > 1 ? 's' : ''}.` : `${ROW_LABEL[z]} is full.`);
  }
}

function onTapCard(c) {
  if (game.selected.has(c)) { game.selected.delete(c); renderPlayer(); return; }
  if (game.selected.size === 1) {
    const [s] = game.selected;
    const zs = locate(s); const zc = locate(c);
    if (zs !== zc) {
      if (zc !== 'tray' && freeIn(zc) > 0) { placeInto([s], zc); return; }
      swapCards(s, c); afterMove(); return;
    }
  }
  game.selected.add(c);
  renderPlayer();
}

function onTapZone(z) {
  if (!game.selected.size) return;
  placeInto([...game.selected], z);
}

// ---------- analysis ----------
function analyze() {
  const opts = ruleOpts();
  const { front, middle, back } = game.rows;
  const ev = {
    front: front.length === 3 ? evaluate3(front) : null,
    middle: middle.length === 5 ? evaluate5(middle, opts) : null,
    back: back.length === 5 ? evaluate5(back, opts) : null,
  };
  const bad = new Set();
  const problems = [];
  const fails = (c) => (opts.allowEqualRows ? c < 0 : c <= 0);
  if (ev.back && ev.middle && fails(compare(ev.back, ev.middle))) {
    bad.add('back'); bad.add('middle');
    problems.push(compare(ev.back, ev.middle) === 0 ? 'Back ties Middle; it must be higher' : 'Back must be higher than Middle');
  }
  if (ev.middle && ev.front && fails(compare(ev.middle, ev.front))) {
    bad.add('middle'); bad.add('front');
    problems.push(compare(ev.middle, ev.front) === 0 ? 'Middle ties Front; it must be higher' : 'Middle must be higher than Front');
  }
  const placed = front.length + middle.length + back.length;
  const complete = placed === 13;
  const valid = complete && validateSet(game.rows, { ...opts, dealt: game.hands[0] }).valid;
  return { ev, bad, problems, placed, complete, valid };
}

// ---------- rendering ----------
function renderAll() {
  document.documentElement.style.setProperty('--opp-count', settings.opponents);
  $('#roundNo').textContent = game.round;
  renderOpponents();
  renderPlayer();
}

function fmtPts(n, unit = true) {
  const s = n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
  return unit ? `${s} unit${Math.abs(n) === 1 ? '' : 's'}` : s;
}
function ptsClass(n) { return n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'; }
function money(n) {
  const v = n * settings.unitValue;
  return `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(v)}`;
}

function renderOpponents() {
  const wrap = $('#opponents');
  const tot = totals(scores);
  const showdown = game.phase !== 'arrange';
  wrap.classList.toggle('showdown', showdown);
  wrap.innerHTML = '';
  game.ai.forEach((a, i) => {
    const o = OPPONENTS[i];
    const seat = el('div', 'seat');
    seat.dataset.seat = i + 1;
    seat.style.setProperty('--seat-color', o.color);
    const top = el('div', 'seat-top');
    top.innerHTML = `
      <div class="seat-id"><span class="avatar" aria-hidden="true">${o.name[0]}</span>
        <div><div class="seat-name">${o.name}</div><div class="seat-score">${fmtPts(tot[i + 1])}</div></div></div>`;
    const state = el('div', `seat-state ${a.ready ? 'ready' : 'thinking'}`);
    if (!showdown) state.innerHTML = `<span class="dot"></span>${a.ready ? 'Ready' : 'Setting hand…'}`;
    top.appendChild(state);
    seat.appendChild(top);

    const fan = el('div', 'fan');
    for (let k = 0; k < 13; k++) {
      const b = backEl();
      b.style.transform = `rotate(${(k - 6) * 2.2}deg)`;
      fan.appendChild(b);
    }
    seat.appendChild(fan);

    if (showdown && game.players) {
      const p = game.players[i + 1];
      const shownSet = a.set;
      const rowsWrap = el('div', 'seat-rows');
      for (const r of ROWS) {
        const sr = el('div', 'srow');
        sr.dataset.row = r;
        const cardsBox = el('div', `srow-cards ${r}`);
        for (const c of shownSet[r]) cardsBox.appendChild(flipEl(c));
        const info = el('div', 'srow-info');
        const hand = el('div', 'srow-hand');
        hand.dataset.text = p.evals ? handName(p.evals[r]) : '';
        const chip = el('span', 'chip');
        info.append(hand, chip);
        sr.append(cardsBox, info);
        rowsWrap.appendChild(sr);
      }
      seat.appendChild(rowsWrap);
      const res = el('div', 'seat-result');
      seat.appendChild(res);
      if (p.natural) state.innerHTML = `<span class="badge natural">${p.natural.label}</span>`;
      else if (p.fouled) state.innerHTML = '<span class="badge">Fouled</span>';
    }
    wrap.appendChild(seat);
  });
}

function renderPlayer() {
  const a = game.phase === 'arrange' ? analyze() : null;
  const arranging = game.phase === 'arrange';
  const tot = totals(scores);
  $('#youScore').textContent = `${fmtPts(tot[0])} (${money(tot[0])})`;

  // rows
  for (const r of ROWS) {
    const rowEl = $(`.row[data-row="${r}"]`);
    const slots = $(`.slots[data-zone="${r}"]`, rowEl);
    const cards = game.rows[r];
    slots.replaceChildren();
    for (const c of cards) slots.appendChild(cardEl(c));
    for (let k = cards.length; k < ROW_SIZES[r]; k++) slots.appendChild(el('div', 'slot'));
    const handEl = $(`#hand-${r}`);
    let txt = '';
    if (cards.length === ROW_SIZES[r]) {
      txt = handName(r === 'front' ? evaluate3(cards) : evaluate5(cards, ruleOpts()));
    } else if (arranging) {
      txt = `${cards.length} / ${ROW_SIZES[r]}`;
    }
    handEl.textContent = txt;
    rowEl.classList.toggle('bad', !!(a && a.bad.has(r)));
    rowEl.classList.toggle('good', !!(a && a.valid));
    slots.classList.toggle('can-drop', arranging && game.selected.size > 0 && canDrop([...game.selected], r));
  }

  // tray
  const tray = $('#tray');
  tray.replaceChildren();
  tray.classList.toggle('empty', game.tray.length === 0);
  if (game.tray.length === 0) {
    tray.appendChild(el('div', 'empty-msg', arranging ? 'All 13 cards placed.' : ''));
  } else {
    game.tray.forEach((c, k) => {
      const e = cardEl(c);
      if (game.justDealt) {
        e.classList.remove('deal-in');
        void e.offsetWidth;
        e.style.animationDelay = `${k * 35}ms`;
        e.classList.add('deal-in');
      }
      tray.appendChild(e);
    });
  }
  for (const [c, e] of cardCache) e.classList.toggle('selected', game.selected.has(c));
  $('#tray').classList.toggle('can-drop', arranging && game.selected.size > 0 && [...game.selected].some((c) => locate(c) !== 'tray'));

  // validation + status
  const v = $('#validation');
  const status = $('#status');
  if (arranging) {
    if (game.declareNatural && game.humanNatural) {
      v.className = 'validation ok';
      v.textContent = `Natural declared: ${game.humanNatural.label}. Set your hand to collect.`;
    } else if (a.complete && a.valid) {
      v.className = 'validation ok';
      v.textContent = 'Valid hand. Ready to set.';
    } else if (a.problems.length) {
      v.className = 'validation bad';
      v.textContent = `${a.complete ? 'Fouled' : 'Warning'}: ${a.problems.join('; ')}.`;
    } else if (game.selected.size) {
      v.className = 'validation info';
      v.textContent = `${game.selected.size} selected. Tap a row to place ${game.selected.size > 1 ? 'them' : 'it'}.`;
    } else if (a.placed === 0) {
      v.className = 'validation info';
      v.textContent = 'Tap cards, then tap a row. Or drag them. Back > Middle > Front.';
    } else {
      v.className = 'validation info';
      v.textContent = `${a.placed} / 13 placed`;
    }
    const waiting = game.ai.filter((x) => !x.ready).length;
    status.textContent = waiting ? `Round ${game.round} · opponents are setting their hands…` : `Round ${game.round} · set your hand`;
  } else {
    v.className = 'validation info';
    v.textContent = '';
    status.textContent = game.phase === 'showdown' ? `Round ${game.round} \u00b7 showdown (tap to skip)` : `Round ${game.round} \u00b7 complete`;
  }
  v.hidden = !arranging;
  $('.tray-wrap').hidden = !arranging;

  // natural banner
  const nb = $('#naturalBanner');
  if (arranging && game.humanNatural) {
    nb.hidden = false;
    nb.innerHTML = `<span>You were dealt a natural: <b>${game.humanNatural.label}</b> (${game.humanNatural.value} from each opponent).</span>
      <label><input type="checkbox" id="chkNatural" ${game.declareNatural ? 'checked' : ''}> Declare it</label>`;
    $('#chkNatural').addEventListener('change', (e) => { game.declareNatural = e.target.checked; renderPlayer(); });
  } else {
    nb.hidden = true;
    nb.innerHTML = '';
  }

  // controls
  for (const id of ['#btnSortRank', '#btnSortSuit', '#btnAuto', '#btnClear']) $(id).disabled = !arranging;
  $('#btnSortRank').classList.toggle('active', game.sortMode === 'rank');
  $('#btnSortSuit').classList.toggle('active', game.sortMode === 'suit');
  $('#controls').hidden = !arranging;
  updateSubmit(a);
  layoutTray();
}

function updateSubmit(a = game.phase === 'arrange' ? analyze() : null) {
  const btn = $('#btnSubmit');
  if (!a) { btn.disabled = true; return; }
  const ok = a.valid || (game.declareNatural && game.humanNatural);
  btn.disabled = !ok;
  btn.textContent = 'Set hand';
  btn.title = ok ? 'Reveal and score' : a.complete ? 'Fix the fouled hand first' : 'Place all 13 cards first';
}

/** Fit the unplaced cards: natural spacing if it fits, else overlap, else two lines. */
function layoutTray() {
  const tray = $('#tray');
  const n = game.tray.length;
  if (!n) { tray.style.removeProperty('--cols'); tray.style.removeProperty('--step'); tray.style.paddingRight = ''; return; }
  const probe = $('.slots .card, .slots .slot');
  const cw = probe ? probe.getBoundingClientRect().width : 60;
  const gap = parseFloat(getComputedStyle($('.slots')).columnGap) || 6;
  const W = $('.tray-wrap').clientWidth - 12;
  const full = cw + gap;
  let cols = n;
  let step = full;
  if (n * full - gap > W) {
    step = (W - cw) / (n - 1);
    if (step < cw * 0.5) {
      cols = Math.ceil(n / 2);
      step = Math.min(full, (W - cw) / (cols - 1));
    }
  }
  tray.style.setProperty('--cols', cols);
  tray.style.setProperty('--step', `${step}px`);
  tray.style.paddingRight = `${Math.max(6, cw - step + 6)}px`;
}

// ---------- submit + showdown ----------
async function submit() {
  if (game.phase !== 'arrange') return;
  const a = analyze();
  const declared = game.declareNatural && game.humanNatural;
  if (!a.valid && !declared) {
    toast(a.complete ? 'That hand is fouled. Fix the row order first.' : 'Place all 13 cards first.');
    return;
  }
  game.ai.forEach((_, i) => computeAI(i)); // make sure every AI hand is set
  if (declared && !a.complete) {
    const set = game.humanNatural.set || arrangeHand(game.hands[0], ruleOpts()).set;
    game.rows = { front: set.front.slice(), middle: set.middle.slice(), back: set.back.slice() };
    game.tray = [];
  }
  const cfg = engineConfig();
  if (cfg.naturals) {
    // AI always declares a natural; show the natural's own arrangement when it has one.
    game.ai.forEach((ai, i) => {
      const nat = detectNatural(game.hands[i + 1], cfg.naturals, ruleOpts());
      if (nat?.set) ai.set = nat.set;
    });
  }
  const humanSet = { front: game.rows.front.slice(), middle: game.rows.middle.slice(), back: game.rows.back.slice() };
  const players = [preparePlayer(humanSet, cfg, { dealt: game.hands[0], declareNatural: !!declared })];
  game.ai.forEach((ai, i) => players.push(preparePlayer(ai.set, cfg, { dealt: game.hands[i + 1] })));
  game.players = players;
  game.settlement = settle(players, cfg);
  game.phase = 'showdown';
  game.selected.clear();
  renderAll();
  await runShowdown(++showdownToken);
}

async function runShowdown(token) {
  const anim = settings.animations && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const felt = $('#felt');
  felt.classList.toggle('no-anim', !anim);
  const st = game.settlement;
  const wait = (ms) => (anim ? sleep(ms) : Promise.resolve());
  if (anim) {
    $('#opponents').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await wait(350);
  }
  for (const r of ROWS) {
    if (token !== showdownToken) return;
    const rowEl = $(`.row[data-row="${r}"]`);
    rowEl.classList.remove('flash'); void rowEl.offsetWidth; rowEl.classList.add('flash');
    const seats = [...document.querySelectorAll('.seat')];
    seats.forEach((seat, i) => {
      const cards = seat.querySelectorAll(`.srow[data-row="${r}"] .card.flip`);
      cards.forEach((c, k) => setTimeout(() => c.classList.add('revealed'), anim ? k * 70 + i * 40 : 0));
    });
    await wait(560);
    seats.forEach((seat, i) => {
      const sr = seat.querySelector(`.srow[data-row="${r}"]`);
      const hand = sr.querySelector('.srow-hand');
      hand.textContent = hand.dataset.text;
      const d = pairFor(st, 0, i + 1);
      const chip = sr.querySelector('.chip');
      if (d.kind === 'natural') return;
      const res = d.rows ? d.rows[r] : 0;
      chip.className = `chip ${res > 0 ? 'win' : res < 0 ? 'loss' : 'tie'}`;
      chip.textContent = res > 0 ? 'YOU WIN' : res < 0 ? 'YOU LOSE' : 'TIE';
      chip.title = 'From your point of view';
      requestAnimationFrame(() => chip.classList.add('show'));
    });
    await wait(520);
  }
  if (token !== showdownToken) return;
  finishShowdown();
}

function describePair(d, oppName) {
  if (d.kind === 'natural') return d.points > 0 ? 'Your natural wins' : d.points < 0 ? `${oppName}'s natural wins` : 'Naturals tie';
  if (d.kind === 'bothFouled') return 'Both fouled';
  if (d.kind === 'foul') return d.points > 0 ? `${oppName} fouled` : 'You fouled';
  const ties = 3 - d.won - d.lost;
  let s = `Rows ${d.won}-${d.lost}${ties ? `-${ties}` : ''}`;
  if (d.scoop === 'A') s += ', scoop!';
  if (d.scoop === 'B') s += ', scooped';
  if (d.royalties.a || d.royalties.b) s += `, royalties ${d.royalties.a}-${d.royalties.b}`;
  return s;
}

function finishShowdown() {
  const st = game.settlement;
  const names = playerNames();
  // Seat summaries
  document.querySelectorAll('.seat').forEach((seat, i) => {
    seat.querySelectorAll('.card.flip').forEach((c) => c.classList.add('revealed'));
    seat.querySelectorAll('.srow-hand').forEach((h) => { h.textContent = h.dataset.text; });
    const d = pairFor(st, 0, i + 1);
    const res = seat.querySelector('.seat-result');
    res.innerHTML = `<span>${describePair(d, names[i + 1])}</span><span>You: <span class="pts ${ptsClass(d.points)}">${fmtPts(d.points)}</span></span>`;
    res.classList.add('show');
  });

  // Scoreboard
  scores.rounds.push({ round: game.round, net: st.net.slice() });
  saveScores(scores);
  game.phase = 'results';
  renderPlayer();
  renderOpponentsScores();
  renderResults();
}

function renderOpponentsScores() {
  const tot = totals(scores);
  document.querySelectorAll('.seat').forEach((seat, i) => {
    const s = seat.querySelector('.seat-score');
    if (s) s.textContent = fmtPts(tot[i + 1]);
  });
}

function renderResults() {
  const st = game.settlement;
  const names = playerNames();
  const tot = totals(scores);
  const n = names.length;
  const you = st.net[0];
  const box = $('#results');
  const units = (k) => `${k} unit${k === 1 ? '' : 's'}`;
  const headline = you > 0 ? `You won ${units(you)} this round` : you < 0 ? `You lost ${units(-you)} this round` : 'You broke even this round';
  let roundRows = '';
  for (let i = 0; i < n; i++) {
    roundRows += `<tr class="${i === 0 ? 'you' : ''}"><td>${names[i]}</td>
      <td class="${ptsClass(st.net[i])}">${fmtPts(st.net[i], false)}</td>
      <td class="${ptsClass(tot[i])}">${fmtPts(tot[i], false)}</td>
      <td class="${ptsClass(tot[i])}">${money(tot[i])}</td></tr>`;
  }
  let matrix = '<thead><tr><th></th>' + names.map((x) => `<th>${x}</th>`).join('') + '</tr></thead><tbody>';
  for (let i = 0; i < n; i++) {
    matrix += `<tr class="${i === 0 ? 'you' : ''}"><td>${names[i]}</td>`;
    for (let j = 0; j < n; j++) {
      if (i === j) { matrix += '<td class="diag">–</td>'; continue; }
      const p = pairFor(st, i, j).points;
      matrix += `<td class="${ptsClass(p)}">${fmtPts(p, false)}</td>`;
    }
    matrix += '</tr>';
  }
  matrix += '</tbody>';
  const sum = st.net.reduce((s, x) => s + x, 0);
  const modeLabel = { wsgc: 'WSGC scoring', '1-6': '1-6 scoring', '2-4': '2-4 scoring' }[settings.mode];
  const extras = [settings.royalties && 'royalties', settings.naturals && 'naturals'].filter(Boolean).join(', ');
  box.innerHTML = `
    <h2 class="${ptsClass(you)}">${headline}</h2>
    <p class="sub">Round ${game.round} · ${modeLabel}${extras ? ` + ${extras}` : ''} · 1 unit = $${settings.unitValue}</p>
    <div class="results-grid">
      <div>
        <h3>Scores</h3>
        <div class="tbl-scroll"><table class="tbl"><thead><tr><th>Player</th><th>Round</th><th>Total</th><th>$</th></tr></thead><tbody>${roundRows}</tbody></table></div>
        <div class="zero-sum">Zero-sum check: ${st.net.map((x) => fmtPts(x, false)).join(' ')} = ${sum} ${sum === 0 ? '✓' : '✗'}</div>
      </div>
      <div>
        <h3>Head to head (row player's points)</h3>
        <div class="tbl-scroll"><table class="tbl">${matrix}</table></div>
      </div>
    </div>
    <div class="results-actions">
      <button type="button" class="btn btn-ghost" id="btnResultsScores">Scoreboard</button>
      <button type="button" class="btn btn-primary" id="btnNext">Next round</button>
    </div>`;
  box.hidden = false;
  $('#btnNext').addEventListener('click', () => newRound(game.round + 1));
  $('#btnResultsScores').addEventListener('click', openScores);
  const anim = settings.animations && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollIntoView({ behavior: anim ? 'smooth' : 'auto', block: 'nearest' });
  $('#btnNext').focus({ preventScroll: true });
}

// ---------- dialogs ----------
function openSettings() {
  const f = $('#settingsForm');
  f.opponents.value = String(settings.opponents);
  f.mode.value = settings.mode;
  f.unitValue.value = settings.unitValue;
  f.cardBack.value = settings.cardBack;
  for (const k of ['royalties', 'royaltyRequiresRowWin', 'naturals', 'allowEqualRows', 'wheelSecond', 'animations']) f[k].checked = !!settings[k];
  f.royaltyRequiresRowWin.disabled = !settings.royalties;
  $('#dlgSettings').showModal();
}

function applySettings() {
  const f = $('#settingsForm');
  const prev = settings;
  const next = {
    ...settings,
    opponents: Number(f.opponents.value) || 3,
    mode: f.mode.value || 'wsgc',
    unitValue: Math.min(10, Math.max(1, Math.round(Number(f.unitValue.value) || 1))),
    cardBack: f.cardBack.value || 'back',
  };
  for (const k of ['royalties', 'royaltyRequiresRowWin', 'naturals', 'allowEqualRows', 'wheelSecond', 'animations']) next[k] = f[k].checked;
  settings = next;
  saveSettings(settings);
  makeConfig({ mode: settings.mode, unitValue: settings.unitValue }); // sanity

  if (prev.cardBack !== settings.cardBack) {
    document.querySelectorAll('img.back-img').forEach((img) => { img.src = backSrc(); });
  }
  if (prev.opponents !== settings.opponents) {
    scores = { names: playerNames(), rounds: [] };
    saveScores(scores);
    newRound(1);
    toast(`New game with ${settings.opponents} opponent${settings.opponents > 1 ? 's' : ''}.`);
    return;
  }
  if (game.phase === 'arrange') {
    const rulesChanged = prev.allowEqualRows !== settings.allowEqualRows || prev.wheelSecond !== settings.wheelSecond;
    if (rulesChanged) { game.ai.forEach((a) => { a.ready = false; }); scheduleAI(); renderOpponents(); }
    if (prev.naturals !== settings.naturals) {
      game.humanNatural = settings.naturals ? detectNatural(game.hands[0], DEFAULT_NATURALS, ruleOpts()) : null;
      game.declareNatural = false;
    }
    renderPlayer();
  }
  toast('Settings saved.');
}

function openScores() {
  const names = scores.names;
  const tot = totals(scores);
  const body = $('#scoresBody');
  if (!scores.rounds.length) {
    body.innerHTML = '<p class="empty-note">No rounds played yet.</p>';
  } else {
    const head = `<tr><th>Round</th>${names.map((x) => `<th>${x}</th>`).join('')}</tr>`;
    const rows = scores.rounds.slice().reverse().map((r) => `<tr><td>${r.round}</td>${r.net.map((x) => `<td class="${ptsClass(x)}">${fmtPts(x, false)}</td>`).join('')}</tr>`).join('');
    const totalRow = `<tr class="you"><td><b>Total</b></td>${tot.map((x) => `<td class="${ptsClass(x)}"><b>${fmtPts(x, false)}</b></td>`).join('')}</tr>`;
    const moneyRow = `<tr><td>At $${settings.unitValue}/unit</td>${tot.map((x) => `<td class="${ptsClass(x)}">${money(x)}</td>`).join('')}</tr>`;
    body.innerHTML = `<div class="tbl-scroll"><table class="tbl"><thead>${head}</thead><tbody>${totalRow}${moneyRow}${rows}</tbody></table></div>
      <p class="hint">${scores.rounds.length} round${scores.rounds.length > 1 ? 's' : ''} played. Every round sums to zero.</p>`;
  }
  $('#dlgScores').showModal();
}

// ---------- toast ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- wiring ----------
function wire() {
  attachDnD($('#player'), {
    enabled: () => game && game.phase === 'arrange',
    dragSet: (c) => (game.selected.has(c) ? [...game.selected] : [c]),
    onTapCard,
    onTapZone,
    onDrop: (cards, z, target) => {
      if (z === 'tray') { moveCards(cards, 'tray'); afterMove(); return; }
      placeInto(cards, z, target);
    },
    canDrop,
  });
  $('#btnSortRank').addEventListener('click', () => { game.sortMode = 'rank'; normalize(); renderPlayer(); });
  $('#btnSortSuit').addEventListener('click', () => { game.sortMode = 'suit'; normalize(); renderPlayer(); });
  $('#btnAuto').addEventListener('click', () => {
    const { set } = arrangeHand(game.hands[0], ruleOpts());
    game.rows = { front: set.front, middle: set.middle, back: set.back };
    game.tray = [];
    game.selected.clear();
    normalize();
    renderPlayer();
    toast('Suggested arrangement. Adjust it or set your hand.');
  });
  $('#btnClear').addEventListener('click', () => {
    game.tray = [...game.tray, ...game.rows.front, ...game.rows.middle, ...game.rows.back];
    game.rows = { front: [], middle: [], back: [] };
    game.selected.clear();
    normalize();
    renderPlayer();
  });
  $('#btnSubmit').addEventListener('click', submit);
  $('#btnSettings').addEventListener('click', openSettings);
  $('#btnHelp').addEventListener('click', () => $('#dlgHelp').showModal());
  $('#btnScores').addEventListener('click', openScores);
  $('#settingsForm').royalties.addEventListener('change', (e) => { $('#settingsForm').royaltyRequiresRowWin.disabled = !e.target.checked; });
  $('#dlgSettings').addEventListener('close', () => { if ($('#dlgSettings').returnValue === 'save') applySettings(); });
  $('#dlgScores').addEventListener('close', () => {
    if ($('#dlgScores').returnValue === 'reset' && confirm('Reset the scoreboard?')) {
      scores = { names: playerNames(), rounds: [] };
      saveScores(scores);
      renderOpponentsScores();
      renderPlayer();
      if (game.phase === 'results') renderResults();
    }
  });
  // Close dialogs by clicking the backdrop.
  document.querySelectorAll('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => {
    if (e.target === d) d.close('cancel');
  }));
  // Tap outside cards/rows clears the selection.
  document.addEventListener('click', (e) => {
    if (!game || game.phase !== 'arrange' || !game.selected.size) return;
    if (e.target.closest('#player') || e.target.closest('dialog') || e.target.closest('button')) return;
    game.selected.clear();
    renderPlayer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && game?.selected.size) { game.selected.clear(); renderPlayer(); }
  });
  // Tap the table during the showdown animation to skip it.
  $('#felt').addEventListener('click', (e) => {
    if (game?.phase === 'showdown' && !e.target.closest('button')) { showdownToken++; finishShowdown(); }
  });
  // Enter inside the settings form saves (instead of triggering the first button, Close).
  $('#settingsForm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); $('#dlgSettings').close('save'); }
  });
  let rz = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(rz); rz = requestAnimationFrame(layoutTray); });
}

wire();
newGame();

// Small hook for automated browser tests (read-only snapshot + helpers).
window.__poker = {
  state: () => ({
    round: game.round, phase: game.phase, tray: game.tray.slice(), rows: JSON.parse(JSON.stringify(game.rows)),
    aiMs: game.ai.map((a) => a.ms ?? null), net: game.settlement?.net ?? null, totals: totals(scores),
  }),
  skip: () => { if (game.phase === 'showdown') { showdownToken++; finishShowdown(); } },
};
