// Online play over the claude.ai Artifact runtime: `db` (shared documents with live snapshots) and `user`
// (viewer id + profile names). Everything degrades to single player when the runtime is absent.
//
// Shared documents (all untrusted; every read goes through ./table.js sanitizers):
//   tables/{hostId}   the table, written only by its host: {code, host, createdAt, updatedAt, phase, round, seed,
//                     seats: [{id, kind}], settings, results: [{round, net[]}]}
//   players/{uid}     one per person, written only by that person: {table: code, joinedAt, round?, front?,
//                     middle?, back?, declareNatural?}  (joining = writing it; the set hand for the round lives here)
// Every client deals the same cards from the table's seed and arranges bots the same way, so nobody writes bot
// hands. The host folds joiners into the seats while in the lobby, records each round's result, and moves on.
import * as T from './table.js';
import { loadSettings } from '../ui/store.js';

const INVITE_URL = 'https://claude.ai/artifact/QczfZXbD7bJihbt1yfZLCp';
const SESSION_KEY = '13poker.online.table';
const HUMAN_COLORS = ['#9fe39a', '#c9a7ff', '#ffb36b', '#e8e1cf'];
const BOTS = {
  'bot-0': { name: 'Lin', color: '#f2c14e' },
  'bot-1': { name: 'Rosa', color: '#7cc7ff' },
  'bot-2': { name: 'Kai', color: '#ff9db0' },
};
const MODE_LABEL = { wsgc: 'WSGC', '1-6': 'Scoop ×2', '2-4': '2-4' };
const FINE_PRINT = 'Friendly play only: every hand is worked out from a shared random seed, so a determined player could peek. It isn’t cheat-proof, so don’t play for real money.';

const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
}
function sessionGet() { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } }
function sessionSet(v) {
  try { if (v) sessionStorage.setItem(SESSION_KEY, v); else sessionStorage.removeItem(SESSION_KEY); } catch { /* unavailable */ }
}
function writeError(e) {
  const code = e && e.code;
  if (code === 'invalid_argument') return 'Couldn’t save. You may need Contributor access to this game to play online.';
  if (code === 'quota_exceeded') return 'The game’s shared storage is full.';
  if (code === 'resource_exhausted') return 'Too many requests. Wait a moment and try again.';
  return 'Couldn’t reach the table. Check your connection and try again.';
}

let A = null; // hooks into main.js
const S = {
  status: 'pending', // 'pending' | 'off' | 'ready'
  offReason: 'Checking whether online play is available…',
  db: null, user: null, uid: null,
  view: 'closed', // 'closed' | 'home' | 'lobby' | 'game'
  homeMsg: '',
  busy: false,
  resumable: null, // {code} of a table this person is still at
  // attached table
  code: null, hostId: null, table: null, tableSeen: false, players: new Map(), playersSeen: false, unsub: [],
  names: {},
  roundKey: null, phaseAtEnter: null, showdownKey: null, res: null, resKey: null, resultsSig: '',
  chain: Promise.resolve(), pendingSig: null, lastSig: null,
  ctx: null,
};

const isHost = () => !!S.uid && S.hostId === S.uid;
const nameOf = (id) => (id === S.uid ? 'You' : BOTS[id]?.name || S.names[id] || 'Someone');

// ---------- start-up ----------
export function initOnline(api) {
  A = api;
  const btn = $('#btnOnline');
  btn.addEventListener('click', onButton);
  start();
  return debugState;
}

