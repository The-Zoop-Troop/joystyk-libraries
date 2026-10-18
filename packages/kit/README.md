# @joystyk/kit

Pure, deterministic building blocks for game engines: a seeded random number generator,
playing cards, dice, grids, turn order and daily seeds. The kit depends only on
`@joystyk/contracts`. It reads no clock, global random source, DOM, storage or network,
and uses only the `Math` functions the
game contract (Joystyk host reference) allows, so a seed and a
list of inputs replay to the same state in Node, Chromium, Firefox and Safari. The
architecture lint enforces this (`engine-purity`, `impure-import`).

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/kit
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/kit` | ES module and TypeScript declarations |
| `@joystyk/kit/rng` | ES module and TypeScript declarations |
| `@joystyk/kit/cards` | ES module and TypeScript declarations |
| `@joystyk/kit/dice` | ES module and TypeScript declarations |
| `@joystyk/kit/grid` | ES module and TypeScript declarations |
| `@joystyk/kit/daily` | ES module and TypeScript declarations |
| `@joystyk/kit/turn` | ES module and TypeScript declarations |
| `@joystyk/kit/tiles` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

Import from the root or from a module's subpath:

```ts
import { createRng, standardDeck, assignIds } from '@joystyk/kit';
import { bestArrangement } from '@joystyk/kit/cards';
```

| Module | Subpath | Contents |
| --- | --- | --- |
| `rng.ts` | `@joystyk/kit/rng` | The seeded `Rng`; seeds from strings and parts; `pick`, `weightedPick`, `sample`, `chance`, `forkRng` |
| `hash.ts` | (root only) | `murmur3` and `utf8`, used to turn seed strings into RNG state |
| `cards/` | `@joystyk/kit/cards` | Card model and names, decks, ids and redaction, deals, tricks, melds, point tables, hidden-hand sampling |
| `dice.ts` | `@joystyk/kit/dice` | Rolls from an `Rng`; face counts, sums, doubles, of-a-kind, straights |
| `grid.ts` | `@joystyk/kit/grid` | Row-major JSON grids; bounds, 4- and 8-neighbors, flood fill, region labels, distances |
| `daily.ts` | `@joystyk/kit/daily` | Daily ids and seeds from a date string; day numbers and date arithmetic |
| `turn.ts` | `@joystyk/kit/turn` | Seat order around a table: next seat, seats from a start, next active seat |

## rng: the seeded generator

`createRng(seed)` returns the contract's `Rng`: `next()`, `int(min, max)`, `shuffle(items)`
and `save()`. `restoreRng(state)` continues a saved generator exactly where it stopped.
The runner owns the generator; engines only receive it (game contract, "Randomness").

**Algorithm: SFC32**, Chris Doty-Humphrey's small fast chaotic generator from PractRand.
It was chosen for four reasons:

- It passes PractRand and TestU01's BigCrush.
- Its state is four unsigned 32-bit words, so `RngState` is
  `{ algorithm: 'sfc32', words: [a, b, c, counter] }`: small, plain JSON.
- A step is additions, a xor, shifts and a rotation on 32-bit integers (`| 0`, `>>> 0`).
  Every JavaScript engine computes these exactly, so there is no floating-point step to
  drift between engines.
- The fourth word is a counter, so no seed lands in a short cycle: every stream runs at
  least 2^32 outputs, and about 2^127 on average.

It is not cryptographic, and needn't be: the state stays with the authority (the
browser's session or the room server, and after launch a P2P host) and never appears in a
view.

**Drawing numbers:**

- `next()` combines two steps into a float with 53 random bits, `k / 2^53`.
- `int(min, max)` draws uniformly from [min, max) by rejection sampling. A draw from the
  incomplete top copy of the range is thrown away, so there is no modulo bias. Ranges up
  to 2^32 take one step per draw, and larger ranges up to 2^53 take two. Bad arguments
  throw a `RangeError` without advancing the state.
- `shuffle` is Fisher–Yates into a new array. It walks from the last index down to 1 and
  swaps with `int(0, i + 1)`.

**Seeding.** `seedState(seed)` hashes the seed's UTF-8 bytes with MurmurHash3 (x86,
32-bit), using hash seeds 0 to 3, to fill the four words, then discards 12 outputs, as
PractRand's reference seeding does. MurmurHash3 is public domain and well known, has
published test vectors and needs only `Math.imul`, shifts and xor. Helpers:

- `seedFromParts(['klondike', 'draw-3', 42])` hashes `"klondike:draw-3:42"`. String
  parts may not contain `:`, so two different lists never collide.
- `dealSeed(gameId, variant, dealNumber)` gives numbered deals that players can share.
- `forkRng(rng)` gives a sub-task, such as an AI search, its own stream. The parent
  advances by exactly four draws, however much the child draws.

**Never change the streams.** Saves, replays, deal numbers and daily puzzles depend on
them. `known-answers.test-util.ts` pins SFC32 steps, seeded states, a 52-card shuffle,
floats and die rolls. Each vector was produced by C reference code (PractRand's `sfc32`,
smhasher's `MurmurHash3_x86_32`) compiled with gcc. The Node tests check them, and so
does `rng.browser.test.ts` in Chromium.

## cards

**The card model.** A face is `{ rank, suit }`: ranks 1–13 with the ace as 1, and suits
`'S' | 'H' | 'D' | 'C'`. A joker is `{ rank: 'joker', suit: null }`. A dealt card is
`Card<F> = F & { id }`. Helpers cover:

- color, and the ace-low or ace-high rank value;
- next and previous rank;
- tableau-run predicates: descending in alternating colors, or descending in one suit;
- display sorting in a game-chosen suit order (`sortHand`, `compareCards`).

**Names.** `cardName(card)` gives the spoken name, "Queen of spades", for accessible names
and announcements. `cardShort(card)` gives "Q♠", or "QS" with `{ glyphs: false }`. The
strings come from a per-locale table, so a new language is a new table, not new code.

**Decks.** `standardDeck()` returns faces in a fixed canonical order: deck by deck, suit
by suit (S, H, D, C), ace to king, then jokers. The shuffle alone decides the deal. Options
cover the variants the specs need:

| Deck | Call |
| --- | --- |
| 52 cards | `standardDeck()` |
| 104 cards, two decks | `standardDeck({ decks: 2 })` |
| With jokers | `standardDeck({ jokers: 2 })` |
| Spider, one suit | `standardDeck({ decks: 8, suits: ['S'] })` |
| Old Maid | `standardDeck({ without: [face(QUEEN, 'C')] })` |

A game with its own faces, like Shift 23's 76 cards, lists them once and uses
`repeatDeck`. Every other helper is generic over the face type.

**Ids.** Choose ids by whether a card can be hidden from someone:

- `assignIds(faces, rng)` gives each card a fresh five-character id from the engine's
  `rng` (Crockford base 32, 32^5 values), unique within the deal and distinct from any
  `taken` ids. Each id is drawn uniformly whatever the card, so ids are a function of
  the RNG state and the card count alone. Call it after the shuffle at every deal; this is
  what the card specs require whenever hands are hidden. `newCardId` issues one id for a
  card created mid-game.
- `withStableIds(faces)` gives readable ids, `QH`, `10S` and `QH#2`, for solo games
  without hidden hands (Klondike, FreeCell, Spider, Blackjack), where ids double as
  animation keys. They reveal the card, so never use them where an opponent may not see
  it.

