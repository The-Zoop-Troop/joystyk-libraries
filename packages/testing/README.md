# @joystyk/testing

Dev-time helpers that games and platform packages use from their own test files. The heart
of the package is the pair of **conformance suites** that check the
game contract (Joystyk host reference): a game opts in
with one short test file, and the suite plays hundreds of seeded random games against its
engine or simulation. Around them sit the fakes and builders that make other tests quick to
write: a test RNG, a fake clock, a fake storage port, replay and undo helpers, and fixture
builders.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/testing
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser. The root entry integrates with Vitest
4.1.11; use it inside a Vitest test. Fixtures can also be imported separately.

| Import | Format |
| --- | --- |
| `@joystyk/testing` | ES module and TypeScript declarations |
| `@joystyk/testing/fixtures` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

It depends on `@joystyk/contracts`, `@joystyk/kit` and `@joystyk/session` (whose runner
replay it cross-checks against), and on `vitest` as a peer. Never import it from production
code.

## Conformance for a discrete engine

```ts
// games/nim/engine/conformance.test.ts
import { runEngineConformance } from '@joystyk/testing';
import { engine, migrations, perturbHidden } from './index.ts';

runEngineConformance(engine, {
  name: 'nim',
  configs: [{ heap: 5 }, { heap: 21 }],
  seatCounts: [2],
  // Candidate commands for a seat: all legal moves, or a sample. Illegal ones are fine;
  // the engine's answer decides. Without this the suite asks engine.ai for moves.
  commands: (state, seat) => [1, 2, 3].map((count) => ({ type: 'take', count })),
  perturbHidden,                        // games with hidden information; see below
  invariants: (state) => state.heap >= 0 || 'the heap is negative',
  saves: { version: 2, migrations, fixtures: [/* one stored state per shipped save version */] },
});
```

`runEngineConformance` registers a `describe` block with one `it` per check, so a failure
names the rule it broke. The games are played once, in the first case to run, and every
case reads the shared report. A check that doesn't apply (no AI, no hidden information) is
reported as skipped, with the reason.

Each failure prints what broke, the game's seed, the number of inputs before it, the input
being checked, and the replay of every accepted input so far:

```text
[no-leak] … : failed, 14 failures
#1 viewFor(state, 0) changed when only hidden information changed: $.others[1][0].id: "q6y31" vs "brh76"
  at: setup 0, game 3, seed "conformance/0/3", after 4 inputs
  rerun only this game: add `only: { setup: 0, game: 3 }` to the options
  replay: {"layer":2,"gameId":"test-game",…,"inputs":[…]}
```

Add the `only` option to replay just that game, or pass the printed replay to
`replayEngine(engine, replay)` to reach the failing state in a debugger.

### What it checks

