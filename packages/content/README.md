# @joystyk/content

The AI content pipeline, server only. It asks a model for the language parts of a daily
puzzle, checks every reply, and publishes the files the `daily` package's client downloads.
Nothing here runs in a browser. The design is
content-pipeline.md (Joystyk host reference); its *Implemented* section
lists where the build departs from it. Games plug in a generator from their `content/`
folder; apps/content (Joystyk host reference) runs the pipeline on a schedule.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/content
```

Requires Node 24.15 or later. This package runs on the server.

| Import | Format |
| --- | --- |
| `@joystyk/content` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

## The run

```text
schedule ─▶ generate ─▶ schema ─▶ game validators ─▶ blocklist + sensitive list ─▶ model screen ─▶ validated ─▶ publish
               ▲                                                                                       │
               └──────── up to 3 attempts per item per run; each retry hears what was wrong ───────────┘
                         past the deadline (48 h before release) and still failing: a bank item
```

```ts
import { createModelClient, createPublisher, defaultFilter, openStore, runPipeline } from '@joystyk/content';

const report = await runPipeline({
  store: openStore('/data/content.db'),
  generators: [wordOfTheDayGenerator()],
  model: createModelClient({ baseUrl: process.env.CONTENT_MODEL_ORIGIN, key, model }),
  filter: defaultFilter(),
  publisher: createPublisher('/daily'),   // null for a dry run
  daysAhead: 1,                           // today and tomorrow
});
```

- **Idempotent.** A slot already validated or published is left alone; a run cut short (a
  `signal`) leaves its slot `scheduled`, and the next run resumes it.
- **Deterministic inputs.** A generator's `schedule` picks the slot's inputs (Word of the
  Day's word, the answers' positions) from the date and the answers already used, so a rerun
  asks for the same thing.
- **Answer history.** A generator can set `historyDays` when its avoidance rules require
  more than the default 365 days. Scheduling, validation and fallback selection receive
  that window on either side of the slot, including withdrawn answers. Honeycomb requests
  five years for its full-hive words.
- **Circuit breaker.** Five endpoint errors in a row end generation for the run; banks cover
  the slots past their deadline.
- **Takedowns.** `withdrawItem` marks an item withdrawn with a reason code and actor, drops it
  from the index at once, and leaves the slot for the next run. The withdrawn answer counts as
  used, so the replacement differs. The old file stays for games already started on it.
- **A game's own checks in the report.** `generate` receives `record(name, detail)`; what a
  game records lands in that attempt's report as `checks[name]`, whether the attempt passes
  or fails, and so in the item's provenance. Crossword records each variant's grids,
  rewrites and fact-check verdicts this way.

## Modules

| Module | Contents |
| --- | --- |
| `model.ts` | `createModelClient`: an OpenAI-compatible chat completions client on plain `fetch`, with a Bearer key. `complete({ name, schema, messages })` sends `z.toJSONSchema(schema)` as the `json_schema` response format, finds the JSON in the reply (reasoning blocks, prose and code fences are tolerated), and decodes it through the schema's Standard Schema interface. Timeouts, network errors, 408, 429 and 5xx retry with exponential backoff and `Retry-After`. A base URL works with or without `/v1`. If the endpoint refuses `response_format`, the schema goes into the prompt instead. Errors carry a kind and a safe message: never the key, the address or the reply text. |
| `pipeline.ts` | `runPipeline`, `rebuildIndex`, `withdrawItem`, and the `DailyGenerator` interface a game implements. |
| `packs.ts` | The non-daily item type: `runPackPipeline`, `rebuildPackIndex`, `withdrawPack`, `createPackPublisher` and the `PackGenerator` interface, for content keyed by a curated slot such as a theme (Letter Drop's word packs and Word Flux's catalogs). Same checks as a daily item; files go to `<dir>/<game>/packs/`. |
| `store.ts` | `openStore`: `content.db` on `node:sqlite` (WAL). Items with status, provenance (`source`, model, prompt version, seed, every attempt's report), runs, an event log, and the overlap lock (`tryLock`, `releaseLock`). Schema migrations by `user_version`; a database from a newer build is refused. |
| `publish.ts` | `createPublisher`: `<dir>/<game>/<date>.<hash>.json` and `<dir>/<game>/index.json` in the `daily` package's formats, written atomically. |
| `hash.ts` | `contentHash`: the first 12 hex digits of SHA-256 over the `daily` package's `canonicalJson`, the same digest the browser checks. |
| `filter.ts` | The all-ages word lists: whole-word matching in regular plural and verb forms, `*` stems, phrases, and every straight line of a letter grid. |
| `screen.ts` | The model screen, filter layer 3: `{ safe, reasons }`. It can only add a rejection. |
| `vocabulary.ts` | `scowlVocabulary()`: `isCommon` (SCOWL ≤ 50 plus `common-extra.txt`) and `isKnown` (SCOWL ≤ 70). |
| `ranked.ts` | `rankedWords()`: each word of `scowl-ranked.txt` with its SCOWL size; `scoreOfSize` turns a size into the crossword score (size 10 scores 100, size 60 scores 40). |
| `text.ts` | Tokens, a word's regular forms, stems, and the leak checks (`mentions`, `leaksLetters`). |
| `log.ts` | JSON-lines logger that redacts configured secrets (the key, the endpoint's origin and host) from every line. |

## Word lists

`lists/` holds data with licenses (content-pipeline.md, *Word lists and licensing*):

| File | What | Source |
| --- | --- | --- |
| `scowl-common.txt`, `scowl-vocabulary.txt` | Words at SCOWL sizes 10–50, and 55–70 | SCOWL 2020.12.07, built by `node lists/build-lists.ts` from the pinned, checksummed release. Keep `SCOWL-COPYRIGHT` with them. Protected game names are left out. |
| `scowl-ranked.txt` | Lowercase words of 3 to 12 letters at SCOWL sizes 10–60, each with its smallest size level; no names, abbreviations or contractions | The same release, built by `node lists/build-ranked.ts` (`pnpm --filter @joystyk/content build-ranked`). Grid games build answers from it (`rankedWords`, `scoreOfSize`). |
| `common-extra.txt` | Everyday words SCOWL 2020 lacks ("app", "coder") | Original, hand-reviewed; keep it short |
| `blocklist.txt` | Profanity, slurs, sexual, drug and graphic-violence terms | Curated from LDNOOBW (CC BY 4.0), plus original additions; see its header |
| `sensitive.txt` | Topics wrong for a children's daily puzzle | Original |

Rebuild the SCOWL lists with `pnpm --filter @joystyk/content build-lists`; never edit them by hand.

Two games keep generated copies of `blocklist.txt`: Hangman's engine blocklist and Daily Word's
accepted guesses. After editing the blocklist, rebuild them with
`node games/hangman/src/content/build-blocklist.ts` and
`node games/daily-word/src/content/build-words.ts`; their unit tests fail until you do.

## Tests

`src/*.test.ts` (Node), all against fakes; no test calls a real model. The model client against
a scripted `fetch` (URLs, headers, the schema, fences and reasoning, malformed JSON, schema
violations, truncation, retries and backoff, timeouts, aborts, the format fallback, no
secrets in errors); the pipeline with a toy game and a fake model (success, idempotent
reruns, each failure kind ending in a bank item, the screen, the circuit breaker, deadlines,
the publishing horizon, shutdown and resume, takedowns, dry runs); the store and its lock
across two connections; the hash against Web Crypto; the word lists. The live check against
the real endpoint is `pnpm validate:content-live` (apps/content (Joystyk host reference)).
