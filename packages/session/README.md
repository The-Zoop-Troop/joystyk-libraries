# @joystyk/session

The platform's session runners. They turn a game's pure rules into a Layer 1
`GameSession` the launcher can mount:

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/session
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/session` | ES module and TypeScript declarations |
| `@joystyk/session/browser` | ES module and TypeScript declarations |
| `@joystyk/session/browser/rooms` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

- `createLocalSession` plays a Layer 2 `DiscreteEngine` in the browser: solo, vs AI,
  pass-and-play and daily modes.
- `createFixedStepRunner` runs a Layer 3 `FixedStepSimulation` against real time.
- `createRemoteSession` plays in a server room: the room server is the authority, and the
  client speaks `@joystyk/rooms/protocol` over a WebSocket.

The interfaces they implement are in
game-contract.md (Joystyk host reference). A P2P client comes after launch
(host policy).

## Headless core, browser adapters

The core imports only `@joystyk/contracts` and `@joystyk/kit` (for its seeded generator)
and touches no globals. Everything outside pure computation arrives through a port:

| Port | What it does | Browser adapter (`@joystyk/session/browser`) |
| --- | --- | --- |
| `Clock` | `now()` and `after(ms, fn)` | `browserClock()`: `performance.now`, `setTimeout` |
| `Visibility` | Is the page hidden, and changes | `documentVisibility()`: Page Visibility API plus `pagehide` |
| `FrameScheduler` | One callback per display frame | `animationFrames()`: `requestAnimationFrame` |
| `SaveStore` | Writes the save envelope | `webStorageSaveStore(key)`, until the `storage` package's IndexedDB store exists |
| `JobRunner` | Runs an engine job | `workerJobRunner(kind => new Worker(...))` |
| `AiRunner` | Chooses AI moves | Default: the engine's `ai.choose`, inline, after a delay; `workerAiRunner(() => new Worker(...))` for heavy AI |
| `RngFactory` | `(state) => Rng` | Default: `restoreRng` from `@joystyk/kit` |
| `Reporter` | Logs bugs the runner survived | `consoleReporter` |
| `SocketFactory` | Opens the room connection | `browserSocket(roomsSocketUrl(location.origin))` (`@joystyk/session/browser/rooms`) |
| `TokenStore` | Seat tokens by room code | `webStorageTokens()`: local storage, shared by every tab |

`browserPorts()` bundles the clock, visibility, frames and reporter. The core's
`tsconfig.json` has no DOM library, so a global creeping into the core fails the type
check; the adapters have their own `tsconfig.browser.json`.

The factory defaults to the kit's `restoreRng`. The runners use only the contracts' `Rng`
interface for the game's stream, so the tests pass a small Mulberry32 instead. The AI's
stream is always the kit's SFC32, forked with `forkRng`.

## The local runner

```ts
import { createLocalSession } from '@joystyk/session';
import { browserPorts, webStorageSaveStore, workerAiRunner, workerJobRunner } from '@joystyk/session/browser';