async function start() {
  const cl = window.claude;
  if (!cl || typeof cl.use !== 'function') {
    setOff('Online play works when this game is opened on claude.ai.');
    return;
  }
  let db = null; let user = null;
  try { [db, user] = await Promise.all([cl.use('db'), cl.use('user')]); } catch { /* treated as unavailable */ }
  if (!db) { setOff('Online play isn’t available here. Open the game on claude.ai while signed in.'); return; }
  let uid = null;
  try { uid = user ? await user.id() : null; } catch { uid = null; }
  if (!T.isId(uid)) { setOff('Sign in to claude.ai to play online.'); return; }
  let canWrite = null;
  try { canWrite = user.can ? await user.can('data.write') : null; } catch { canWrite = null; }
  if (canWrite === false) { setOff('You can view this game but not play online. Ask its owner for Contributor access.'); return; }
  Object.assign(S, { db, user, uid, status: 'ready', offReason: '' });
  const btn = $('#btnOnline');
  btn.disabled = false;
  btn.removeAttribute('aria-disabled');
  btn.classList.remove('is-off');
  btn.title = 'Play online with friends';
  await resume();
}

function setOff(reason) {
  S.status = 'off';
  S.offReason = reason;
  const btn = $('#btnOnline');
  btn.disabled = false; // stays clickable so it can explain itself
  btn.setAttribute('aria-disabled', 'true');
  btn.classList.add('is-off');
  btn.title = reason;
}

function onButton() {
  if (S.status !== 'ready') { A.toast(S.offReason); return; }
  if (S.code && S.view === 'game') { A.toast(`You’re at table ${S.code}.`); return; }
  if (S.code) { showView('lobby'); return; }
  showView(S.view === 'home' ? 'closed' : 'home');
}

/** On load: if this person is still at a table, offer to rejoin it (or rejoin straight away after a refresh). */
async function resume() {
  try {
    const snap = await S.db.doc(`players/${S.uid}`).get();
    const p = snap.exists ? T.sanitizePlayer(snap.data(), S.uid) : null;
    if (!p) return;
    const found = await findTable(p.table);
    if (!found) return;
    const seated = found.table.seats.some((s) => s.id === S.uid);
    if (!seated && found.table.phase !== 'lobby') return;
    S.resumable = { code: p.table };
    if (sessionGet() === p.table && !S.code) {
      attach(found.hostId, p.table);
      A.toast(`Rejoined table ${p.table}.`);
    } else if (S.view === 'home') {
      renderHome();
    }
  } catch { /* nothing to resume */ }
}

async function findTable(code) {
  const qs = await S.db.collection('tables').where('code', '==', code).limit(10).get();
  let best = null;
  for (const d of qs.docs) {
    const t = T.sanitizeTable(d.data(), d.id);
    if (t && (!best || t.createdAt > best.table.createdAt)) best = { hostId: d.id, table: t };
  }
  return best;
}

// ---------- actions ----------
async function busy(fn) {
  if (S.busy) return;
  S.busy = true;
  S.homeMsg = '';
  if (S.view === 'home') renderHome();
  try { await fn(); } catch (e) { S.homeMsg = writeError(e); } finally {
    S.busy = false;
    if (S.view === 'home') renderHome();
  }
}

function createTable() {
  return busy(async () => {
    let code = null;
    for (let i = 0; i < 8 && !code; i++) {
      const c = T.makeCode();
      const qs = await S.db.collection('tables').where('code', '==', c).limit(1).get();
      if (qs.empty) code = c;
    }
    if (!code) { S.homeMsg = 'Couldn’t find a free table code. Try again.'; return; }
    const ls = loadSettings();
    const now = Date.now();
    await S.db.doc(`tables/${S.uid}`).set({
      code, host: S.uid, createdAt: now, updatedAt: now, phase: 'lobby', round: 0, seed: 0,
      seats: [{ id: S.uid, kind: 'human' }],
      settings: T.sanitizeSettings({
        mode: ls.mode, unitValue: ls.unitValue, royalties: ls.royalties, royaltyRequiresRowWin: ls.royaltyRequiresRowWin,
        naturals: ls.naturals, allowEqualRows: ls.allowEqualRows, wheelSecond: ls.wheelSecond, fillBots: true,
      }),
      results: [],
    });
    await S.db.doc(`players/${S.uid}`).set({ table: code, joinedAt: now });
    attach(S.uid, code);
  });
}