**Views and the no-leak test.** In a view, a card the viewer may not see becomes a
`HiddenCard`, `{ hidden: true }`, with no id, rank, suit or value; `redact` and
`hiddenCards` build these. `perturbHidden(zones, canSee, rng)` is the building block for
the conformance no-leak test. It shuffles the faces of the cards the viewer can't see
among their slots, and shuffles their ids among the same slots independently. Visible
cards and every count stay the same. A `viewFor` that leaks nothing returns the same view
before and after. Because ids move independently, the test also catches a view that
hides faces but keeps ids.

**Deals.** Index 0 of a deck array is the top card. The deal helpers are:

- `draw(deck, n)` and `turnUp(deck)`;
- `dealRoundRobin(deck, seats, perSeat, startSeat)`;
- `dealAll(deck, seats, startSeat)`, which deals everything as evenly as possible.

Hands are indexed by absolute seat.

**Tricks.** `legalPlays(hand, rules)` handles follow-suit and its common exceptions:

- `unbroken`: a suit that can't be led until broken;
- `required`: a card that must lead, such as the 2 of clubs;
- `banned`: cards that may not be played yet, such as first-trick point cards. The ban
  lifts when it would leave no legal play.

The order of these rules reproduces Hearts' and Spades' edge cases, such as a Hearts
leader holding only hearts and the Queen of Spades. `trickWinner(plays, trump)` returns
the winning seat, and `Trick` is the record type `{ leader, plays: [{ seat, card }],
winner }`.

