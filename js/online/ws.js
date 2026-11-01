// Online play against the 13 Poker server (Cloudflare Worker + one Durable Object per table, see worker/).
// The server deals, keeps every hand hidden until the showdown, checks each set hand, runs the turn timer and
// scores. This module only talks to it and drives the shared lobby/bar UI (./ui.js) and the table (main.js hooks).
//
// Protocol (JSON text frames, see worker/room.js):
//   client -> server: hello{name, token?}, setSettings{settings}, start, setHand{front, middle, back, declareNatural},
//                     nextRound, leave, kick{seat}, seatBot{seat}; plus a plain "ping" keep-alive
//   server -> client: welcome{token, code, rejoined}, state{...}, error{code, message}, left
import { normalizeCode, tableConfig, rotation, rotateSettlement, MAX_SEATS } from './table.js';
import { preparePlayer } from '../engine/index.js';
import { loadSettings } from '../ui/store.js';
import * as U from './ui.js';

const { $, h } = U;
const NAME_KEY = '13poker.nickname'; // localStorage
const CUR_KEY = '13poker.ws.table'; // sessionStorage: the table this tab is at
const tokenKey = (code) => `13poker.ws.token.${code}`; // sessionStorage: rejoin token for that table
const BOT_NAMES = ['Lin', 'Rosa', 'Kai', 'Ada'];
const FINE_PRINT = 'Fair play: the server deals and keeps every hand hidden until the showdown. Scores are for points only, not real money.';
const FATAL_CLOSE = { 4000: '', 4400: 'Couldn’t join that table.', 4403: 'The host gave your seat away.', 4404: 'No table with that code. It may have closed.', 4409: 'This seat was opened in another window.', 4410: 'The table was closed after an hour without players.', 4429: 'Disconnected for sending too many messages.' };
const FATAL_ERRORS = ['no-table', 'started', 'full', 'bad-name', 'kicked', 'replaced'];

let A = null; // main.js hooks
const W = {
  view: 'closed', // 'closed' | 'home' | 'lobby' | 'game'
  name: '',
  prefill: '',
  homeMsg: '',
  busy: false,
  code: null,
  ws: null,
  conn: 'idle', // 'idle' | 'connecting' | 'open' | 'reconnecting'
  attempt: 0,
  retryTimer: 0,
  pingTimer: 0,
  clockTimer: 0,
  fatal: null,
  leaving: false,
  st: null, // last state from the server
  skew: 0, // server clock - local clock
  ctx: null,
  enteredPhase: null,
  showdownKey: null,
  scoresSig: '',
  pending: null, // a setHand waiting for the server
  editName: false,
};

// ---------- storage ----------
const store = (area) => ({
  get(k) { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) window[area].removeItem(k); else window[area].setItem(k, v); } catch { /* unavailable */ } },
});
const local = store('localStorage');
const session = store('sessionStorage');

/** Same rules as the server: no control/format characters, spaces collapsed, 1-16 characters. */
export function cleanNickname(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/ {2,}/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length ? chars.slice(0, 16).join('').trim() : '';
}

function setUrlTable(code) {
  try {
    const u = new URL(location.href);
    if (code) u.searchParams.set('table', code); else u.searchParams.delete('table');
    history.replaceState(history.state, '', u);
  } catch { /* sandboxed */ }
}
const inviteLink = (code) => `${location.origin}/?table=${code}`;

// ---------- start-up ----------
export function startWs(api) {
  A = api;
  W.name = cleanNickname(local.get(NAME_KEY));
  const btn = $('#btnOnline');
  btn.disabled = false;
  btn.removeAttribute('aria-disabled');
  btn.classList.remove('is-off');
  btn.title = 'Play online with friends';
  window.addEventListener('online', () => { if (W.conn === 'reconnecting') reconnectNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && W.conn === 'reconnecting') reconnectNow();
  });

  const invited = normalizeCode(new URLSearchParams(location.search).get('table') || '');
  const current = session.get(CUR_KEY);
  const target = invited || current;
  if (target && session.get(tokenKey(target))) {
    connect(target); // a refresh: take the same seat back
  } else if (invited) {
    W.prefill = invited;
    if (W.name) connect(invited);
    else { W.homeMsg = `Choose a nickname to join table ${invited}.`; showView('home'); focusName(); }
  }
  return { onButton, debug };
}

function onButton() {
  if (W.code && W.view === 'game') { A.toast(`You’re at table ${W.code}.`); return; }
  if (W.code) { showView('lobby'); return; }
  showView(W.view === 'home' ? 'closed' : 'home');
  if (W.view === 'home' && !W.name) focusName();
}

