# 13 Poker: Chinese Poker in the browser

A playable 13-card Chinese Poker game. You play against 1 to 3 AI opponents. Each player splits 13 cards into a
**Back** (5 cards), **Middle** (5) and **Front** (3) hand, and each hand is compared with the same hand of every
other player.

It is a plain static site: `index.html` + `css/` + `js/` (ES modules). There is no build step and no runtime
dependency, so it runs on any static server, including GitHub Pages. For public online play there is also a small
Cloudflare Worker (`worker/`) that serves the same files and runs the tables; see
[Online server (Cloudflare)](#online-server-cloudflare).

## Run it

```sh
python3 -m http.server 8000     # or any static server
# open http://localhost:8000/
```

ES modules don't load from `file://`, so serve it rather than double-clicking `index.html`. On GitHub Pages, publish
the repository root.

Add `?seed=123` to the URL for repeatable deals, which helps with debugging and automated tests.

## Features

- 1 human vs 1–3 AI opponents (default 3, so all 52 cards are dealt), or **online with friends** (see below).
- Cards are dealt straight into Front / Middle / Back at random (setting `randomDeal`, on by default). Swap cards by
  **tap/click** (tap a card, then a card in another row) or by **drag-and-drop**, then press **Set hand**. Dragging
  uses Pointer Events, so it works with touch, mouse and pen.
- Live validation: each row shows its hand name, and the game warns as soon as the order is broken (Back must beat
  Middle, Middle must beat Front). A fouled hand can't be submitted.
- AI opponents: an exhaustive search over all 72,072 Back/Middle/Front splits, scored by a heuristic estimate of each
  row's chance to win. Takes about 15–45 ms per hand.
- Showdown: opponents' rows flip over Front → Middle → Back, with a win/loss/tie chip per row (from your point of
  view). Then come the pairwise totals, a head-to-head matrix, a zero-sum check and a running scoreboard (units and $).
  Tap the table to skip the animation.
- Settings: number of opponents, scoring mode (`1-6` "scoop ×2" default, `wsgc`, `2-4`), unit value ($1–$10), card back (blue or
  red), and optional rules: royalties (plus "royalty only if that row wins"), naturals, allow equal rows,
  A-2-3-4-5 as the second-highest straight, and animations on or off. Settings and scores are saved in `localStorage`.
- A "How to play" panel. The layout works from desktop down to 375 px phones without horizontal scrolling.

## Online play

The Online button picks a transport when the page loads:

1. **Inside a claude.ai Artifact** (`window.claude` exists): the claude.ai mode below.
2. **Served by the 13 Poker Worker** (the page carries an `X-13Poker-Online: ws` header, set by `_headers`, and
   `GET /api/health` answers): the WebSocket server mode, see [Online server (Cloudflare)](#online-server-cloudflare).
3. **Anywhere else** (plain static server, GitHub Pages): the button only explains that online play isn't available.

Both modes share the lobby, status bar and showdown UI (`js/online/ui.js` + the hooks in `js/main.js`). Single player
never depends on either.

### claude.ai mode

When the game is opened as a claude.ai Artifact, the **Online** button lets 2–4 people play together: one person
creates a table and shares its 4-character code (no I, L, O, 0 or 1); the others choose **Join** and enter it. The
host picks the scoring mode, can fill empty seats with AI bots, starts the game and deals each next round. Everyone
sees who has set their hand, the same showdown and the same running totals. A refresh rejoins the table and restores a
hand you already set. If someone leaves mid-game, the host can give their seat to a bot.

It uses the Artifact runtime's `db` capability (shared documents with live snapshots) and `user` (viewer id and
profile names, resolved at render time; only ids are stored):

- `tables/{hostId}`: the table, written only by its host (`{code, host, phase: lobby|arrange|showdown, round, seed,
  seats: [{id, kind: human|bot}], settings, results: [{round, net[]}]}`).
- `players/{uid}`: one per person, written only by that person: which table they are at, and their set hand for the
  current round.

Every client deals the same cards from the table's seed and arranges the bots' hands the same way, so nobody writes
bot hands, and the host only records each round's result. Everything read from the shared store is validated
(`js/online/table.js`). **This is for friendly games:** all hands can be derived from the shared seed, so a
determined player could peek. It is not cheat-proof; don't play for money.

Outside claude.ai (a plain static server, GitHub Pages, signed out) `window.claude` is missing or `use("db")`
resolves `null`; the Online button then only explains why, and single player works as before.

## Online server (Cloudflare)

`wrangler.jsonc` deploys one Worker that serves the static site (Workers Static Assets: `index.html`, `css/`, `js/`,
`assets/`; `.assetsignore` keeps `worker/`, `tests/`, `docs/`, `node_modules` and repo config private) and runs **one
Durable Object per table**. The Worker only runs for `/api/*` and `/ws`; everything else is served as a static file.