**Melds.** These are exact, for Gin Rummy and other rummy games:

- `isSet` and `isRun`: runs are ace low, with no wrap from king to ace.
- `takeGroups(cards, size)`: Old Maid pairs and Go Fish books.
- `bestArrangement(hand)`: the melds that leave the least deadwood, by a memoized search
  over the cards left. Ties go to the first arrangement in canonical order.
  `bestArrangements` lists every tied arrangement, so the knocker's layoff tie-break can
  choose among them.
- `bestLayoffs(hand, knockerMelds)`: the defender's own melds plus chained layoffs that
  leave the least deadwood.

Point tables are data: `DEADWOOD_VALUES`, `CRAZY_EIGHTS_PENALTIES` and `heartsPoints`.

**Hidden-hand sampling.** An AI that looks ahead imagines the hands it can't see
(determinization; Shared needs item 8 in
hearts.md (Joystyk host reference)). `sampleHands(spec, rng)`
deals the unseen `cards` among the seats so that every seat holds its `counts[seat]`, no
seat gets a suit listed in its `voids`, each `known` card lands in its seat, and an optional
`allowed(card, seat)` rule holds. It returns null, drawing nothing, when no deal fits;
`canSampleHands(spec)` asks the same question. The most constrained cards are placed first,
and a card never goes to a seat that would leave the rest impossible: Hall's condition over
the subsets of seats decides that exactly, because a card's possible seats depend only on
the card. Without constraints every deal is equally likely. `inferVoids(tricks, seats)`
reads the voids from the tricks played: a seat that played another suit lacks the suit led.

## dice, grid, daily, turn

- **dice.** `rollDie(rng, sides)` and `rollDice(rng, count, sides)` draw only from the
  `Rng` they are given. `faceCounts`, `sumDice`, `allSame`, `mostOfAKind` and
  `hasStraight` score dice games.
- **grid.** A `Grid<T>` is `{ width, height, cells }`, with cells in row-major order and
  (0, 0) at the top left. Helpers include:
  - `neighbors4` and `neighbors8`, clockwise from north;
  - `floodFill` (breadth first);
  - `regions`, which labels connected components (Containment fills the regions no ball
    reaches);
  - `manhattan` and `chebyshev` distances.
- **daily.** There are no clocks here: the date string is an input. `dailyId('sudoku',
  '2026-10-08')` is `"sudoku:2026-10-08"`, and `dailySeed` and `dailyRng` seed from it.
  `dayNumber`, `dateOfDay` and `addDays` handle date arithmetic in integers (Howard
  Hinnant's civil-date algorithms), for puzzle numbers and streaks.
- **turn.** `seatAfter`, `seatsFrom` and `nextActiveSeat` work with absolute seats; a game
  that draws the viewer at the bottom rotates in its own view code.

## Tests

The tests sit next to the code. Property tests use a small harness in
`properties.test-util.ts`. It draws cases from the kit's own generator with fixed seeds, so
every run checks the same cases and never flakes. The properties are:

- **Determinism:** the same seed gives the same stream, and a restored state continues
  the stream.
- **Bounds and uniformity:** rejection sampling stays in bounds and has no modulo bias.
  Chi-square tests at p = 0.001 check `int`, `pick` and dice, and `shuffle` over all 24
  orders of four items and the top card of a 52-card deck.
- **Id opacity:** ids depend only on the RNG state and the card count, and a given card's
  id is uniform across deals.
- **Melds:** `bestArrangement` and `bestLayoffs` agree with brute-force oracles on
  hundreds of random hands.
- **No leaks:** a sample no-leak test passes a sound view and catches one that leaks ids.
- **Sampling:** every sampled deal honors counts, voids and known cards, including cases
  where a careless sampler strands a seat; impossible specs return null; an unconstrained
  deal is uniform (chi-square), and a small constrained case reaches every consistent deal.