function joinTable(input) {
  return busy(async () => {
    const code = T.normalizeCode(input);
    if (!code) { S.homeMsg = 'Enter the 4-character table code.'; return; }
    const found = await findTable(code);
    if (!found) { S.homeMsg = `No table with code ${code}.`; return; }
    const { hostId, table } = found;
    const seated = table.seats.some((s) => s.id === S.uid);
    if (table.phase !== 'lobby' && !seated) { S.homeMsg = 'That game has already started.'; return; }
    if (table.phase === 'lobby' && !seated && table.seats.length >= T.MAX_SEATS) { S.homeMsg = 'That table is full.'; return; }
    const snap = await S.db.doc(`players/${S.uid}`).get();
    const mine = snap.exists ? T.sanitizePlayer(snap.data(), S.uid) : null;
    if (!mine || mine.table !== code) await S.db.doc(`players/${S.uid}`).set({ table: code, joinedAt: Date.now() });
    attach(hostId, code);
  });
}

async function leaveTable() {
  const host = isHost();
  const inGame = S.table && S.table.phase !== 'lobby';
  const q = host ? 'Close this table for everyone?'
    : inGame ? 'Leave the game? The others will wait for you until the host gives your seat to a bot.' : null;
  if (q && !confirm(q)) return;
  const { db, uid } = S;
  detach();
  S.resumable = null;
  showView('closed');
  if (A.key()) A.leave();
  A.toast(host ? 'Table closed.' : 'You left the table.');
  try {
    if (host) await db.doc(`tables/${uid}`).delete();
    await db.doc(`players/${uid}`).delete();
  } catch { /* best effort */ }
}

/** The table went away (closed by the host, replaced, or unreadable). */
function tableGone(msg) {
  detach();
  S.resumable = null;
  if (A.key()) A.leave();
  S.homeMsg = msg;
  showView('home');
}

// ---------- host writes (one at a time, only on change) ----------
function hostWrite(patch) {
  if (!isHost()) return;
  const sig = JSON.stringify(patch);
  if (sig === S.pendingSig || sig === S.lastSig) return;
  S.pendingSig = sig;
  const { db, uid } = S;
  S.chain = S.chain
    .then(() => db.doc(`tables/${uid}`).update({ ...patch, updatedAt: Date.now() }))
    .then(() => { S.lastSig = sig; })
    .catch((e) => { A.toast(writeError(e)); })
    .finally(() => { if (S.pendingSig === sig) S.pendingSig = null; });
}

function hostSetting(key, value) {
  const t = S.table;
  if (!t || t.phase !== 'lobby' || t.settings[key] === value) return;
  hostWrite({ settings: { ...t.settings, [key]: value } });
}

function hostStart() {
  const t = S.table;
  if (!isHost() || !t || t.phase !== 'lobby') return;
  const humans = T.foldSeats(t.seats, [...S.players.values()], S.uid);
  const seats = T.startingSeats(humans, t.settings.fillBots);
  if (seats.length < 2) { A.toast('You need at least one more player, or turn on AI bots.'); return; }
  hostWrite({ phase: 'arrange', round: 1, seed: 1 + Math.floor(Math.random() * 0x7ffffffe), seats, results: [] });
}

function hostNext() {
  const t = S.table;
  if (!isHost() || !t || t.phase === 'lobby') return;
  const res = currentResult();
  if (!res) return;
  hostWrite({ phase: 'arrange', round: t.round + 1, results: T.appendResult(t.results, t.round, res.settlement.net) });
}

function hostSeatBots() {
  const t = S.table;
  if (!isHost() || !t || t.phase === 'lobby') return;
  const gone = absentHumans();
  if (gone.length) hostWrite({ seats: T.replaceWithBots(t.seats, gone) });
}

function absentHumans() {
  const t = S.table;
  return t.seats.filter((s) => s.kind === 'human' && s.id !== S.uid && S.players.get(s.id)?.table !== t.code).map((s) => s.id);
}

