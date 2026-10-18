# @joystyk/rooms

The room server for every server-authoritative multiplayer game: a pure room core, the
versioned wire protocol, and a Node adapter that runs the core on WebSockets, SQLite, one
timer per room and a `worker_threads` job pool. The design is
room-server.md (Joystyk host reference); its "Changes from implementation"
section lists where this package departs from the first draft.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/rooms
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/rooms` | ES module and TypeScript declarations |
| `@joystyk/rooms/protocol` | ES module and TypeScript declarations |
| `@joystyk/rooms/node` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

| Entry | Kind | Contents |
| --- | --- | --- |
| `@joystyk/rooms` | Pure | `createRoomCore`, the room types, the record schema and migrations, `policyFromManifest`, `admitName` |
| `@joystyk/rooms/protocol` | Pure (`zod/mini`) | Wire schemas and types, `PROTOCOL_VERSION`, close and rejection codes |
| `@joystyk/rooms/node` | Node | `createRoomServer`, `RoomHost`, `openSqliteStore`, `workerJobPool`, `createEngineRegistry` |

The `session` package, and the `p2p` package that comes after launch (host policy), may import
`@joystyk/rooms/protocol` and nothing else from here. The service that deploys all of this
is `apps/rooms` (`@joystyk/rooms-server`).

## The core

A room is a value. Everything that happens to it goes through one function:

```ts
import { createRoomCore } from '@joystyk/rooms';

const core = createRoomCore({ engine, pin: { id: 'hearts', build: '1.4.0', rulesVersion: 3, saveVersion: 2 }, rng: sfc32 });
const created = core.create({ code, policy, config, seeds, creator: { name, tokenHash } }, now);
let room = core.load(created.value);
const { room: next, effects } = core.step(room, { type: 'resume' }, now);
```

`step(room, command, now)` reads no clock, randomness, storage or network. Commands are
`join`, `leave`, `act`, `control` (ready, settings, fill-with-ai, remove-seat, start,
offer, accept, decline, withdraw, leave-seat, resign), `resync`, `timer-fired`, `job-completed`, `ai-chosen`,
`resume` and `close`. Effects are data for the adapter: `persist` (always first, at most
once), `welcome`, `send`, `drop`, `alarm`, `start-job`, `start-ai` and `log`.

What the core guarantees, each covered by the property tests in `core.property.test.ts`:

- **Deterministic.** The same room, command and `now` give deeply equal steps.
- **Persist before broadcast.** If the record changed, the first effect saves it; a
  rejection changes nothing durable.
- **Per-seat staleness.** An action is stale only if the seat's `decisionKey` changed
  after the revision the client saw, so simultaneous moves aren't refused.
- **Receipts.** A retried action ID with the same payload gets its original receipt, even
  after a restart; the same ID with a different payload is refused.
- **Clocks as data.** Deadlines live in the record; whatever is due at `now` applies before
  the command. A timer that fires early, late or twice can't apply a stale move. A room
  runs a per-move clock or a time bank with increment (`policy.bank`); banks are charged
  from the record alone, never for a playback hold.
- **The AI's stream.** Each AI decision gets a child forked from `aiRng` with the kit's
  `forkRng`; the stream moves only when an AI move is accepted. A heavy AI
  (`heavyAi: true`) never chooses inside a step: the core emits `start-ai`, the adapter runs
  it on the pool, and `ai-chosen` applies only if the seat still waits on that decision.
- **No leaks.** Each seat receives `viewFor(state, seat)` and `eventFor(event, seat)`;
  spectators get the `null` view.
- **Paused when empty.** With no player connected, no AI move, clock, offer or absence
  policy runs. The pause is recorded (`match.pausedAt`), and when a player returns every
  deadline moves on by its length, so no clock or bank is charged for it (host policy).
- **Offers.** Any seated player offers a rematch, or to end a match early; the others
  accept or decline, and the proposer may withdraw. A rematch starts once every seated
  player has accepted (computer seats accept on their own); an early end needs every other
  connected player, or a minute with nobody declining, and leaves no result (host policy).
- **Pinned versions.** A match keeps its game build and rules version; a rematch starts on
  the newest engine.
- **Filtered names.** The creator's name and every name that claims a seat pass
  `checkDisplayName` from `@joystyk/identity/names`, the only part of identity this package
  imports. A refused name becomes a generated one, seeded by the room's code, epoch, revision
  and seat, so the step stays deterministic; the player gets a `name-replaced` notice that
  says why, and `POST /api/rooms` answers with the seat's `name` and the same `notice`.

The core takes the engine's seeded generator as an argument (`rng: (state) => Rng`; the
service passes the kit's `restoreRng`). The adapter supplies fresh seeds and token hashes; no
secret ever enters the core.

## The Node adapter

```ts
import { createEngineRegistry, createRoomServer, openSqliteStore, workerJobPool } from '@joystyk/rooms/node';

