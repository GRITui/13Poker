// Online play over the claude.ai Artifact runtime (the "db" transport; ./ws.js is the Cloudflare server one): `db` (shared documents with live snapshots) and `user`
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
import * as U from './ui.js';

const { $, h } = U;
const INVITE_URL = 'https://claude.ai/artifact/QczfZXbD7bJihbt1yfZLCp';
const SESSION_KEY = '13poker.online.table';
const HUMAN_COLORS = U.HUMAN_COLORS;
const BOTS = {
  'bot-0': { name: 'Lin', color: U.BOT_COLORS.Lin },
  'bot-1': { name: 'Rosa', color: U.BOT_COLORS.Rosa },
  'bot-2': { name: 'Kai', color: U.BOT_COLORS.Kai },
};
const FINE_PRINT = 'Friendly play only: every hand is worked out from a shared random seed, so a determined player could peek. It isn’t cheat-proof, so don’t play for real money.';

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
/** Start the claude.ai transport. ./online.js owns the Online button and forwards clicks to onButton. */
export function startDb(api) {
  A = api;
  start();
  return { onButton, debug: debugState };
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
  if (v === 'home') renderHome();
  if (v === 'lobby') renderLobby();
  U.setPanel(v);
}

function renderHome() {
  $('#lobby').replaceChildren(U.homeCard({
    sub: 'Play with 1–3 friends. Each of you opens this game on claude.ai. One person creates a table and shares its code; AI bots can fill the empty seats.',
    resume: S.resumable && { text: `Rejoin table ${S.resumable.code}`, onclick: () => joinTable(S.resumable.code) },
    busy: S.busy, msg: S.homeMsg, fine: FINE_PRINT,
    onCreate: createTable, onJoin: joinTable, onBack: () => showView('closed'),
  }));
}

function renderLobby() {
  const box = $('#lobby');
  const t = S.table;
  if (!t) { box.replaceChildren(U.connectingCard(S.code, 'Connecting to the table…', leaveTable)); return; }
  const host = isHost();
  const seatedMe = t.seats.some((s) => s.id === S.uid);
  const seats = t.seats.map((s, i) => ({
    name: s.id === S.uid ? (S.names[s.id] ? `You (${S.names[s.id]})` : 'You') : nameOf(s.id),
    color: HUMAN_COLORS[i], avatar: s.id === S.uid ? 'Y' : nameOf(s.id)[0], host: s.id === t.host,
  }));
  const open = U.openSeats(t.seats.length, T.MAX_SEATS, t.settings.fillBots, T.BOT_IDS.map((id) => BOTS[id].name));
  const controls = host
    ? U.hostControls({
      settings: t.settings, onSetting: hostSetting, players: T.startingSeats(t.seats, t.settings.fillBots).length,
      onStart: hostStart, onLeave: leaveTable, leaveText: 'Close table',
      hint: 'Other optional rules come from your Settings when the table was created.',
    })
    : U.guestControls({
      settings: t.settings, onLeave: leaveTable,
      waitText: seatedMe ? 'Waiting for the host to start…' : t.seats.length >= T.MAX_SEATS ? 'This table is full.' : 'Joining…',
    });
  box.replaceChildren(U.lobbyCard({
    code: t.code,
    sub: 'Share the code. Friends open this game on claude.ai, tap Online → Join and enter it.',
    invite: `Join my 13 Poker table: open ${INVITE_URL} , choose Online → Join, and enter code ${t.code}`,
    toast: A.toast, countLabel: `Players (${t.seats.length}/${T.MAX_SEATS})`, seats, open, controls, fine: FINE_PRINT,
  }));
}

function renderBar(status) {
  const t = S.table;
  const waitingOn = status.filter((s) => s.kind === 'human' && !s.ready).length;
  const gone = isHost() ? absentHumans() : [];
  const notes = [];
  if (!isHost() && t.phase === 'showdown') notes.push('Waiting for the host to deal');
  else if (waitingOn && !isHost() && !S.players.has(t.host)) notes.push('The host has left; the table is stalled');
  const buttons = [];
  if (gone.length) {
    buttons.push({
      id: 'btnSeatBots', onclick: hostSeatBots,
      text: `Give ${gone.length === 1 ? `${nameOf(gone[0])}’s seat` : `${gone.length} empty seats`} to a bot`,
    });
  }
  buttons.push({ id: 'btnLeaveGame', onclick: leaveTable, text: isHost() ? 'Close table' : 'Leave' });
  $('#onlineBar').replaceChildren(...U.barNodes({ code: t.code, players: t.seats.length, mode: t.settings.mode, notes, buttons }));
}

// ---------- test hook ----------
function debugState() {
  const t = S.table;
  return {
    mode: 'db', status: S.status, view: S.view, uid: S.uid, code: S.code, hostId: S.hostId, isHost: isHost(),
    phase: t?.phase ?? null, round: t?.round ?? null, seats: t ? t.seats.map((s) => s.id) : [],
    results: t ? t.results : [], totals: t ? T.totalsOf(t.results, t.seats.length) : [],
    roundNet: S.res && S.resKey === (t && `${t.code}:${t.seed}:${t.round}`) ? S.res.settlement.net.slice() : null,
  };
}