function focusName() { requestAnimationFrame(() => $('#nickname')?.focus()); }

// ---------- actions ----------
function takeName() {
  const input = $('#nickname');
  const nm = cleanNickname(input ? input.value : W.name);
  if (!nm) { W.homeMsg = 'Choose a nickname (1–16 characters).'; renderHome(); focusName(); return null; }
  W.name = nm;
  local.set(NAME_KEY, nm);
  W.editName = false;
  return nm;
}

async function createTable() {
  if (W.busy || !takeName()) return;
  W.busy = true; W.homeMsg = ''; renderHome();
  try {
    const s = loadSettings();
    const res = await fetch('/api/tables', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          mode: s.mode, unitValue: s.unitValue, royalties: s.royalties, royaltyRequiresRowWin: s.royaltyRequiresRowWin,
          naturals: s.naturals, allowEqualRows: s.allowEqualRows, wheelSecond: s.wheelSecond, fillBots: true,
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !normalizeCode(body.code || '')) throw new Error(body.message || 'Couldn’t create a table.');
    W.busy = false;
    connect(body.code);
  } catch (e) {
    W.busy = false;
    W.homeMsg = e && e.message && !/fetch/i.test(e.message) ? e.message : 'Couldn’t reach the server. Check your connection.';
    renderHome();
  }
}

function joinTable(input) {
  if (W.busy || !takeName()) return;
  const code = normalizeCode(input);
  if (!code) { W.homeMsg = 'Enter the 4-character table code.'; renderHome(); return; }
  connect(code);
}

function leaveTable() {
  const st = W.st;
  const inGame = st && st.phase !== 'lobby';
  if (inGame && !confirm('Leave the game? An AI bot takes your seat.')) return;
  if (W.ws && W.ws.readyState === WebSocket.OPEN) send({ type: 'leave' });
  closeTable('', 'closed');
  A.toast('You left the table.');
}

function nextRound() { send({ type: 'nextRound' }); }

function send(msg) {
  if (!W.ws || W.ws.readyState !== WebSocket.OPEN) return false;
  W.ws.send(JSON.stringify(msg));
  return true;
}

// ---------- connection ----------
function connect(code) {
  closeSocket();
  Object.assign(W, {
    code, st: null, fatal: null, leaving: false, attempt: 0, ctx: null, showdownKey: null, scoresSig: '', homeMsg: '',
  });
  session.set(CUR_KEY, code);
  setUrlTable(code);
  showView('lobby');
  openSocket();
}

function openSocket() {
  clearTimeout(W.retryTimer);
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try { ws = new WebSocket(`${proto}//${location.host}/ws?table=${encodeURIComponent(W.code)}`); } catch { scheduleReconnect(); return; }
  W.ws = ws;
  W.conn = W.attempt ? 'reconnecting' : 'connecting';
  ws.onopen = () => {
    if (W.ws !== ws) return;
    const token = session.get(tokenKey(W.code));
    ws.send(JSON.stringify(token ? { type: 'hello', name: W.name || 'Player', token } : { type: 'hello', name: W.name }));
    clearInterval(W.pingTimer);
    W.pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 25_000);
  };
  ws.onmessage = (e) => {
    if (W.ws !== ws || typeof e.data !== 'string' || e.data === 'pong') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m);
  };
  ws.onclose = (e) => {
    if (W.ws !== ws) return;
    W.ws = null;
    clearInterval(W.pingTimer);
    onClose(e.code);
  };
}

function closeSocket() {
  clearTimeout(W.retryTimer);
  clearInterval(W.pingTimer);
  const ws = W.ws;
  W.ws = null;
  if (ws) { try { ws.close(1000, 'bye'); } catch { /* closed */ } }
}