// ---------- subscriptions ----------
function attach(hostId, code) {
  detach();
  Object.assign(S, {
    code, hostId, table: null, tableSeen: false, players: new Map(), playersSeen: false,
    roundKey: null, showdownKey: null, res: null, resKey: null, resultsSig: '', pendingSig: null, lastSig: null,
  });
  sessionSet(code);
  showView('lobby');
  S.unsub.push(S.db.doc(`tables/${hostId}`).onSnapshot(onTable, onSubError));
  S.unsub.push(S.db.collection('players').where('table', '==', code).onSnapshot(onPlayers, onSubError));
}

function detach() {
  for (const u of S.unsub) { try { u(); } catch { /* already closed */ } }
  S.unsub = [];
  S.code = null; S.hostId = null; S.table = null; S.ctx = null;
  sessionSet(null);
  const bar = $('#onlineBar');
  if (bar) bar.hidden = true;
}

function onSubError(e) {
  if (!S.code) return;
  tableGone(e && e.code === 'revoked' ? 'Online access for this page was turned off.' : 'Lost the connection to the table. Join again with the code.');
}

function onTable(snap) {
  if (!S.code) return;
  S.tableSeen = true;
  if (!snap.exists) { tableGone(S.table ? 'The host closed the table.' : 'That table no longer exists.'); return; }
  const t = T.sanitizeTable(snap.data(), snap.id);
  if (!t || t.code !== S.code) { tableGone('That table is no longer available.'); return; }
  S.table = t;
  update();
}

function onPlayers(qs) {
  if (!S.code) return;
  const m = new Map();
  for (const d of qs.docs) {
    const p = T.sanitizePlayer(d.data(), d.id);
    if (p && p.table === S.code) m.set(p.id, p);
  }
  S.players = m;
  S.playersSeen = true;
  update();
}

// ---------- state -> view ----------
function refreshNames() {
  const t = S.table;
  const ids = [...new Set([...t.seats.filter((s) => s.kind === 'human').map((s) => s.id), ...S.players.keys()])]
    .filter((id) => id !== S.uid);
  if (!ids.length || !S.user) return;
  S.user.profiles(ids).then((ps) => {
    let changed = false;
    for (const id of ids) {
      const n = (ps && ps[id] && typeof ps[id].name === 'string' && ps[id].name) || '';
      if ((S.names[id] || '') !== n) { S.names[id] = n; changed = true; }
    }
    if (changed && S.table) update();
  }, () => {});
}

function currentResult() {
  const t = S.table;
  const key = `${t.code}:${t.seed}:${t.round}`;
  if (S.resKey === key && S.res) return S.res;
  const res = T.scoreRound(t, S.players);
  if (res) { S.res = res; S.resKey = key; }
  return res;
}