The server is the authority, so this version is fair:

- it shuffles with `crypto.getRandomValues` and sends each player **only their own 13 cards**;
- it accepts a set hand only if it uses exactly the dealt cards and isn't fouled (unless it declares a natural the
  cards really hold);
- it reveals every hand only at the showdown, scores with the same engine (`settle`, scoop ×2, scoop-everyone ×4,
  optional royalties/naturals) and keeps per-round results and running totals;
- AI bots (if the host fills empty seats) and late players are set server-side with `arrangeHand`.

It's still for points, not real money.

### How to play online

Tap **Online**, choose a nickname (1–16 characters, saved in this browser), then **Create a table** and send the
invite link `https://<your-host>/?table=CODE` (or just the 4-character code). Opening the link pre-fills the code and
joins at once if you already have a nickname. The host picks the scoring, fills empty seats with bots, starts, and
presses **Next round**; the others see "Waiting for host…". Everyone has **90 seconds** to set a hand: a countdown
shows on every screen, and when it runs out the server sets the hand with the AI. A refresh or a dropped connection
reconnects (with backoff) to the same seat, hand and set hand.

### Local development

```sh
npm install          # installs the pinned wrangler (dev dependency only)
npm run dev          # wrangler dev on http://localhost:8787, with local Durable Objects; no Cloudflare login needed
npx wrangler dev --var TURN_SECONDS:15 --var HOST_GRACE_SECONDS:5   # shorter timers for testing
npm test             # node tests, including the room logic (tests/room.test.mjs)
```

Open two or more browser profiles (or one normal and one private window) to play against yourself: the rejoin token
lives in `sessionStorage`, so every tab is its own player.

### Deploy

```sh
npx wrangler login   # once
npm run deploy       # = wrangler deploy
```

That uploads the Worker, the static files and the `Table` Durable Object (SQLite-backed, migration `v1`) and prints a
`https://13poker.<your-subdomain>.workers.dev` URL. Durable Objects with SQLite storage are available on the Workers
Free plan.

**Custom domain (optional):** in the Cloudflare dashboard open *Workers & Pages → 13poker → Settings → Domains &
Routes → Add → Custom domain* and enter a hostname on a zone in your account (e.g. `poker.example.com`), or add to
`wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "poker.example.com", "custom_domain": true }]
```

Settings (`vars` in `wrangler.jsonc`, or `--var` locally): `TURN_SECONDS` (default 90), `HOST_GRACE_SECONDS`
(default 30), `IDLE_SECONDS` (default 3600).

### Protocol

`GET /api/health` → `{ok, transport: "ws", turnSeconds}`. `POST /api/tables` with `{settings?}` → `{code}` (4 letters
from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, checked against existing tables). `GET /ws?table=CODE` upgrades to a WebSocket
on that table's Durable Object (`idFromName(code)`), which uses the WebSocket Hibernation API and keeps the table in
its storage, so a hibernated or evicted object comes back with the same state.

JSON text frames with a `type` (a plain `ping` is answered `pong` without waking the object):

| Client → server | |
|---|---|
| `hello {name, token?}` | take a seat (lobby only) or, with the rejoin token, your old seat back |
| `setSettings {settings}` | host, lobby: scoring mode, fill with bots, … |
| `start` | host, lobby |
| `setHand {front, middle, back, declareNatural}` | your 3 / 5 / 5 cards |
| `nextRound` | host, after the showdown |
| `leave` | lobby: frees the seat; in a game: a bot takes it |
| `kick {seat}` / `seatBot {seat}` | host: remove a player / give a disconnected player's seat to a bot |

| Server → client | |
|---|---|
| `welcome {token, code, rejoined}` | the rejoin token (kept in `sessionStorage`, per table) |
| `state {…}` | phase, round, seats (name, kind, connected, ready), host, settings, `deadline` + server `now`, results, totals, **your** hand and set hand; at the showdown everyone's sets, `declared`, `auto` and the settlement |
| `error {code, message}` | e.g. `bad-hand`, `not-host`, `full`, `started`, `no-table`, `rate-limited` |

Close codes: 4404 no such table, 4400 refused (bad name, full, started), 4403 removed by the host, 4409 seat opened in
another window, 4410 table expired, 4429 flooding.

### Limits

- 2–4 seats; humans join only in the lobby (a seated player can always rejoin with their token).
- Host: the first to join. If the host leaves, or is disconnected for more than 30 s, the role passes to the next
  connected player.
- Messages: text only, at most 4 KB, validated per type; 5 per second per socket with bursts of 15 (extra messages
  are dropped with a `rate-limited` error; a sustained flood closes the socket).
