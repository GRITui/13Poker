// Shared DOM for both online transports (claude.ai db in ./db.js, WebSocket server in ./ws.js): the home card, the
// lobby card, the status bar above the table. Everything other people typed is set as text, never as HTML.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs = {}, ...kids) {
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

export const HUMAN_COLORS = ['#9fe39a', '#c9a7ff', '#ffb36b', '#e8e1cf'];
export const BOT_COLORS = { Lin: '#f2c14e', Rosa: '#7cc7ff', Kai: '#ff9db0', Ada: '#9ee6dc' };
export const MODE_LABEL = { wsgc: 'WSGC', '1-6': 'Scoop ×2', '2-4': '2-4' };

/** Show the home/lobby panel, the in-game bar, or neither ('closed'). */
export function setPanel(v) {
  const panel = v === 'home' || v === 'lobby';
  document.body.classList.toggle('online-panel', panel);
  $('#lobby').hidden = !panel;
  if (panel) $('#toast').hidden = true; // don't let a single-player hint cover the lobby buttons
  $('#onlineBar').hidden = v !== 'game';
  if (panel) window.scrollTo({ top: 0 });
}

export function rulesSummary(s) {
  const extras = [s.royalties && 'royalties', s.naturals && 'naturals', s.allowEqualRows && 'equal rows allowed',
    s.wheelSecond && 'A-5 second-highest straight'].filter(Boolean);
  return `${MODE_LABEL[s.mode]} scoring · $${s.unitValue}/unit${extras.length ? ` · ${extras.join(', ')}` : ''}`;
}

export const finePrint = (text) => h('p', { class: 'lobby-fine', text });

/**
 * The "Play online" card. opts: { sub, top: [nodes], resume: {text, onclick}, busy, msg, code, onCreate, onJoin(code),
 * onBack, fine }.
 */
export function homeCard(o) {
  const input = h('input', {
    id: 'joinCode', class: 'code-input', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters',
    spellcheck: 'false', maxlength: '6', placeholder: 'CODE', 'aria-label': 'Table code', value: o.code || null,
  });
  const form = h('form', { class: 'join-form', onsubmit: (e) => { e.preventDefault(); o.onJoin(input.value); } },
    input, h('button', { type: 'submit', class: 'btn btn-primary', id: 'btnJoin', disabled: o.busy, text: 'Join' }));
  return h('div', { class: 'lobby-card' },
    h('h2', { text: 'Play online' }),
    h('p', { class: 'lobby-sub', text: o.sub }),
    o.top || null,
    o.resume && h('button', {
      type: 'button', class: 'btn btn-ghost lobby-wide', id: 'btnRejoin', disabled: o.busy, onclick: o.resume.onclick, text: o.resume.text,
    }),
    h('button', { type: 'button', class: 'btn btn-primary lobby-wide', id: 'btnCreate', disabled: o.busy, onclick: o.onCreate, text: 'Create a table' }),
    h('div', { class: 'lobby-or', text: 'or join with a code' }),
    form,
    h('p', { class: 'lobby-msg', role: 'alert', text: o.busy ? 'Working…' : o.msg || '' }),
    finePrint(o.fine),
    h('div', { class: 'lobby-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnSingle', onclick: o.onBack, text: 'Back to single player' })));
}

/** A lobby card that is still connecting. */
export function connectingCard(code, text, onLeave) {
  return h('div', { class: 'lobby-card' }, h('h2', { text: `Table ${code || ''}` }),
    h('p', { class: 'lobby-sub', text }),
    h('div', { class: 'lobby-actions' }, h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnLeave', onclick: onLeave, text: 'Leave' })));
}

/**
 * Seat list. seats: [{name, color, avatar, host, tags: [text], action: node}], open: [{name, color, avatar}].
 */
export function seatList(seats, open) {
  const list = h('ol', { class: 'lobby-seats' });
  for (const s of seats) {
    list.append(h('li', { class: `lobby-seat${s.away ? ' away' : ''}`, style: `--seat-color:${s.color}` },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: (s.avatar || '?').toUpperCase() }),
      h('span', { class: 'lobby-name', text: s.name }),
      s.host && h('span', { class: 'tag', text: 'Host' }),
      ...(s.tags || []).map((t) => h('span', { class: 'tag tag-dim', text: t })),
      s.action || null));
  }
  for (const o of open) {
    list.append(h('li', { class: 'lobby-seat open', style: o.color ? `--seat-color:${o.color}` : null },
      h('span', { class: 'avatar', 'aria-hidden': 'true', text: o.avatar || '' }),
      h('span', { class: 'lobby-name', text: o.name })));
  }
  return list;
}

