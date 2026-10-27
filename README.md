# 13 Poker: Chinese Poker in the browser

A playable 13-card Chinese Poker game. You play against 1 to 3 AI opponents. Each player splits 13 cards into a
**Back** (5 cards), **Middle** (5) and **Front** (3) hand, and each hand is compared with the same hand of every
other player.

It is a plain static site: `index.html` + `css/` + `js/` (ES modules). There is no build step and no runtime
dependency, so it runs on any static server, including GitHub Pages.

## Run it

```sh
python3 -m http.server 8000     # or any static server
# open http://localhost:8000/
```

ES modules don't load from `file://`, so serve it rather than double-clicking `index.html`. On GitHub Pages, publish
the repository root.

Add `?seed=123` to the URL for repeatable deals, which helps with debugging and automated tests.

## Features

- 1 human vs 1–3 AI opponents (default 3, so all 52 cards are dealt).
- Arrange cards by **tap/click** (select cards, then tap a row; with one card selected, tap a card elsewhere to swap)
  or by **drag-and-drop**. Dragging uses Pointer Events, so it works with touch, mouse and pen. Tools: sort by rank or
  by suit, **Auto** (suggested arrangement) and **Clear**.
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

## Project layout

```
index.html              page shell, dialogs (settings, rules, scoreboard)
css/style.css           felt-table theme, responsive layout
js/main.js              UI controller: state, rendering, showdown animation
js/ui/dnd.js            pointer-based drag-and-drop + tap handling
js/ui/store.js          settings/scoreboard persistence
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
