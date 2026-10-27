# Thirteen Card Poker (Chinese Poker): Rules and Developer Spec

This document has three parts:

1. **Part A: WSGC rules.** What the Washington State Gambling Commission (WSGC) rules sheet says.
2. **Part B: Conventions.** Common Chinese Poker conventions that fill gaps in the sheet. **None of Part B comes from the WSGC sheet.**
3. **Part C: Developer spec.** Hand ranking, tie-breaks, validation, scoring algorithm and worked examples.

Every rule is tagged with where it came from:

| Tag | Meaning |
|---|---|
| **[WSGC]** | Stated in the WSGC sheet, as reported by search snippets (see sourcing note below). |
| **[WSGC, interpreted]** | Based on the WSGC text, but the exact behaviour is our reading of it. |
| **[CONVENTION]** | Common Chinese Poker practice. Not from the WSGC sheet. |
| **[OPTIONAL VARIANT]** | A convention that should be off by default and turned on in config. |

---

## Sourcing note: read this first

- **Official source:** WSGC, *Thirteen Card Poker (Chinese Poker) Game Rules*,
  `https://wsgc.wa.gov/sites/default/files/2023-11/31_chinese-poker.pdf`
  (an older copy is at `https://www.wsgc.wa.gov/sites/default/files/public/activities/GameRules/game-rules/31_chinese-poker.pdf`). The WSGC
  "Approved commercial card game rules" page lists Chinese Poker as a non-patented game.
- **We could not read the PDF itself.** In this sandbox, every direct fetch failed. That includes `wsgc.wa.gov` and `www.wsgc.wa.gov`
  (proxy 403 / DNS ENOTFOUND), the Scribd copy, the infobooks.org copy and the Wayback Machine.
- **What we did read:** web-search result snippets that quote or paraphrase the WSGC PDF and its Scribd mirror. Every **[WSGC]** item below
  comes from those snippets. According to the search engine, the excerpts it could see stopped before the end of the scoring section.
  The sheet is reported to be about 3 pages long, so it may contain rules that are not listed here.
- **Action item:** before release, someone with normal internet access should read the PDF and confirm or correct every **[WSGC]** item.

---

## Part A: What the WSGC sheet says [WSGC]

| # | Rule | Tag |
|---|---|---|
| A1 | The game uses **one standard 52-card deck with no jokers**. There are **no wild cards**. | [WSGC] |
| A2 | **Up to 4 players** can play at one table. | [WSGC] |
| A3 | The dealer shuffles the cards, either by hand or with an approved shuffling machine. | [WSGC] |
| A4 | The dealer deals **13 cards to each player**. | [WSGC] |
| A5 | Each player arranges their 13 cards into three hands: a **Back hand of 5 cards**, a **Middle hand of 5 cards** and a **Front hand of 3 cards**. | [WSGC] |
| A6 | The **Back hand must be higher in rank than the Middle hand**, and the **Middle hand must be higher in rank than the Front hand**. | [WSGC] |
| A7 | **Standard poker hand rankings** apply. | [WSGC] |
| A8 | **Straights and flushes do not count in the 3-card Front hand.** | [WSGC] |
| A9 | Players bet in **units**, and each unit has a set dollar value. The sheet's example is 1 unit = $1. The **maximum is $10 per unit**. | [WSGC] |
| A10 | A player **wins 1 unit for each hand won** and **loses 1 unit for each hand lost**. **Ties: no units change hands.** | [WSGC] |
| A11 | Each card room operator documents in its internal controls how it handles irregularities, such as misdeals, exposed cards and a wrong number of cards. | [WSGC] (snippet) |
| A12 | Operators may change rules if the changes are documented in their internal controls. | [WSGC] (from the Scribd snippet; not verified on the WSGC site) |

The snippets do **not** show that the sheet covers any of the following. Treat each one as unknown until someone reads the full PDF:

- a scoop bonus or a 1-6 / 2-4 scoring system
- how a misset (fouled) hand is handled
- royalties
- naturals or special hands
- the order in which hands are shown
- whether the game is house-banked or uses a player-dealer
- collection fees

### Interpretation notes [WSGC, interpreted]

- **A6 means strictly higher.** The sheet says "higher". Two hands that tie exactly (same ranks, different suits) therefore make the
  hand **invalid** under the strict reading. Many casual rule sets only require "not lower". The spec makes this a config flag
  (`allowEqualRows`), and the default follows the WSGC wording (`false`).