function onClose(code) {
  if (W.leaving || !W.code) return;
  if (W.fatal != null || code in FATAL_CLOSE) {
    closeTable(W.fatal || FATAL_CLOSE[code] || 'Disconnected from the table.', 'home');
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  W.conn = 'reconnecting';
  const delay = Math.min(15_000, 600 * 2 ** W.attempt) * (0.8 + Math.random() * 0.4);
  W.attempt++;
  clearTimeout(W.retryTimer);
  W.retryTimer = setTimeout(openSocket, delay);
  renderAllViews();
}

function reconnectNow() {
  if (!W.code || W.ws) return;
  openSocket();
}

/** Leave the table locally (after leaving, being refused, kicked, or the table closing). */
function closeTable(msg, view) {
  W.leaving = true;
  closeSocket();
  if (W.code) session.set(tokenKey(W.code), null);
  session.set(CUR_KEY, null);
  setUrlTable(null);
  if (W.pending) { clearTimeout(W.pending.timer); W.pending.resolve(false); W.pending = null; }
  stopClock();
  Object.assign(W, { code: null, st: null, ctx: null, conn: 'idle', homeMsg: msg || '', showdownKey: null });
  if (A.key()) A.leave();
  showView(view);
}

function onMessage(m) {
  switch (m.type) {
    case 'welcome':
      if (m.code !== W.code || typeof m.token !== 'string') return;
      session.set(tokenKey(W.code), m.token);
      if (W.attempt > 0) A.toast('Reconnected.');
      W.attempt = 0;
      W.conn = 'open';
      break;
    case 'state':
      if (m.code !== W.code) return;
      W.conn = 'open';
      W.st = m;
      W.skew = typeof m.now === 'number' ? m.now - Date.now() : 0;
      apply();
      break;
    case 'error':
      if (FATAL_ERRORS.includes(m.code)) {
        // The server closes the socket too; don't wait for that.
        closeTable(m.message || 'Couldn’t join that table.', 'home');
        return;
      }
      if (W.pending && ['bad-hand', 'bad-phase'].includes(m.code)) {
        clearTimeout(W.pending.timer); W.pending.resolve(false); W.pending = null;
      }
      if (m.code !== 'already-set') A.toast(m.message || 'Something went wrong.');
      break;
    default:
      break;
  }
}

// ---------- state -> view ----------
const amHost = () => !!W.st && W.st.host >= 0 && W.st.host === W.st.you;
const roundKey = (st) => `${st.code}:${st.round}`;

function oppOf(st, i) {
  const s = st.seats[i];
  return {
    name: s.name,
    color: s.kind === 'bot' ? U.BOT_COLORS[s.name] || '#e8e1cf' : U.HUMAN_COLORS[i],
    kind: s.kind,
    here: s.connected,
    ready: s.ready,
    awayLabel: 'Disconnected',
  };
}

function apply() {
  const st = W.st;
  if (st.you < 0) { closeTable('You are no longer at this table.', 'home'); return; }
  if (st.phase === 'lobby') {
    if (A.key()) A.leave();
    stopClock();
    if (W.view !== 'lobby') showView('lobby'); else renderLobby();
    return;
  }
  const order = rotation(st.seats.length, st.you);
  const key = roundKey(st);
  const opps = order.slice(1).map((i) => oppOf(st, i));
  if (W.view !== 'game') showView('game');
  if (A.key() !== key) {
    W.ctx = makeCtx();
    W.enteredPhase = st.phase;
    W.showdownKey = null;
    A.enterRound({ key, round: st.round, hands: [st.hand.slice()], opps }, W.ctx);
  } else {
    W.ctx.rules = st.settings;
    A.setOpps(opps);
  }
  if (st.submitted) {
    A.restoreSubmitted(st.submitted.set, st.submitted.declareNatural);
    if (W.pending) { clearTimeout(W.pending.timer); W.pending.resolve(true); W.pending = null; }
  }
  if (st.phase === 'showdown' && st.showdown && W.showdownKey !== key) {
    W.showdownKey = key;
    const sd = st.showdown;
    const cfg = tableConfig(st.settings);
    const players = sd.sets.map((set, i) => preparePlayer(set, cfg, { declareNatural: sd.declared[i] }));
    A.showdown({
      sets: order.map((i) => sd.sets[i]),
      players: order.map((i) => players[i]),
      settlement: rotateSettlement(sd.settlement, order),
    }, W.enteredPhase === 'showdown');
  }
  const sig = JSON.stringify([st.totals, st.results.length, st.host, st.seats.map((s) => s.name)]);
  if (sig !== W.scoresSig) { W.scoresSig = sig; A.refreshScores(); }
  renderBar();
  syncClock();
}

/** The object main.js reads while a game is on (see `online` in main.js). */
function makeCtx() {
  return {
    rules: W.st.settings,
    get isHost() { return amHost(); },
    book() {
      const st = W.st;
      if (!st) return { names: [], rounds: [] };
      const order = rotation(st.seats.length, st.you);
      let results = st.results;
      // Don't give the result away in the scores while the showdown is still being revealed.
      if (st.phase === 'showdown' && A.phase() !== 'results') results = results.filter((r) => r.round !== st.round);
      const rounds = results.map((r) => ({ round: r.round, net: order.map((i) => r.net[i]) }));
      // Only the latest rounds are kept; fold anything older into one line so the totals stay right.
      const shown = new Array(st.seats.length).fill(0);
      for (const r of results) r.net.forEach((x, i) => { shown[i] += x; });
      const hidden = st.results.filter((r) => !results.includes(r));
      const diff = st.totals.map((t, i) => t - shown[i] - hidden.reduce((a, r) => a + r.net[i], 0));
      if (diff.some((x) => x !== 0)) rounds.unshift({ round: 'Earlier', net: order.map((i) => diff[i]) });
      return { names: order.map((i) => (i === st.you ? 'You' : st.seats[i].name)), rounds };
    },
    submit(set, declareNatural) {
      return new Promise((resolve) => {
        if (!send({ type: 'setHand', front: set.front, middle: set.middle, back: set.back, declareNatural: !!declareNatural })) {
          A.toast('Not connected right now. Reconnecting…');
          resolve(false);
          return;
        }
        if (W.pending) { clearTimeout(W.pending.timer); W.pending.resolve(false); }
        W.pending = {
          resolve,
          timer: setTimeout(() => {
            if (!W.pending) return;
            W.pending = null;
            A.toast('The server didn’t answer. Try again.');
            resolve(false);
          }, 12_000),
        };
      });
    },
    next: nextRound,
  };
}

// ---------- turn clock ----------
function remainingMs() {
  const st = W.st;
  if (!st || st.phase !== 'arrange' || !st.deadline) return null;
  return Math.max(0, st.deadline - (Date.now() + W.skew));
}
const fmtClock = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function syncClock() {
  if (remainingMs() == null) { stopClock(); return; }
  tickClock();
  if (!W.clockTimer) W.clockTimer = setInterval(tickClock, 250);
}
function stopClock() {
  clearInterval(W.clockTimer);
  W.clockTimer = 0;
  const c = $('#turnClock');
  if (c) c.hidden = true;
}
function tickClock() {
  const ms = remainingMs();
  if (ms == null) { stopClock(); return; }
  const st = W.st;
  const mine = !!st.submitted;
  const urgent = ms <= 15_000;
  const c = $('#turnClock');
  c.hidden = false;
  c.classList.toggle('urgent', urgent && !mine);
  const time = fmtClock(ms);
  const note = mine
    ? (ms > 0 ? 'until the showdown. Anyone not set by then is auto-set.' : 'Setting the last hands…')
    : (ms > 0 ? 'to set your hand. It’s auto-set when time runs out.' : 'Time’s up: setting your hand…');
  const t = c.querySelector('.tc-time');
  if (t && t.textContent === time && c.dataset.mine === String(mine)) return;
  c.dataset.mine = String(mine);
  c.replaceChildren(h('span', { class: 'tc-time', text: time }), h('span', { class: 'tc-note', text: note }));
  const ob = $('#obTimer');
  if (ob) ob.textContent = time;
}

// ---------- DOM ----------
function showView(v) {
  W.view = v;
  if (v === 'home') renderHome();
  if (v === 'lobby') renderLobby();
  if (v === 'game') renderBar();
  if (v !== 'game') stopClock();
  U.setPanel(v);
}

function renderAllViews() {
  if (W.view === 'lobby') renderLobby();
  if (W.view === 'game') renderBar();
}

function connNote() {
  if (W.conn === 'reconnecting') return 'Reconnecting…';
  if (W.conn === 'connecting') return 'Connecting…';
  return '';
}

function nameField() {
  if (W.name && !W.editName) {
    return h('p', { class: 'lobby-sub nick-line' }, 'Playing as ', h('b', { id: 'nickShown', text: W.name }), ' ',
      h('button', { type: 'button', class: 'btn btn-ghost btn-small', id: 'btnEditName', onclick: () => { W.editName = true; renderHome(); focusName(); }, text: 'Change' }));
  }
  return h('label', { class: 'nick-field' },
    h('span', { class: 'lobby-label', text: 'Your nickname' }),
    h('input', {
      id: 'nickname', class: 'nick-input', type: 'text', maxlength: '16', autocomplete: 'nickname', spellcheck: 'false',
      placeholder: '1–16 characters', value: W.name || null, 'aria-label': 'Your nickname',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); if (takeName()) renderHome(); } },
    }));
}