function update() {
  if (!S.code || !S.tableSeen || !S.playersSeen || !S.table) return;
  const t = S.table;
  refreshNames();

  if (t.phase === 'lobby') {
    if (isHost()) {
      const folded = T.foldSeats(t.seats, [...S.players.values()], S.uid);
      if (!T.sameSeats(folded, t.seats)) hostWrite({ seats: folded });
    }
    if (S.view !== 'lobby') showView('lobby'); else renderLobby();
    return;
  }

  const n = t.seats.length;
  const me = t.seats.findIndex((s) => s.id === S.uid);
  if (me < 0) { tableGone('The game started without you (the table was full).'); return; }
  const hands = T.roundHands(t.seed, t.round, n);
  const status = T.seatStatus(t, S.players, hands);
  const order = T.rotation(n, me);
  const key = `${t.code}:${t.seed}:${t.round}`;
  const opps = order.slice(1).map((i) => {
    const s = t.seats[i];
    const bot = BOTS[s.id];
    return {
      name: s.kind === 'bot' ? bot.name : nameOf(s.id),
      color: s.kind === 'bot' ? bot.color : HUMAN_COLORS[i],
      kind: s.kind, here: status[i].here, ready: status[i].ready,
    };
  });

  if (S.view !== 'game') showView('game');
  if (A.key() !== key) {
    S.ctx = makeCtx(t);
    S.phaseAtEnter = t.phase;
    S.showdownKey = null;
    A.enterRound({ key, round: t.round, hands: order.map((i) => hands[i]), opps }, S.ctx);
  } else {
    S.ctx.rules = t.settings;
    A.setOpps(opps);
  }
  if (status[me].ready) A.restoreSubmitted(status[me].sub.set, status[me].sub.declareNatural);

  if (status.every((s) => s.ready)) {
    const res = currentResult();
    if (res && S.showdownKey !== key && ['sending', 'waiting'].includes(A.phase())) {
      S.showdownKey = key;
      A.showdown({
        sets: order.map((i) => res.sets[i]),
        players: order.map((i) => res.players[i]),
        settlement: T.rotateSettlement(res.settlement, order),
      }, S.phaseAtEnter === 'showdown');
    }
    if (res && isHost() && t.phase === 'arrange') {
      hostWrite({ phase: 'showdown', results: T.appendResult(t.results, t.round, res.settlement.net) });
    }
  }
  const sig = JSON.stringify(t.results);
  if (sig !== S.resultsSig) { S.resultsSig = sig; A.refreshScores(); }
  renderBar(status);
}

/** The object main.js reads while a game is on (see `online` in main.js). */
function makeCtx(t) {
  return {
    rules: t.settings,
    isHost: isHost(),
    book() {
      const tb = S.table;
      const me = tb.seats.findIndex((s) => s.id === S.uid);
      const order = T.rotation(tb.seats.length, me);
      const rounds = tb.results.map((r) => ({ round: r.round, net: order.map((i) => r.net[i]) }));
      const key = `${tb.code}:${tb.seed}:${tb.round}`;
      if (S.showdownKey === key && A.phase() === 'results' && S.res && !tb.results.some((r) => r.round === tb.round)) {
        rounds.push({ round: tb.round, net: order.map((i) => S.res.settlement.net[i]) });
      }
      return { names: order.map((i) => nameOf(tb.seats[i].id)), rounds };
    },
    async submit(set, declareNatural) {
      const tb = S.table;
      if (!tb) return false;
      try {
        await S.db.doc(`players/${S.uid}`).set({
          table: tb.code,
          joinedAt: S.players.get(S.uid)?.joinedAt || Date.now(),
          round: tb.round,
          front: set.front, middle: set.middle, back: set.back,
          declareNatural: !!declareNatural,
        });
        return true;
      } catch (e) {
        A.toast(writeError(e));
        return false;
      }
    },
    next: hostNext,
  };
}

// ---------- DOM ----------
function showView(v) {
  S.view = v;
  const panel = v === 'home' || v === 'lobby';
  document.body.classList.toggle('online-panel', panel);
  $('#lobby').hidden = !panel;
  if (panel) $('#toast').hidden = true; // don't let a single-player hint cover the lobby buttons
  $('#onlineBar').hidden = v !== 'game';
  if (v === 'home') renderHome();
  if (v === 'lobby') renderLobby();
  if (panel) window.scrollTo({ top: 0 });
}

function finePrint() { return h('p', { class: 'lobby-fine', text: FINE_PRINT }); }