- **A10 is scored pairwise.** We read A10 as: each player compares each of their three hands against the matching hand of **every other
  player**, one opponent at a time. This is the usual non-banked format.
- **A8 means a 3-card hand is ranked only as Trips, Pair or High Card.**

---

## Part B: Conventions that fill the gaps [CONVENTION, not from the WSGC sheet]

### B1. Scoring systems [CONVENTION]

All three systems below build on the WSGC per-hand result. Pick one with `scoring.mode`.

| Mode | Rule | Split win (2-1) | Scoop (3-0) | Source |
|---|---|---|---|---|
| `wsgc` | 1 unit per hand won, minus 1 per hand lost. No bonus. | +1 | +3 | [WSGC] |
| `1-6` (default, "scoop ×2") | Same as `wsgc`, but winning all three hands against that opponent **doubles** the row points: 3 × 2 = 6 (a 3-unit scoop bonus). | +1 | +6 | [HOUSE RULE] |
| `2-4` | Same as `wsgc`, plus a **1-unit "overall" bonus** to whoever won more hands against that opponent. | +2 | +4 | [CONVENTION] |

Notes on the conventions:

- **Default is scoop ×2 (`1-6`).** House rule chosen for this game: winning Front, Middle and Back against one player
  doubles those row points from 3 to 6. Royalties are not doubled. A fouled hand counts as scooped.
- **Scoop everyone ×4 [HOUSE RULE].** In `1-6` mode with 3 or more players, a player who scoops **every** opponent
  is paid **3 × 4 = 12** row points by each of them instead of 6 (a fouled opponent counts as scooped; a natural
  does not). Royalties are added on top and are not multiplied. With 2 players a scoop is just ×2. Config:
  `scoopAll: true` (default).
  Example, 4 players: P1 scoops P2, P3 and P4, so P1 gets +12 from each = **+36**. If P1 scoops P2 and P3 but only
  wins 2-1 against P4, P1 gets +6, +6, +1 = **+13**.
- **A scoop means winning all 3 hands.** If one hand is tied, it is **not** a scoop.
- **2-4 with a tied hand.** The overall bonus goes to the player who won more hands. If one hand ties and the other two are split 1-1,
  nobody gets the bonus. A 2-0 result with one tie earns the bonus: 2 + 1 = +3.

### B2. Misset or fouled hand [CONVENTION]