const result = createLocalSession(engine, {
  ...browserPorts(),
  manifest,                      // id, versions, undo, handoff, ai
  mode: 'ai',                    // 'solo' | 'ai' | 'pass-and-play' | 'daily'
  seats,                         // SeatInfo[], numbered from 0
  config,                        // decoded with engine.schemas.config
  seed, aiSeed,                  // RngState for the game and, separately, for the AI
  storage: webStorageSaveStore(`save:${manifest.id}`),
  jobs: workerJobRunner(createWorker),
  ai: manifest.ai?.heavy ? workerAiRunner(createAiWorker) : undefined,
});
if (!result.ok) showProblem(result.error);
```

Both `createLocalSession` and `restoreLocalSession` return a `Result`: invalid seats or
config, an `init` that refuses them, or an unusable save fail with a `GameError` instead of
throwing.

**Inputs** (`LocalInput`): `command` (from the viewer's seat, or from the `seat` it names:
in pass-and-play without a hand-off screen any pending human seat, so two people can make
simultaneous moves in either order; elsewhere only the viewer's own seat, never an AI's),
`resign` and `seat` (platform inputs, accepted off-turn, which may name another human
seat), `undo`, `reveal`
(ends the hand-off screen), `pause` and `resume`. Every input is checked at the boundary,
and commands go through `engine.schemas.command` before the engine sees them. A rejection
publishes a snapshot with `meta.notice` and the same revision.

**Snapshots** (`LocalSnapshot`) extend the contract's `EngineSnapshot` with `mode`,
`handoff`, `undo` (available, remaining, and what blocks it), `thinking` (AI seats choosing
now), `paused` and `elapsedMs`; `meta` adds `undosUsed` and `assists`. They follow the six
session rules:

1. `get()` returns the latest snapshot.
2. `subscribe()` delivers the current snapshot at once; unsubscribing twice is safe.
3. `dispatch()` queues the input. All changes (inputs, AI moves, job results) run one at a
   time on one queue, so a listener that dispatches never sees a torn state.
4. Each snapshot is one object, published whole.
5. Snapshots are deep-frozen unless `freeze: false` (pass `import.meta.env.DEV`).
6. `dispose()` is idempotent; it cancels AI, jobs and timers, unsubscribes from visibility
   and writes a last save. Nothing publishes afterwards.

A listener that throws is reported and skipped; the others still receive the snapshot.

### Design choices

- **Engine errors.** A throwing `apply` becomes an `EngineThrew` notice and the previous
  state. After any rejection the runner restores the `Rng`, so a rejection never consumes
  randomness a replay would not.
- **AI seats** are driven when `pending()` lists a seat whose controller is `ai`. The AI
  receives a JSON copy of `viewFor(state, seat)` and nothing else. A choice in flight is
  cancelled when that seat's `decisionKey` (default: its view) changes, on pause, on undo
  and on dispose, and a cancelled answer is dropped. Its command is validated like a
  player's; an illegal one becomes an `AiFailed` notice rather than a retry loop.
- **The AI's stream** starts from `aiSeed` (default: forked from the game's random state)
  and is saved as the envelope's `aiRng`. Each choice gets its own child, fork number
  `seat` of the stream (`AiTask.rng`); the stream moves on only when an AI move is
  accepted. A restored game, even one saved while the AI was thinking, makes the same
  choices the original would have. Undo doesn't rewind it.
- **Heavy AI.** When the manifest declares `ai.heavy`, pass `workerAiRunner`; the worker
  receives the `AiTask` and posts back the command. Without one, the runner reports it and
  plays inline.
- **Undo** (host policy) returns to the start of the human's previous decision: it drops the
  human seat's latest command and everything after it, then replays the rest from the seed,
  random state included. The rule comes from `undoPolicyFor(manifest.undo, mode)`, so
  pass-and-play has undo only when the manifest names it; there undo takes back the last
  person's move. It is refused when the rule says `none`, with two human seats outside
  pass-and-play, past an `undoBarrier`, beyond a `{ limited: n }` allowance, after the
  outcome, or without history.
- **Assistance.** Every undo adds to `undosUsed` and puts `'undo'` in `assists`; a
  transition's `assist` flag adds its kind. Both travel in the save, so a limited allowance
  survives a reload, and the runner writes them into the outcome.
- **Pass-and-play** follows the human seat to act. With `handoff: true` (host policy) it first
  publishes `handoff: { seat, name }` with no viewer and the spectator view; the beats
  behind the screen are redacted for a spectator too. `reveal` shows that seat's view. A
  new game and a restored one both start with a hand-off. AI seats never take the viewer.
  When the outcome arrives, a hand-off game drops the viewer: the final snapshot, its beats
  included, is the spectator's (`viewFor(state, null)`), so the last player's hand isn't
  left on screen for whoever holds the device next. An engine whose rules show every hand
  at the end (a Gin Rummy knock) reveals them in its spectator view.
- **Elapsed time** starts at the first accepted input, or, for an engine that declares
  `clockStart: 'transition'`, at the first transition that sets `startsClock`. It pauses
  while the page is hidden or the game paused, and stops at the outcome, whose `elapsedMs`
  it fills. It travels in the save with `clockStarted`, so a resumed game neither starts the
  clock early nor restarts it. `elapsedMs()` reads it live for a stopwatch.
- **Saves.** The runner writes the envelope (with its replay) at the start, after every
  accepted change, when the page hides, on pause and on dispose, one write at a time. A
  failed write shows `SaveFailed` and play goes on. A position the engine's `worthSaving`
  rejects is never written, and the store's optional `clear` removes the save it would
  have replaced, so an untouched game is never offered for resuming.
- **Restoring** parses the envelope, checks the game id and rules version (`RulesChanged`
  means the game can't continue on this code), runs the migration chain, validates the
  state, then replays the saved log. If the replay reproduces the saved state and random
  state, undo and outstanding jobs carry on; otherwise the game resumes without history and
  the reason goes to `report`. The undo count, the assistance and the AI stream come from
  the envelope; a save without them starts with none and forks a new AI stream.
- **Jobs** start only after the transition that requested them is saved. The runner
  validates the payload, enforces `timeoutMs`, parses the result with the job's schema
  (anything invalid becomes `{ ok: false, reason: 'failed' }`), strips `presentation` into
  the snapshot and feeds the rest to the engine as a `job` input. A result for a job the
  game no longer awaits (undone, superseded, disposed) is dropped. `where: 'server'` jobs
  and jobs without a runner fail at once, and the engine decides what that means.
- **Timeouts** never happen locally: solo, vs-AI and pass-and-play run no clock (host policy).

## The fixed-step runner

```ts
const result = createFixedStepRunner(simulation, {
  ...browserPorts(), manifest, seats, config, seed, restoreRng, storage,
});
```

- **Accumulator.** Each frame adds the elapsed time and runs one `step` per `1000 / stepHz`
  milliseconds it covers. Catch-up is capped (`maxStepsPerFrame`, default a tenth of a
  second's worth); after a stall the backlog is dropped rather than freezing the page.
- **Inputs** (`{ kind: 'input', input }`) are validated and queued; all queued inputs go to
  the next tick that runs, in arrival order, and into the replay log with that tick.
- **Pause.** Hiding the page or `{ kind: 'pause' }` stops frames, resets the accumulator and
  saves a checkpoint; resuming starts from a fresh frame, so paused time never becomes
  ticks. Inputs while paused are rejected.
- **Snapshots** come at frame cadence: one per frame that ran ticks, with the tick events
  since the last one. `alpha()` gives the fraction of the next tick for interpolation.
- **Time** is ticks: `elapsedMs` is `tick × step length`.
- **Checkpoints** (`save()`) carry the state, random state, tick and replay;
  `restoreFixedStepRunner` resumes one, and running 500 ticks, saving, restoring and running
  500 more equals running 1,000.
- A `step` that throws is a bug: the runner keeps the last good tick, stops and shows an
  `InternalError` notice.

## The remote client

```ts
import { createRemoteSession } from '@joystyk/session';
import { browserClock } from '@joystyk/session/browser';
import { browserSocket, createRoom, randomActionId, roomsSocketUrl, webStorageTokens } from '@joystyk/session/browser/rooms';