function renderHome() {
  const box = $('#lobby');
  const input = h('input', {
    id: 'joinCode', class: 'code-input', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', maxlength: '6', placeholder: 'CODE', 'aria-label': 'Table code',
  });
  const form = h('form', { class: 'join-form', onsubmit: (e) => { e.preventDefault(); joinTable(input.value); } },
    input, h('button', { type: 'submit', class: 'btn btn-primary', id: 'btnJoin', disabled: S.busy, text: 'Join' }));
  const card = h('div', { class: 'lobby-card' },
    h('h2', { text: 'Play online' }),
    h('p', { class: 'lobby-sub', text: 'Play with 1–3 friends. Each of you opens this game on claude.ai. One person creates a table and shares its code; AI bots can fill the empty seats.' }),
    S.resumable && h('button', {
      type: 'button', class: 'btn btn-ghost lobby-wide', id: 'btnRejoin', disabled: S.busy,
      onclick: () => joinTable(S.resumable.code), text: `Rejoin table ${S.resumable.code}`,
    }),
    h('button', { type: 'button', class: 'btn btn-primary lobby-wide', id: 'btnCreate', disabled: S.busy, onclick: createTable, text: 'Create a table' }),
    h('div', { class: 'lobby-or', text: 'or join with a code' }),
    form,
    h('p', { class: 'lobby-msg', role: 'alert', text: S.busy ? 'Working…' : S.homeMsg }),
    finePrint(),
    h('div', { class: 'lobby-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnSingle', onclick: () => showView('closed'), text: 'Back to single player' })),
  );
  box.replaceChildren(card);
}

function rulesSummary(s) {
  const extras = [s.royalties && 'royalties', s.naturals && 'naturals', s.allowEqualRows && 'equal rows allowed',
    s.wheelSecond && 'A-5 second-highest straight'].filter(Boolean);
  return `${MODE_LABEL[s.mode]} scoring · $${s.unitValue}/unit${extras.length ? ` · ${extras.join(', ')}` : ''}`;
}

