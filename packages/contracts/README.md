# @joystyk/contracts

The game contract as plain TypeScript: the types every game implements and every platform
package relies on, plus a few pure helpers. It has zero runtime dependencies and uses no
DOM or Node types, so it runs in the browser, in workers and on the server (host policy).

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/contracts
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/contracts` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

The source of truth is game-contract.md (Joystyk host reference). When the
two disagree, fix the document first, then this package.

## What's here

| Module | Contents |
| --- | --- |
| `json.ts` | `Json` and its parts; `isJson`, which checks that a value survives a JSON round trip |
| `result.ts` | `Result` (error defaults to `GameError`), `ok`, `err`, `gameError`, `isGameError` |
| `standard-schema.ts` | The Standard Schema v1 types, vendored (see *Provenance*) |
| `schema.ts` | `Validator<T>`: a Standard Schema that decodes unknown input into `T` |
| `seats.ts`, `rng.ts`, `outcome.ts`, `versions.ts` | `SeatId`, `SeatInfo`; the `Rng` interface and `RngState`; `Outcome`, `AssistKind`, `ASSIST_KINDS`; `GameVersions` |
| `session.ts` | Layer 1: `GameSession`, `SessionMeta`, `SeatClock`, `EngineSnapshot`, `SimulationSnapshot` |
| `engine.ts` | Layer 2: `DiscreteEngine`, `EngineInput`, `Transition`, `EngineAi`, room hooks; `defineEngine` |
| `simulation.ts` | Layer 3: `FixedStepSimulation`, `StepResult`; `defineSimulation` |
| `jobs.ts` | `JobSpec`, `JobRequest`, `JobOutcome` |
| `save.ts` | `SaveEnvelope`, `Migration`; `runMigrations` |
| `replay.ts` | `EngineReplay` (Layer 2), `SimulationReplay` (Layer 3), `Replay` |
| `manifest.ts` | `GameManifest`, `Mode`, `UndoPolicy`, `UndoByMode`, `TurnClock`, `BankClock`, `AiDeclaration`, `RoomDefaults`; `defineManifest`, `isGameId`, `undoPolicyFor` |
| `module.ts` | `GameEntry`, `GameModule`, `Preparer`, `SessionContext`, `PlatformApi`, `Preferences` |

Import everything from the package root: `import { ok, type DiscreteEngine } from '@joystyk/contracts'`.

There is no random number generator here, only the `Rng` interface. The seeded
implementations live in `@joystyk/kit`.

## How a game uses it

A turn-based game writes a pure engine and lets the platform do the rest:

```ts
import { defineEngine, err, gameError, ok } from '@joystyk/contracts';

// Declare data with `type`, not `interface`: an interface never satisfies `Json`.
type State = { readonly heap: number; readonly turn: number; readonly winner: number | null };
type Command = { readonly type: 'take'; readonly count: number };

export const engine = defineEngine({
  rulesVersion: 1,
  schemas: { config, command, state, view, event }, // Standard Schemas, e.g. from zod/mini
  init: (config: { heap: number }, seats, rng) => ok({ heap: config.heap, turn: rng.int(0, 2), winner: null }),
  apply: (state: State, input, rng) => {
    if (input.kind === 'command' && input.seat !== state.turn) {
      return err(gameError('NotYourTurn', "It's not your turn."));
    }
    // … one input becomes one complete transition: { state, beats }
  },
  pending: (state) => (state.winner === null ? [state.turn] : []),
  viewFor: (state, viewer) => state, // hide everything `viewer` may not see
  eventFor: (event, viewer) => event,
  outcome: (state) => null,
});
```

`defineEngine`, `defineSimulation` and `defineManifest` return their argument unchanged;
they exist so TypeScript infers the type parameters and checks the object. The compiler
then enforces the contract's main rules: state, commands, views, events and config must be
JSON, `viewFor` must return the view type, and a manifest must declare its versions, its
privacy flags, its undo policy and its clock.

The game's `entry.ts` exports a `GameEntry`: its manifest (static data, read by the index
without loading game code), a `load()` that imports the `GameModule`, and, for games that
generate their configuration, a `loadPreparer()` that a worker can import without DOM code.
Browser code uses `GameModule<HTMLElement>`; this package names no DOM types, so the mount
slot is a type parameter.

Platform packages use the `Any…` aliases (`AnyDiscreteEngine`, `AnyFixedStepSimulation`,
`AnyGameSession`) to hold a game without knowing its types, `runMigrations` to bring a save
up to date, `undoPolicyFor` to read a manifest's undo rule for a mode, and `isJson` in
conformance tests.

## Provenance

`src/standard-schema.ts` holds the type definitions of
[Standard Schema](https://standardschema.dev) v1, copied from `@standard-schema/spec` 1.1.0
(`dist/index.d.ts`; tarball SHA-256
`a7cb7268be280ab518d450f8c3b07c86f23417225c0ab53691ed59b3067cceaf`). They are MIT-licensed
(Copyright (c) 2024 Colin McDonnell); the license text is in the file's header. The spec asks
libraries to copy these types rather than depend on the package. The only changes are
formatting and exporting each declaration in place. Don't edit the declarations; to update,
copy a newer release and record its version and checksum here and in the file header.