const store = await openSqliteStore('/data/rooms.sqlite');
const registry = createEngineRegistry([{ pin, engine, policy, jobs: { throw: new URL('./jobs/throw.worker.ts', import.meta.url) } }], sfc32);
const server = createRoomServer({ store, registry, seeds, pool: workerJobPool({ workers: 1, module: registry.jobModule }), publicOrigin });
await server.listen(8787);
process.once('SIGTERM', () => void server.drain());
```

- **HTTP.** `POST /api/rooms` creates a room and returns its code with the creator's seat
  token; `GET /api/rooms/:code` describes it; `GET /api/rooms/games` lists the games the
  registry hosts and the protocol versions (`HostedGames`), which the launcher reads before
  offering Online with friends; `/healthz` and `/readyz` serve Compose.
- **WebSocket** at `/ws`. Messages are decoded with the protocol schemas, then the game's
  own command schema. The server answers each connection in the protocol version it joined
  with.
- **Persistence.** `node:sqlite` in WAL mode. Each persist is one transaction that updates
  the row only if its `writes` count matches, so a second writer gets `conflict` and
  unloads. A failed write keeps the old state, sends nothing and retries. Schema migrations
  run at start-up, a newer database is refused, and corrupt rows move to `room_archive`.
- **Limits.** Payload size, a message-rate token bucket, rooms per address per hour,
  unknown-code joins per address, connections per address and in total, rooms in memory,
  spectators per room, outgoing buffer size and a WebSocket ping heartbeat. The client address
  is read only from a trusted proxy (an IP or CIDR range).
- **Jobs.** A game's `jobs/<kind>.worker.ts` default-exports `(payload) => JobOutcome`; its
  `jobs/ai.worker.ts` (heavy AI) maps `{ view, seat, level, rng }` to a command. The pool
  bounds queued work, times out stuck jobs from when they start (a heavy AI after
  `aiTimeoutMs`) and restarts the worker. A heavy AI the pool couldn't answer is asked again
  with backoff.
- **Drain and resume.** `drain()` refuses new work, waits for running jobs, sends
  `closing` and closes with 1012. On start, rooms with an outstanding job load at once so
  the job re-runs; other rooms load when someone joins.
- **Logs.** One JSON object per line, never with tokens, names, addresses or game state.

## Tests

| File | What it proves |
| --- | --- |
| `core.test.ts` | Seats and display names, receipts, stale and future revisions, controls, AI handover, the host, clocks, jobs, failures |
| `core.clocks-ai.test.ts` | Time banks, the AI stream, heavy AI |
| `core.pause.test.ts` | A paused table: clocks stop and resume, banks are charged only for live time, a pause survives a restart |
| `core.offers.test.ts` | Rematch and end-match offers: offer, accept, decline, withdraw, computer seats accepting, the one-minute end, a pause during it |
| `core.property.test.ts` | The invariants above, under random command sequences for five set-ups: hidden hands, AI handover, heavy AI, a time bank and a simultaneous phase |
| `protocol/protocol.test.ts` | Message schemas, and that every message the core sends decodes |
| `node/store.test.ts` | The SQLite store on a real file: conflicts, migrations, quarantine, backups |
| `node/host.test.ts` | Restart and resume, a failing store, two writers, jobs that survive a restart |
| `node/server.test.ts` | Two real WebSocket clients: join, play, reconnect, newest tab wins, spectators, a replaced name, limits, drain |
| `node/jobs.test.ts` | The `worker_threads` pool with real worker modules |

The test games live in `src/__tests__/fixtures.ts`: Nim (turn-based), Peek (hidden hands,
a job, an AI) and Pass (a simultaneous phase whose decision key ignores who has passed).