const tokens = webStorageTokens();
const created = await createRoom(location.origin, { game: manifest.id, name });   // POST /api/rooms
if (created.ok) tokens.set(created.value.room, created.value.token);              // before the socket opens
const session = createRemoteSession({
  game: { id: manifest.id, build: manifest.versions.build, rulesVersion: engine.rulesVersion, schemas: engine.schemas },
  room: code, name, watch: false,
  connect: browserSocket(roomsSocketUrl(location.origin)), tokens,
  clock: browserClock(), actionId: randomActionId, random: Math.random,
});
```

`@joystyk/session/browser/rooms` is its own entry, so a page that never opens a room never
loads the protocol's schemas. It also has `fetchRoomInfo` (`GET /api/rooms/:code`).

**Inputs** (`RemoteInput`): `command` (from the viewer's seat, checked with the game's command
schema before it is sent; a command that names another seat is refused with `wrong-seat`), `resign`, `control` (a room control: ready, settings,
fill-with-ai, remove-seat, start, rematch), `reconnect` (take the seat back after another tab
replaced this one), `leave` (give the seat up) and `resync`. The local runner's `pause`,
`resume`, `reveal` and `undo` mean nothing in a room and are ignored.

**Snapshots** (`RemoteSnapshot`) are the contract's `EngineSnapshot` with `view` null in a
lobby, plus `room`: the code, phase, host, public seats, settings, game pin, who is
connected, the spectator count, whether the room is frozen, a match counter that rises at
every start and rematch, and when the clocks were read. They follow the same six rules as the
local runner's.

- **The envelope.** Every message is decoded with the protocol's Zod schemas, then the view
  and each event with the game's own schemas. Anything that fails is reported and dropped.
- **`meta`.** `connection` is `connecting`, `online`, `reconnecting` or `closed`; `seat` is
  null for a spectator and follows the renumbering at `start`; `clocks` come from the room's
  `presence`; `safePoint` is true outside a running match; `notice` carries rejections
  (`game:NotYourTurn`), connection problems and the server's `name-replaced`.
- **Beats.** An update's beats are published with that update only; snapshots and presence
  messages publish none, so a game plays every beat back exactly once.
- **Revisions.** Each action carries a fresh action ID and the revision the player saw. An
  update whose `from` isn't the client's revision asks for a `resync`; an older snapshot of
  the same epoch is ignored, and any snapshot of a new epoch (a restored backup) wins.
- **Reconnecting.** A dropped socket reconnects after `min(10 s, 500 ms · 2ⁿ)` plus up to
  250 ms of jitter (Greed's backoff), or after the server's `retryAfterMs` when it restarts,
  and rejoins with the stored token. Actions without a receipt are resent with the same ID,
  so the receipt answers them; actions while offline are refused with an `offline` notice.
  A newer tab (4001), leaving (4002) and a closed room (4004, which also forgets the token)
  stop it for good.
- **Versions.** A room on another rules version closes the session with an `update` notice.

## Replays

`replayEngine` and `replaySimulation` rebuild a recorded game from its seed and inputs. The
runners use the same code for undo and restore; the `testing` package's conformance tests
will use it for replay equality.

## Tests

- `local.test.ts` and `fixed-step.test.ts` run in Node with fake ports
  (`fakes.test-util.ts`) and two fixture games (`fixtures.test-util.ts`): a Nim variant with
  hidden numbers, a barrier, a dice job, a randomized and a throwing command, and a drifting
  point simulation.
- `rngs.test.ts` checks how the AI stream forks and moves on.
- `remote.test.ts` drives the remote client with a fake socket: joining with a token,
  snapshots and updates, action IDs and revisions, receipts and notices, backoff and close
  codes, spectators and disposal. `apps/rooms/src/remote-session.test.ts` runs it against the
  real room server and engines (two players and a spectator through a restart; Greed's throw).
- `browser/browser.browser.test.ts` runs the adapters, and both runners on them, in
  Chromium.