/** Open seats shown in the lobby: bots (if the table fills with bots) or plain open seats. */
export function openSeats(taken, max, fillBots, botNames) {
  const out = [];
  for (let i = taken; i < max; i++) {
    const name = fillBots ? botNames[i - taken] : null;
    out.push(name ? { name: `${name} (AI bot, unless a friend joins)`, color: BOT_COLORS[name], avatar: name[0] } : { name: 'Open seat' });
  }
  return out;
}

/** Host controls: scoring, bots, Start, Leave. o: { settings, onSetting(key, value), players, onStart, onLeave, leaveText, hint } */
export function hostControls(o) {
  const t = o.settings;
  const modes = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Scoring' },
    ...['1-6', 'wsgc', '2-4'].map((m) => h('label', {},
      h('input', { type: 'radio', name: 'lobbyMode', value: m, checked: t.mode === m, onchange: () => o.onSetting('mode', m) }),
      h('span', { text: MODE_LABEL[m] }))));
  const bots = h('label', { class: 'lobby-check' },
    h('input', { type: 'checkbox', id: 'chkBots', checked: t.fillBots, onchange: (e) => o.onSetting('fillBots', e.target.checked) }),
    h('span', { text: 'Fill empty seats with AI bots (up to 4 players)' }));
  return h('div', { class: 'lobby-controls' },
    h('div', { class: 'lobby-label', text: 'Scoring' }), modes, bots,
    h('p', { class: 'lobby-hint', text: `${rulesSummary(t)}. ${o.hint}` }),
    h('div', { class: 'lobby-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnLeave', onclick: o.onLeave, text: o.leaveText }),
      h('button', { type: 'button', class: 'btn btn-primary', id: 'btnStart', disabled: o.players < 2, onclick: o.onStart, text: `Start game (${o.players} players)` })));
}

export function guestControls(o) {
  return h('div', { class: 'lobby-controls' },
    h('p', { class: 'lobby-hint', text: rulesSummary(o.settings) }),
    h('p', { class: 'lobby-wait', text: o.waitText }),
    h('div', { class: 'lobby-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnLeave', onclick: o.onLeave, text: 'Leave table' })));
}

/** Copy text to the clipboard, falling back to selecting it in `input`. */
export async function copyText(text, input, toast, okMsg = 'Invite copied.') {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* fall back */ }
  if (!ok) {
    input.focus(); input.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
  }
  toast(ok ? okMsg : 'Select the text and copy it.');
}

/**
 * The lobby card. o: { code, sub, invite, copyLabel, toast, countLabel, seats, open, controls, status, fine }
 */
export function lobbyCard(o) {
  const inviteBox = h('input', { class: 'invite-text', readonly: true, value: o.invite, 'aria-label': 'Invite' });
  return h('div', { class: 'lobby-card' },
    h('h2', {}, 'Table ', h('span', { class: 'table-code', id: 'tableCode', text: o.code })),
    h('p', { class: 'lobby-sub', text: o.sub }),
    h('div', { class: 'invite' }, inviteBox,
      h('button', { type: 'button', class: 'btn btn-ghost', id: 'btnCopy', onclick: () => copyText(o.invite, inviteBox, o.toast, o.copied), text: o.copyLabel || 'Copy invite' })),
    o.status ? h('p', { class: 'lobby-status', role: 'status', text: o.status }) : null,
    h('div', { class: 'lobby-label', text: o.countLabel }),
    seatList(o.seats, o.open),
    o.controls,
    finePrint(o.fine));
}

/** The bar above the table during a game. o: { code, players, mode, notes: [text|node], buttons: [{id, text, onclick}], offline } */
export function barNodes(o) {
  return [
    h('span', { class: `ob-dot${o.offline ? ' off' : ''}`, 'aria-hidden': 'true' }),
    h('span', { class: 'ob-text' }, 'Online · Table ', h('b', { text: o.code }), ` · ${o.players} players · ${MODE_LABEL[o.mode]}`),
    ...(o.notes || []).map((n) => (typeof n === 'string' ? h('span', { class: 'ob-note', text: n }) : n)),
    ...(o.buttons || []).map((b) => h('button', { type: 'button', class: 'btn btn-ghost btn-small', id: b.id, onclick: b.onclick, text: b.text })),
  ];
}