- Nicknames: control and invisible characters stripped, spaces collapsed, 1–16 characters, de-duplicated at the
  table, always displayed as text.
- A table nobody is connected to is deleted by a Durable Object alarm after 1 hour. The last 200 rounds are kept per
  table (totals cover every round).

## Project layout

```
index.html              page shell, dialogs (settings, rules, scoreboard)
css/style.css           felt-table theme, responsive layout
js/main.js              UI controller: state, rendering, showdown animation
js/ui/dnd.js            pointer-based drag-and-drop + tap handling
js/ui/store.js          settings/scoreboard persistence
js/online/online.js     picks the online transport at runtime
js/online/ui.js         shared lobby / status bar DOM for both transports
js/online/db.js         claude.ai transport: db/user runtime, subscriptions
js/online/ws.js         Cloudflare transport: WebSocket client, reconnect, turn clock
js/online/table.js      online table helpers: validation, settings, seat folding, deterministic deals (pure)
worker/index.js         Cloudflare Worker: /api/health, /api/tables, /ws, static assets
worker/table-do.js      `Table` Durable Object: WebSockets (hibernation), storage, alarms
worker/room.js          server table logic: seats, host, deal, setHand checks, timer, scoring (pure, node-tested)
wrangler.jsonc          Worker config; .assetsignore and _headers go with it
js/engine/              pure game logic (no DOM)
  cards.js              cards, deck, seeded RNG, shuffle/deal, sorting
  evaluate.js           5-card and 3-card evaluation, comparison (incl. Front vs Middle), hand names
  validate.js           set-hand validation (counts, duplicates, dealt cards, row order)
  config.js             config + defaults, unitValue <= $10 check, royalty/natural tables
  scoring.js            pairwise scoring (modes, fouls, royalties, naturals), settlement, zero-sum assert
  naturals.js           Dragon / Six pairs / Three flushes / Three straights detection
  ai.js                 hand-setting AI
  combos.js, index.js   helpers / public API
tests/                  node:test suites (*.test.mjs)
docs/RULES.md           rules spec this implementation follows
assets/cards/           card SVGs + license
```

## Tests

```sh
node --test tests/      # or: npm test
```

The tests cover every hand category, including the royal flush, the wheel and 3-card "straights" and "flushes". They
also cover tie-breaks at each key position, exact ties (suits ignored), `wheelRank`, Front-vs-Middle comparison
(including the case where the keys are equal), `allowEqualRows`, fouls vs valid hands and foul vs foul in all three
modes, scoop and 2-4 bonuses, royalties, naturals, the `unitValue > 10` rejection, zero-sum over random 2/3/4-player
deals, RULES.md worked examples 1–5, and the AI (always valid, under 300 ms, beats a naive strategy).
`tests/room.test.mjs` covers the server's room logic: joining, seats and host migration, deal secrecy (a player's
view never holds another hand before the showdown), set-hand validation, the turn timer, scoring identical to
`settle()`, reconnecting by token, message validation and rate limiting.

## Rules source and caveat

The rules are in [`docs/RULES.md`](docs/RULES.md). They are based on the Washington State Gambling Commission sheet
*Thirteen Card Poker (Chinese Poker) Game Rules*
(`https://wsgc.wa.gov/sites/default/files/2023-11/31_chinese-poker.pdf`).

**Caveat:** the WSGC PDF could not be read directly; every fetch was blocked. The **[WSGC]** items were taken from
search-result snippets that quote the sheet. Everything else (the 1-6 / 2-4 scoring modes, foul penalties, royalties,
naturals, showdown order and tie-break details) is a common Chinese Poker **convention**, and RULES.md marks each one.
Someone should check the items against the actual PDF before the game is used for anything beyond casual play.

Defaults follow the WSGC wording: 1 unit per row won or lost, ties pay 0, rows must be **strictly** higher
(Back > Middle > Front), straights and flushes don't count in the Front, suits never break ties, and A-2-3-4-5 is the
lowest straight.

Implementation choices beyond RULES.md:

- When two naturals meet, the higher natural wins **its own** table value. The same type ties at 0. The AI always
  declares a natural, and you choose whether to declare yours.
- A declared natural lets you set your hand even if it would otherwise be fouled.

## Card art: credits and license

The card images are from **Vectorized Playing Cards 1.3** (http://code.google.com/p/vectorized-playing-cards/),
Copyright 2011 Chris Aguilar, licensed under the **LGPL 3**. They were obtained through the `cardsJS` npm package.
See [`assets/cards/LICENSE.md`](assets/cards/LICENSE.md) for the full attribution and the list of modifications. The
license texts are in the same folder. The attribution is also shown in the game's footer.