function renderHome() {
  $('#lobby').replaceChildren(U.homeCard({
    sub: 'Play with 1–3 friends. Create a table and send them the link, or join with a friend’s code. AI bots can fill the empty seats.',
    top: nameField(),
    busy: W.busy, msg: W.homeMsg, code: W.prefill, fine: FINE_PRINT,
    onCreate: createTable, onJoin: joinTable, onBack: () => showView('closed'),
  }));
}

function renderLobby() {
  const box = $('#lobby');
  const st = W.st;
  if (!st || st.phase !== 'lobby') {
    const text = W.conn === 'reconnecting' ? 'Reconnecting…' : st ? 'The game is starting…' : 'Connecting to the table…';
    box.replaceChildren(U.connectingCard(W.code, text, leaveTable));
    return;
  }
  const host = amHost();
  const seats = st.seats.map((s, i) => ({
    name: i === st.you ? `You (${s.name})` : s.name,
    color: U.HUMAN_COLORS[i], avatar: s.name[0], host: i === st.host, away: !s.connected,
    tags: s.connected ? [] : ['Offline'],
    action: host && i !== st.you && s.kind === 'human'
      ? h('button', {
        type: 'button', class: 'btn btn-ghost btn-small btn-kick', id: `btnKick${i}`, title: `Remove ${s.name}`,
        'aria-label': `Remove ${s.name}`, onclick: () => { if (confirm(`Remove ${s.name} from the table?`)) send({ type: 'kick', seat: i }); }, text: 'Remove',
      })
      : null,
  }));
  const used = st.seats.filter((s) => s.kind === 'bot').map((s) => s.name);
  const open = U.openSeats(st.seats.length, MAX_SEATS, st.settings.fillBots, BOT_NAMES.filter((n) => !used.includes(n)));
  const humans = st.seats.length;
  const controls = host
    ? U.hostControls({
      settings: st.settings, onSetting: (k, v) => send({ type: 'setSettings', settings: { [k]: v } }),
      players: st.settings.fillBots ? MAX_SEATS : humans, onStart: () => send({ type: 'start' }),
      onLeave: leaveTable, leaveText: 'Leave table',
      hint: 'Other optional rules come from your Settings when the table was created.',
    })
    : U.guestControls({ settings: st.settings, onLeave: leaveTable, waitText: 'Waiting for the host to start…' });
  box.replaceChildren(U.lobbyCard({
    code: st.code,
    sub: 'Send your friends the link (or the code). They open it, pick a nickname and join.',
    invite: inviteLink(st.code), copyLabel: 'Copy link', copied: 'Link copied.', toast: A.toast,
    countLabel: `Players (${humans}/${MAX_SEATS})`, seats, open, controls, fine: FINE_PRINT, status: connNote(),
  }));
}