| Check | What fails it |
| --- | --- |
| `determinism` | The same seed and inputs give different states, beats, jobs, barriers, assistance, outcomes or random state; or `apply` answers the same arguments twice in two ways |
| `replay` | The recorded log, after a JSON round trip, doesn't reproduce the final state, outcome and barriers, through this package's replay and through the session runner's |
| `json` | A config, state, view, redacted event, command, job request, decision key or outcome isn't JSON (the message names the path, e.g. `-0 at $.lean`) |
| `schemas` | A value fails the engine's own schema; or a command, state, config or job schema validates asynchronously, which runners can't wait for |
| `no-leak` | `viewFor` or `decisionKey` changes when `perturbHidden` changes only what that viewer can't see, for every seat and the spectator; `eventFor` tells a viewer different things about two transitions that look identical to that viewer; or `perturbHidden` never changes anything |
| `rejections` | `apply` throws, mutates its (frozen) input, or rejects without a JSON `GameError` |
| `turns` | A command from a seat outside `pending()` (including seats that don't exist) is accepted; `pending()` lists unknown or repeated seats, or isn't empty after the outcome; a `timeout` or `seat` input (when `platformInputs` sends them) is refused while the game is in progress |
| `resign` | A `resign` from any seat, in turn or out of turn, is refused while the game is in progress |
| `invariants` | The `invariants` hook returns `false` or a message, or throws, on any state a game reaches |
| `ai` | `ai.choose`, at any level and for any pending seat, throws or picks a command the engine rejects |
| `saves` | A state saved at a random point doesn't survive JSON and `schemas.state` unchanged, or a game restored from it ends differently; a save fixture is missing for a shipped version, or doesn't migrate and validate |
| `jobs` | A job outcome for an id never requested, already answered or superseded is accepted; an awaited job accepts a value but not a failure, or the reverse; a job id repeats; a job kind is undeclared or has no fake runner; a payload or the fake runner's value fails its schema |
| `stale` | While a seat's `decisionKey` stays the same, the set of commands the engine accepts from it changes, so the room would let a stale command through |
| `undo` | Undo by replay doesn't return to the state before the human's previous decision, steps back past an `undoBarrier`, or refuses although no barrier is in the way; or a barrier differs from the spec's `undoBarrier` rule |
| `assist` | A transition's `assist` isn't `'hint'`, `'check'` or `'reveal'`, differs from the spec's `assist` rule, or isn't reproduced by replay |
| `session-hooks` | A transition sets `startsClock` without the engine declaring `clockStart: 'transition'`, or sets it twice in one game; or `worthSaving` throws, mutates its state, answers something other than a boolean, or answers differently for the same state or its JSON copy. Skipped when the engine declares neither hook |
| `outcome` | A game has no outcome after `maxSteps` inputs; nobody can move although the game isn't over; the outcome is malformed (every seat placed once, places from 1, no platform-written fields); a finished game accepts a command or a resignation |

The suite deep-freezes every state and input it hands the engine, and restores the random
state after every trial, as the session runner does. It tries each candidate input on a
copy of the generator before committing one, so trials never change the game.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `setups` or `configs` × `seatCounts` | required | How games start: `{ config, seats }`, seats as a count or `SeatInfo`s |
| `commands` | `engine.ai` | Candidate commands for a seat in a state |
| `perturbHidden` | none (no-leak skipped) | `(state, viewer, rng) => state` changing only what `viewer` can't see |
| `perturbTransition` | none | Optional `(state, viewer, rng, transition) => state` retry helper: preserve current knowledge, what the viewer learns in `transition.states`, and cards required by `transition.input`; vary everything still hidden |
| `invariants` | none | `(state) => void \| boolean \| string` |
| `games`, `maxSteps`, `seed` | 12, 400, `"conformance"` | Games per setup, inputs per game, base seed |
| `requireOutcome` | true | Fail games that don't finish in `maxSteps` |
| `platformInputs` | `{ resign: true }` | Also send `timeout` and `seat` inputs with `{ timeout: true, seatChanges: true }` |
| `jobs`, `jobFailureRate` | none, 0.1 | Fake job runners by kind, `(payload, rng) => value`, and how often a job fails instead |
| `undoBarrier`, `assist` | none | The spec's rules: which inputs are barriers, and which assistance each input is |
| `saves` | round trip only | `{ version, firstVersion?, migrations, fixtures }` |
| `only` | all games | `{ setup, game }`, to rerun one reported game |
| `timeoutMs` | 300 000 | Per vitest case (`runEngineConformance` and `runSimulationConformance`) |

`checkEngine(engine, options)` runs the same suite without vitest and returns a
`ConformanceReport`; `formatReport` turns it into text and `expectConformance` throws unless
it passed. Use it to assert on the report itself, as this package's own tests do.

## Conformance for a fixed-step simulation

```ts
import { runSimulationConformance } from '@joystyk/testing';

runSimulationConformance(simulation, {
  configs: [{ length: 40, limit: 600 }],
  ticks: 1000,
  inputs: (state, tick, rng) => (rng.int(0, 5) === 0 ? [{ type: 'nudge', dir: 1 }] : []),
  requireOutcome: true,
  invariants: (state) => state.pos >= 0,
});
```

| Check | What fails it |
| --- | --- |
| `determinism` | A second run with the same seed and tick inputs gives different results or random state |
| `replay` | The tick log, after a JSON round trip, doesn't reproduce the final state and outcome, here or through the session scheduler's replay |
| `checkpoint` | Saving at a tick, restoring through JSON and `schemas.state`, and running on gives a different end than running straight through |
| `json`, `schemas` | A config, state, input, event or outcome isn't JSON or fails its schema |
| `purity` | `step` throws, mutates its frozen input, or answers the same state, inputs and generator in two ways |
| `invariants` | The hook fails on a state |
| `outcome` | A malformed outcome, or none within `ticks` when `requireOutcome` is set |
| `budget` | The mean step exceeds `stepBudgetMs` (off unless set; budgets belong on a reference machine) |

## Helpers

| Helper | Use |
| --- | --- |
| `testRng(...parts)`, `testSeed(...parts)`, `testSeeds(base, n)`, `cloneRng(rng)` | Seeded kit generators for tests, namespaced so they never equal a production seed |
| `createFakeClock(start)` | `now`, `setTimer`, `setTimeout`, `advance`, `advanceTo`, `runAll`; the shape of the room server's `Clock` port |
| `manualFrames()` | A fixed-step runner's `frames` port that runs only when the test says: `run(n)`, `advance(n)` and `until(condition, what)`, which counts game time in frames (testing under load (Joystyk host reference)) |
| `waitUntil(condition, what)`, `pause(ms)`, `nextTask()`, `WAIT_BUDGET_MS` | Waits on a condition with a budget only a real failure exhausts, instead of a sleep |
| `createFakeStorage(initial)` | The contract's `GameStorage` in memory, storing JSON text, with `entries`, `calls` and `failNext(op)` |
| `runnerClock(fake)`, `createMemorySaveStore()` | The session runner's `Clock` on a fake clock, and a save slot in memory with `slot`, `writes` and `clears`, to play a game through `createLocalSession` |
| `replayEngine`, `replaySimulation` | Replay a log and report each input's barrier, assistance and whether a human sent it |
| `undoByReplay(engine, replay)` | Undo as the local runner does it: back to the start of the human's previous decision, refusing to cross a barrier, with the assistance record (`'undo'` included) |
| `seats`, `commandInput`, `resignInput`, `timeoutInput`, `seatInput`, `jobResult`, `jobFailure` | Fixture builders for seats and inputs |
| `engineReplay`, `simulationReplay`, `saveEnvelope`, `saveFixture` | Replays, saves and save fixtures with test defaults |
| `guardSchema(guard)`, `anySchema()`, `validate(schema, value)` | Standard Schemas from type guards, and running any schema |
| `firstDifference`, `deepEqual`, `deepFreeze`, `jsonRoundTrip` | What the suites use to compare and protect values |

## Fixtures

`@joystyk/testing/fixtures` holds small, correct games, each with conformance options that
pass, for platform tests (runners, rooms, the two-client harness) that need a real engine:

| Fixture | Layer | Exercises |
| --- | --- | --- |
| `nim` | 2 | Public state, runner-driven AI, saves with a migration chain |
| `drawPlay` | 2 | Hidden hands and deck, opaque card ids, redacted events, two to four seats |
| `sealedBids` | 2 | Simultaneous moves, a custom `decisionKey`, hidden choices |
| `diceRace` | 2 | Jobs: requests, awaited ids and failures; solo and two seats |
| `hintPuzzle` | 2 | Solo hidden information, undo barriers, `assist: 'hint'`, and both session hooks (`clockStart`, `worthSaving`) |
| `drift` | 3 | A fixed-step simulation with seeded wind and scripted inputs |

## Tests

- `fixtures.test.ts` runs both suites through the vitest wrappers on every fixture, then
  asserts from the reports that each fixture exercised the checks it was built for.
- `broken.test.ts` runs the suites on deliberately broken fixtures (`broken.test-util.ts`),
  one flaw each, and asserts that the right check fires: leaking ids, spectator views,
  events and decision keys; non-deterministic, mutating and throwing engines; `undefined`
  and `-0` in state; asynchronous and disagreeing schemas; wrong-turn acceptance; refused
  and late resignations; endless and stuck games; illegal AI moves; frozen decision keys;
  lost cards; missing barriers and wrong assistance; a clock started twice or undeclared,
  and an impure or mutating `worthSaving`; job ids accepted, refused or reused;
  missing and broken save fixtures; and the simulation equivalents. It also proves that a
  reported seed and replay reproduce the failure.
- `helpers.test.ts` covers the RNG, clock, storage, builders, deep helpers and undo.