The WSGC sheet only says the hand must follow A6. It does not give a penalty (A11 sends irregularities to each operator's internal controls).
The standard convention is:

- A hand is **fouled** if it breaks A5 (wrong card counts), A6 (wrong order) or A1 (duplicate or unknown cards).
- Against every opponent whose hand is **not** fouled, a fouled hand **loses all three hands**. It is scored exactly like a scoop, so it
  pays the scoop bonus in `1-6` and `2-4` modes.
- When **both** hands are fouled, the result between them is **0**.
- A fouled hand **earns no royalties** and loses any natural it declared.
- **Implementation recommendation:** the software should **prevent** a foul by refusing to submit an invalid hand. Keep the foul
  scoring path anyway, for timeouts, auto-set hands and imported or legacy hands.

### B3. Showdown order [CONVENTION]

Hands are compared and shown in this order: **Front, then Middle, then Back**. The order affects only how results are presented. It never changes a score.

### B4. Royalties [OPTIONAL VARIANT, CONVENTION]

Royalties are bonus units paid for strong hands, and they are **off by default**. The amounts vary a lot from one rule set to another, so these are
example values:

| Position | Hand | Royalty (units) |
|---|---|---|
| Front | Trips | 3 |
| Middle | Full house | 2 |
| Middle | Four of a kind | 8 |
| Middle | Straight flush (including royal flush) | 10 |
| Back | Four of a kind | 4 |
| Back | Straight flush (including royal flush) | 5 |

Settlement rules:

- **Pairwise settlement:** against each opponent, add `royalties(A) - royalties(B)` to A's points. Each player's royalties are paid
  whether or not they won that hand. This is the open-face style. An alternative flag, `royaltyRequiresRowWin`, pays a royalty only when
  that hand wins.
- **A fouled hand gets 0 royalties.** The opponent still collects their own royalties.

### B5. Naturals and special hands [OPTIONAL VARIANT, CONVENTION]

Naturals are **off by default**. A player who is dealt one of these may declare it before the showdown. It then wins a fixed amount from each
opponent, and their hands are not compared. Example table:

| Natural | Description | Units from each opponent |
|---|---|---|
| Dragon | One card of each rank, 2 through A | 13 (some games 26) |
| Six pairs | Six pairs plus one odd card (four of a kind counts as two pairs) | 3 |
| Three flushes | The front, middle and back hands are all flushes | 3 |
| Three straights | The front, middle and back hands are all straights | 3 |

Settlement rules:

- For three flushes or three straights, the front hand's 3 cards **must** form a flush or straight to qualify. This exception to
  A8 applies only to the natural check.
- When two players both declare naturals, the higher one in the table wins. Two naturals of the same type tie and score 0.
- A natural is paid **instead of** the normal hand comparison and royalties against that opponent.

### B6. Other defaults [CONVENTION]

- **Suits never break ties.** Suits matter only for spotting flushes and straight flushes. This matches the WSGC "standard poker
  rankings" wording and is the usual card-room rule.
- **Aces:** an Ace is high, and it can also be low in a straight, as A-2-3-4-5 (the "wheel"). Straights cannot wrap around, so Q-K-A-2-3 is
  not a straight. Some Asian rule sets rank A-2-3-4-5 as the second-highest straight. The flag `wheelRank: "lowest" | "second"`
  covers that, and the default is `"lowest"`.
- **Table size:** 2 to 4 players. With 4 players all 52 cards are dealt. With fewer players the extra cards are not used.

---

## Part C: Developer spec

### C1. Cards

- Ranks: `2 3 4 5 6 7 8 9 T J Q K A`, with numeric values 2 to 14 (Ace = 14).
- Suits: `s h d c`, all equal in value.
- Notation: rank character followed by suit character, for example `As`, `Td`, `7c`.
- Deck: 52 distinct cards, no jokers. **[WSGC]**

### C2. 5-card hand categories (Back and Middle), highest first

| Cat | Name | Tie-break key, compared left to right |
|---|---|---|
| 8 | Straight flush (royal = A-high) | top card of the straight |
| 7 | Four of a kind | rank of the four, then the kicker |
| 6 | Full house | rank of the three, then rank of the pair |
| 5 | Flush | all 5 ranks, high to low |
| 4 | Straight | top card of the straight |
| 3 | Three of a kind | rank of the three, then the 2 kickers high to low |
| 2 | Two pair | higher pair, then lower pair, then the kicker |
| 1 | One pair | rank of the pair, then the 3 kickers high to low |
| 0 | High card | all 5 ranks, high to low |

- **Straights:** five consecutive ranks. **A-2-3-4-5 is a straight whose top card is 5**, so it is the lowest straight.
  T-J-Q-K-A is the highest straight. There is no wrap-around. **[CONVENTION]** (standard poker)
- With one deck, two players can never hold equal four of a kind or three of a kind. A player's own Back and Middle cannot hold equal ones
  either. The kicker comparison is still implemented for completeness.

### C3. 3-card hand categories (Front)

| Cat | Name | Tie-break key |
|---|---|---|
| 3 | Three of a kind | rank of the three |
| 1 | One pair | rank of the pair, then the kicker |
| 0 | High card | all 3 ranks, high to low |

- **Straights and flushes do not count [WSGC A8].** For example, `7h 8h 9h` is **9-high**, category 0.
- The 3-card hand uses the **same category numbers** as 5-card hands. This lets the code compare a Front hand with a Middle hand when
  checking a set hand. Trips = 3, Pair = 1, High card = 0.

### C4. Comparison

```
evaluate(cards) -> { cat: int, key: int[] }      // key is the tie-break list from C2/C3

compare(h1, h2):                                  // returns -1, 0 or +1
    if h1.cat != h2.cat: return sign(h1.cat - h2.cat)
    for i in 0 .. min(len(h1.key), len(h2.key)) - 1:
        if h1.key[i] != h2.key[i]: return sign(h1.key[i] - h2.key[i])
    // the keys are equal as far as both go
    if len(h1.key) == len(h2.key): return 0       // exact tie: suits are ignored
    return sign(len(h1.key) - len(h2.key))        // only for Front vs Middle; see below
```

- **Between players**, both hands are always the same size. A result of 0 is a **tie (push)** worth 0 units **[WSGC A10]**.
- **Front vs Middle (checking a set hand)** compares a 3-card hand with a 5-card hand:
  - **Example:** Front `Kx Kx 9x` against Middle `Kx Kx Qx 7x 2x`. Both are a pair of kings, and then Q beats 9, so the Middle is higher.
    The hand is valid.
  - **Example:** Front `Kx Kx Qx` against Middle `Kx Kx Jx 9x 8x`. Q beats J, so the Front is higher. The hand is **fouled**.
  - **Equal as far as the keys go:** for example, Front `Kx Qx Jx` against Middle `Kx Qx Jx 5x 3x`. The longer hand counts as higher
    because it has more kickers, so the Middle is higher and the hand is valid. **[CONVENTION]**

### C5. Checking a set hand

A submitted hand `{front: Card[3], middle: Card[5], back: Card[5]}` is **valid** only if all of the following are true:

1. `len(front)==3`, `len(middle)==5`, `len(back)==5`. **[WSGC A5]**
2. All 13 cards are distinct, and they are exactly the 13 cards dealt to that player. **[WSGC A1/A4]**
3. `compare(back, middle) > 0`, or `>= 0` if `allowEqualRows`. **[WSGC A6]**
4. `compare(middle, front) > 0`, or `>= 0` if `allowEqualRows`. **[WSGC A6]**, using the C4 rules for comparing a 3-card hand with a 5-card hand.

If any check fails, the hand is **fouled** and is scored under B2. The UI should block submission and say which rule failed.

### C6. Scoring between two players

```
config:
  mode: "wsgc" | "1-6" | "2-4"          // default "1-6" (scoop x2)
  unitValue: number                       // dollars; must be <= 10   [WSGC A9]
  allowEqualRows: false                   // [WSGC A6, interpreted]
  royalties: off | table                  // [OPTIONAL VARIANT]
  royaltyRequiresRowWin: false
  naturals: off | table                   // [OPTIONAL VARIANT]
  wheelRank: "lowest"

score(A, B) -> int                        // points A gains from B; B gains -score(A, B)
    // 1. naturals (if enabled)
    if naturals enabled and (A.natural or B.natural):
        return naturalValue(A) - naturalValue(B) using the B5 rules

    // 2. fouls
    fA = isFouled(A); fB = isFouled(B)
    if fA and fB: return 0
    if fA or fB:
        s = 3 + scoopBonus(mode)           // scoopBonus: wsgc 0, 1-6 3, 2-4 1
        s += royaltiesFor(non-fouled side)  // if royalties are enabled; never royaltyRequiresRowWin here
        return fB ? +s : -s

    // 3. compare each hand
    r = [compare(A.front,B.front), compare(A.middle,B.middle), compare(A.back,B.back)]
    won  = count(r == +1); lost = count(r == -1)
    s = won - lost                                       // [WSGC A10]

    // 4. bonus
    if mode == "1-6":
        if won == 3: s += 3
        if lost == 3: s -= 3
    if mode == "2-4":
        if won > lost: s += 1
        if lost > won: s -= 1

    // 5. royalties (optional)
    if royalties enabled:
        s += royaltySum(A, B) - royaltySum(B, A)          // honours royaltyRequiresRowWin
    return s

settle(players):
    for each unordered pair (A, B): net[A] += score(A,B); net[B] -= score(A,B)
    dollars[p] = net[p] * unitValue
```

- **Zero-sum check:** `sum(net) == 0` at all times. Assert it in tests.
- With up to 4 players there are at most 6 pairwise matchups per deal.

### C7. Worked examples

All examples use `unitValue = $1`. "1-6 + R" means 1-6 mode with the B4 example royalties turned on.

#### Example 1: Split 2-1, and a royalty changes the outcome

| | Front | Middle | Back |
|---|---|---|---|
| **A** | `Qd Qc 3h`: pair of Q | `Ah Kh 8h 6h 2h`: A-high flush | `9s 9h 9d 4c 4s`: 9s full of 4s |
| **B** | `Ad Kc 7d`: A-high | `Ks Kd 5s 5d 2c`: two pair, K and 5 | `7c 8c 9c Tc Jc`: J-high straight flush |

- **Both hands are valid.** For A: full house > flush > pair. For B: straight flush > two pair > high card.
- **Front:** A wins, because a pair beats high card.
- **Middle:** A wins, because a flush beats two pair.
- **Back:** B wins, because a straight flush beats a full house.
- **A wins 2 hands and loses 1:**

| Mode | A's points from B |
|---|---|
| `wsgc` | +1 |
| `1-6` | +1 (not a scoop) |
| `2-4` | +1 + 1 = **+2** |
| 1-6 + R | B has a straight flush in the Back worth 5, so +1 - 5 = **-4** |

#### Example 2: A tied hand, and no scoop

| | Front | Middle | Back |
|---|---|---|---|
| **C** | `Js Jd 4c`: pair of J, 4 kicker | `Ts Td Th 6s 6d`: Ts full of 6s | `2s 2d 2c 2h 5c`: four 2s |
| **D** | `Jh Jc 4d`: pair of J, 4 kicker | `8s 8d 7c 7h 3d`: two pair, 8 and 7 | `Ah Ad Kc Ks 9h`: two pair, A and K |

- **Both hands are valid.** For D: AA-KK > 88-77 > JJ.
- **Front:** **tie.** The ranks are the same, and suits are ignored.
- **Middle:** C wins, because a full house beats two pair.
- **Back:** C wins, because four of a kind beats two pair.
- **C wins 2 hands, ties 1 and loses 0.** This is not a scoop:

| Mode | C's points from D |
|---|---|
| `wsgc` | +2 |
| `1-6` | +2 (one hand tied, so no scoop) |
| `2-4` | 2 + 1 = **+3** |
| 1-6 + R | C earns 4 (four of a kind in the Back) + 2 (full house in the Middle), so +2 + 6 = **+8** |

#### Example 3: A fouled hand

E's Back is a weaker hand than E's Middle, so E's hand is fouled:

| | Front | Middle | Back |
|---|---|---|---|
| **E** | `Qh Qs 4d` | `8s 8d 8c 4h 3d`: three 8s | `Ah Ad Kc Ks 9h`: two pair |

Two pair < three of a kind, so the Back is **not** higher than the Middle and the hand fails A6.

Against any opponent F whose hand is valid, F's points from E are:

| Mode | F's points from E |
|---|---|
| `wsgc` | **+3** |
| `1-6` | **+6** |
| `2-4` | **+4** |
| With royalties on | Add F's royalties. E's royalties are 0. |

If F's hand is also fouled, the result is **0**.

#### Example 4: Tie-break edge cases

| Hand 1 | Hand 2 | Result | Reason |
|---|---|---|---|
| `As 2d 3c 4h 5s` (wheel, top card 5) | `2c 3d 4s 5h 6c` (6-high) | Hand 2 wins | The wheel is the lowest straight. |
| `Ts Js Qs Ks As` | `9h Th Jh Qh Kh` | Hand 1 wins | A-high beats K-high in a straight flush. |
| `Ah Kh 9h 5h 3h` | `As Ks 9s 5s 2s` | Hand 1 wins | The flushes are equal until the 5th card, where 3 beats 2. |
| `Ah Kh 9h 5h 3h` | `Ad Kd 9d 5d 3d` | **Tie** | Suits do not break ties. |
| `Qs Qh 8d 8c Ac` | `Qd Qc 8s 8h Kd` | Hand 1 wins | Same two pair, and kicker A beats K. |
| Front `2h 3h 4h` | Front `As Kd 5c` | Hand 2 wins | The front 2-3-4 counts as 4-high only. A-high beats 4-high. |
| Front `Kd Kc Qs` vs Middle `Kh Ks Jd 9c 8h` | (same player) | **Foul** | The Front is higher: K pair, then Q beats J. |

#### Example 5: Settling three players (`1-6` mode)

Pairwise results (the hands are not shown):

| Matchup | Hands won (first player first) | Points for the first player |
|---|---|---|
| P1 vs P2 | 2 won, 1 lost | +1 |
| P1 vs P3 | 0 won, 3 lost (P3 scoops) | -6 |
| P2 vs P3 | 1 won, 1 lost, 1 tie | 0 |

Each player's net total:

| Player | Net units | At $5 per unit |
|---|---|---|
| P1 | +1 - 6 = **-5** | -$25 |
| P2 | -1 + 0 = **-1** | -$5 |
| P3 | +6 + 0 = **+6** | +$30 |

The nets add up to 0, so the zero-sum check passes.

### C8. Recommended tests

- Every category in C2 and C3, including the wheel, the royal flush, the 3-card "straight" and the 3-card "flush".
- Tie-breaks at every key position, plus exact ties.
- Comparing a 3-card Front with a 5-card Middle, including the case where the keys are equal (the Middle must win).
- `allowEqualRows` set to true and to false, using a Back and Middle that tie exactly (for example `AsKd9c7h3s` and `AhKc9d7s3c`).
- A foul against a valid hand, and a foul against a foul, in all 3 modes.
- The zero-sum check over random deals with 2, 3 and 4 players.
- `unitValue > 10` is rejected **[WSGC A9]**.