function renderBar() {
  const st = W.st;
  const bar = $('#onlineBar');
  if (!st || st.phase === 'lobby') {
    bar.replaceChildren(...U.barNodes({ code: W.code || '', players: '…', mode: '1-6', notes: [connNote()].filter(Boolean), offline: true }));
    return;
  }
  const notes = [];
  const c = connNote();
  if (c) notes.push(c);
  if (st.phase === 'arrange' && st.deadline) notes.push(h('span', { class: 'ob-timer', id: 'obTimer', title: 'Time left to set hands', text: fmtClock(remainingMs() || 0) }));
  if (st.phase === 'showdown' && !amHost()) notes.push('Waiting for host…');
  const buttons = [];
  if (amHost()) {
    const away = st.seats.findIndex((s, i) => s.kind === 'human' && !s.connected && i !== st.you);
    if (away >= 0) buttons.push({ id: 'btnSeatBots', onclick: () => send({ type: 'seatBot', seat: away }), text: `Give ${st.seats[away].name}’s seat to a bot` });
  }
  buttons.push({ id: 'btnLeaveGame', onclick: leaveTable, text: 'Leave' });
  bar.replaceChildren(...U.barNodes({
    code: st.code, players: st.seats.length, mode: st.settings.mode, notes, buttons, offline: W.conn !== 'open',
  }));
}

// ---------- test hook ----------
function debug() {
  const st = W.st;
  const sd = st && st.phase === 'showdown' ? st.showdown : null;
  return {
    mode: 'ws', status: 'ready', view: W.view, conn: W.conn, name: W.name, code: W.code,
    phase: st?.phase ?? null, round: st?.round ?? null, you: st?.you ?? null, host: st?.host ?? null, isHost: amHost(),
    seats: st ? st.seats.map((s) => s.name) : [], kinds: st ? st.seats.map((s) => s.kind) : [],
    connected: st ? st.seats.map((s) => s.connected) : [],
    results: st ? st.results : [], totals: st ? st.totals : [],
    roundNet: sd ? sd.settlement.net.slice() : null, auto: sd ? sd.auto.slice() : null,
    sets: sd ? sd.sets : null, hand: st?.hand ?? null, submitted: st?.submitted ?? null,
    deadline: st?.deadline ?? null, remainingMs: remainingMs(),
  };
}
