# @joystyk/daily

Everything about daily puzzles that every daily game shares: which day it is, when the next
puzzle comes out in the player's own time, puzzle ids, results and streaks, spoiler-free
share text, and a client that downloads each day's puzzle and keeps it for offline play. No
game writes these again. The design is content-pipeline.md (Joystyk host reference)
("Which day is today", "Delivery", "Results and streaks", "Share text") and the daily rows of
offline-and-updates.md (Joystyk host reference).

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/daily
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/daily` | ES module and TypeScript declarations |
| `@joystyk/daily/browser` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@joystyk/daily` | Anywhere (no clock, storage, network or DOM) | Dates and release rules, local-time text, puzzle ids, `streaks`, share text, schemas |
| `@joystyk/daily/browser` | Browser | `today`, `nextReleaseLocal`, `watchDay`, the content client with its cache and prefetch, the results store |

The core imports only `@joystyk/contracts`, `@joystyk/kit` (daily ids and calendar
arithmetic) and Zod. Only the browser entry imports `@joystyk/storage`.
`tsconfig.core.json` type-checks the core without DOM types.

## Use

```ts
import { canStart, gridRows, shareText } from '@joystyk/daily';
import { createDailyClient, createDailyResults, nextReleaseLocal, today } from '@joystyk/daily/browser';

const date = today();                                  // the UTC date of the device clock
const client = createDailyClient({ baseUrl: '/daily', gameId: 'daily-word', config: engine.schemas.config, storage });
const puzzle = await client.puzzle(date);              // Result: decoded config, from network or cache
if (!puzzle.ok) frame.notice(puzzle.error.message);    // "This puzzle needs a connection…"

const results = createDailyResults(storage, profile.id);
const { streaks } = (await results.record(dailyResult, today())).value; // { current, best, winCurrent, winBest }

shareText({ title: 'Daily Word', date, headline: '4/6', rows: gridRows(board, legend, (i) => `Guess ${i + 1}`), url });
shareText(sameInput, 'words');                         // "Copy as text": rows in plain words

const next = nextReleaseLocal();                       // { time: '8:00 PM', countdown: 'in 6 hours', … }
frame.notice(`New puzzle at ${next.time} (${next.countdown})`);

await client.prefetch(date);                           // the PWA, at a safe point, if installed or pinned
await client.prune(date);                              // drop cached days before yesterday
```

## Days

- **One puzzle per UTC day** (host policy). **`utcDate(instant)`** is the puzzle date at an
  instant, the same everywhere at once. In the browser, `today()` reads `Date.now()`. Travel
  and daylight saving never change the date.
- **Release:** puzzle D comes out at 00:00 UTC on D (`releaseInstant`, `isReleased`);
  `nextRelease(instant)` and `untilNextDay(instant)` give the next one. The server's index
  lists dates up to tomorrow (`latestListedDate`), so installed clients can prefetch it.
- **Local time for display only.** `localTimeText(instant, { locale, timeZone })` gives the
  release time as the player reads it ("8:00 PM"), and `countdownText(ms, locale)` a plain
  countdown ("in 6 hours"). Both default to the runtime's locale and zone. In the browser,
  `nextReleaseLocal()` puts them together with the device clock.
- **Starting and finishing:** a player starts only today's puzzle (`canStart`); a prefetched
  puzzle for tomorrow stays locked until its day begins. A puzzle started is kept, and its
  result counts for the puzzle's date even when it is finished after the next release
  (`creditDate`).
- `addDays`, `daysBetween`, `dayNumber`, `startOfDay` and `puzzleNumber` work on
  `yyyy-mm-dd` strings. The first three come from the kit.

## Streaks

`streaks(results, today)` is pure and is the only place streaks are decided. Streaks count
UTC days:

- **Streak:** consecutive puzzle dates finished (won, lost or completed, with or without
  help; any variant). **Win streak:** consecutive dates won; only games that can be lost show it.
- Today not yet played leaves a streak standing. Any missed date before it sets the current
  streak to 0; the best is kept. There are no freezes or grace days.
- A skipped date counts as missed; a repeated date counts once. Results dated after `today`
  (a clock set ahead) count toward the best only.

The results store keeps the results and writes a summary to the storage package's streak
records after every `record` and `streaks` call: the days-finished streak in the player's
`StreakStore`, the win streak at `<player>/<game>/win` in the same shape. A stored best is
never lowered, ready for v2 sync's "max wins".

## Share text

```text
Daily Word 2026-10-08 4/6        ← title, date (or "#412"), variant in brackets, headline
Solved in 1:42, no help          ← summary line, when the game has one
⬜🟨⬜⬜⬜                         ← symbol rows; in the words form, "Guess 1: 1 wrong place."
https://…/games/daily-word       ← the game page, with no query string or fragment
```

The game supplies the headline, summary and rows; `gridRows` builds rows in both forms from a
grid of cell kinds and a legend. `shareText` throws on a symbol row containing any letter or
digit, a line break in a one-line field, or a URL with a query or fragment, since each could
leak an answer or carry tracking. Never put letters, clues or answers in a summary.

## Delivery formats

The site serves `/daily/<game>/index.json` (`no-cache`) and
`/daily/<game>/<date>.<hash>.json` (immutable). Both decode through this package's schemas:

| Schema | Shape |
| --- | --- |
| `dailyIndex` | `{ schemaVersion: 1, gameId, dates: [{ date, hash, size }] }` |
| `dailyFile` / `dailyEnvelope(config)` | `{ schemaVersion: 1, puzzleId, date, contentHash, config }`; `dailyEnvelope` also decodes `config` with the game's `schemas.config` and can require a game, date and hash |
| `dailyResult` | The `DailyResult` record from content-pipeline.md, plus an optional `shareWords` (the rows in words, for *Copy as text*) |

The **content hash** is the first 12 hex digits of SHA-256 over `canonicalJson(config)`
(keys sorted by UTF-16 code unit, no whitespace). The client checks it with Web Crypto before
caching a file. The `content` package must hash the same way.

## The content client

`puzzle(date)` revalidates the index, refuses a date the index doesn't list, uses the cached
file when its hash is still current, and otherwise downloads, checks and caches it. If the
network or server fails it falls back to any cached copy for that date; with none, it returns
`Offline` with a plain message. Every read, from the network or the cache, decodes the file
again, so a new game build with a stricter schema never trusts an old download. Requests send
no cookies, referrer or query string.

`prefetch(today)` downloads today and the next day (`prefetchDates`), where the index lists
them and the device lacks them; never further ahead (host policy). The package doesn't decide who
prefetches: the PWA calls it for installed clients and pinned games, at a safe point.

Downloads live in the storage package's `game-data` store under `~daily/<game>/<date>`;
results under `<player>/~daily/<game>/<date>/<variant or ->`. A `~` can't start a player id or
a game id, so neither meets a game's own keys.

## Tests

- `src/*.test.ts` (Node): the UTC date across midnight, daylight saving, leap days and 1970,
  with a year-long hourly sweep against `Date#toISOString`; release and listing rules at
  every quarter hour of three days; local release times in several zones and locales, and
  the countdown text; streak rules (with a randomized check against a day-by-day count);
  share text for Daily Word and Crossword; and the schemas.
- `src/browser/*.browser.test.ts` (Chromium): the content client against a fake `fetch` over
  real IndexedDB and Web Crypto (cache hits, offline, withdraw and replace, bad hashes and
  configs, prefetch of the next day only, prune), the results store, `today`,
  `nextReleaseLocal` and `watchDay`.