function renderLobby() {
  const box = $('#lobby');
  const t = S.table;
  if (!t) {
    box.replaceChildren(h('div', { class: 'lobby-card' }, h('h2', { text: `Table ${S.code || ''}` }),
      h('p', { class: 'lobby-sub', text: 'Connecting to the table…' }),
      h('div', { class: 'lobby-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: leaveTable, text: 'Leave' }))));
    return;
  }
  const host = isHost();
  const seatedMe = t.seats.some((s) => s.id === S.uid);
  const invite = `Join my 13 Poker table: open ${INVITE_URL} , choose Online → Join, and enter code ${t.code}`;
  const inviteBox = h('input', { class: 'invite-text', readonly: true, value: invite, 'aria-label': 'Invite text' });
  const copy = async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(invite); ok = true; } catch { /* fall back */ }
    if (!ok) {
      inviteBox.focus(); inviteBox.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    A.toast(ok ? 'Invite copied.' : 'Select the text and copy it.');
  };

  const list = h('ol', { class: 'lobby-seats' });
  t.seats.forEach((s, i) => {
    const nm = s.id === S.uid ? (S.names[s.id] ? `You (${S.names[s.id]})` : 'You') : nameOf(s.id);
    list.append(h('li', { class: 'lobby-seat', style: `--seat-color:${HUMAN_COLORS[i]}` },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: (s.id === S.uid ? 'Y' : nameOf(s.id)[0] || '?').toUpperCase() }),
      h('span', { class: 'lobby-name', text: nm }),
      s.id === t.host && h('span', { class: 'tag', text: 'Host' })));
  });
  const botIds = T.BOT_IDS.slice();
  for (let i = t.seats.length; i < T.MAX_SEATS; i++) {
    const bot = t.settings.fillBots ? BOTS[botIds[i - t.seats.length]] : null;
    list.append(h('li', { class: 'lobby-seat open', style: bot ? `--seat-color:${bot.color}` : null },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: bot ? bot.name[0] : '' }),
      h('span', { class: 'lobby-name', text: bot ? `${bot.name} (AI bot, unless a friend joins)` : 'Open seat' })));
  }

  let controls;
  if (host) {
    const modes = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Scoring' },
      ...['1-6', 'wsgc', '2-4'].map((m) => h('label', {},
        h('input', { type: 'radio', name: 'lobbyMode', value: m, checked: t.settings.mode === m, onchange: () => hostSetting('mode', m) }),
        h('span', { text: MODE_LABEL[m] }))));
    const bots = h('label', { class: 'lobby-check' },
      h('input', { type: 'checkbox', id: 'chkBots', checked: t.settings.fillBots, onchange: (e) => hostSetting('fillBots', e.target.checked) }),
      h('span', { text: 'Fill empty seats with AI bots (up to 4 players)' }));
    const players = T.startingSeats(t.seats, t.settings.fillBots).length;
    controls = h('div', { class: 'lobby-controls' },
      h('div', { class: 'lobby-label', text: 'Scoring' }), modes, bots,
      h('p', { class: 'lobby-hint', text: `${rulesSummary(t.settings)}. Other optional rules come from your Settings when the table was created.` }),
      h('div', { class: 'lobby-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnLeave', onclick: leaveTable, text: 'Close table' }),
        h('button', { type: 'button', class: 'btn btn-primary', id: 'btnStart', disabled: players < 2, onclick: hostStart, text: `Start game (${players} players)` })));
  } else {
    controls = h('div', { class: 'lobby-controls' },
      h('p', { class: 'lobby-hint', text: rulesSummary(t.settings) }),
      h('p', { class: 'lobby-wait', text: seatedMe ? 'Waiting for the host to start…'
        : t.seats.length >= T.MAX_SEATS ? 'This table is full.' : 'Joining…' }),
      h('div', { class: 'lobby-actions' },
        h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnLeave', onclick: leaveTable, text: 'Leave table' })));
  }

  box.replaceChildren(h('div', { class: 'lobby-card' },
    h('h2', {}, 'Table ', h('span', { class: 'table-code', id: 'tableCode', text: t.code })),
    h('p', { class: 'lobby-sub', text: 'Share the code. Friends open this game on claude.ai, tap Online → Join and enter it.' }),
    h('div', { class: 'invite' }, inviteBox, h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnCopy', onclick: copy, text: 'Copy invite' })),
    h('div', { class: 'lobby-label', text: `Players (${t.seats.length}/${T.MAX_SEATS})` }),
    list,
    controls,
    finePrint()));
}

function renderBar(status) {
  const bar = $('#onlineBar');
  const t = S.table;
  const waitingOn = status.filter((s) => s.kind === 'human' && !s.ready).length;
  const gone = isHost() ? absentHumans() : [];
  const kids = [
    h('span', { class: 'ob-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'ob-text' }, 'Online · Table ', h('b', { text: t.code }),
      ` · ${t.seats.length} players · ${MODE_LABEL[t.settings.mode]}`),
  ];
  if (!isHost() && t.phase === 'showdown') kids.push(h('span', { class: 'ob-note', text: 'Waiting for the host to deal' }));
  else if (waitingOn && !isHost() && !S.players.has(t.host)) kids.push(h('span', { class: 'ob-note', text: 'The host has left; the table is stalled' }));
  if (gone.length) {
    kids.push(h('button', {
      type: 'button', class: 'btn btn-ghost btn-small', id: 'btnSeatBots', onclick: hostSeatBots,
      text: `Give ${gone.length === 1 ? `${nameOf(gone[0])}’s seat` : `${gone.length} empty seats`} to a bot`,
    }));
  }
  kids.push(h('button', { type: 'button', class: 'btn btn-ghost btn-small', id: 'btnLeaveGame', onclick: leaveTable, text: isHost() ? 'Close table' : 'Leave' }));
  bar.replaceChildren(...kids);
}

// ---------- test hook ----------
function debugState() {
  const t = S.table;
  return {
    status: S.status, view: S.view, uid: S.uid, code: S.code, hostId: S.hostId, isHost: isHost(),
    phase: t?.phase ?? null, round: t?.round ?? null, seats: t ? t.seats.map((s) => s.id) : [],
    results: t ? t.results : [], totals: t ? T.totalsOf(t.results, t.seats.length) : [],
    roundNet: S.res && S.resKey === (t && `${t.code}:${t.seed}:${t.round}`) ? S.res.settlement.net.slice() : null,
  };
}
