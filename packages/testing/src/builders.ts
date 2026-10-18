// Fixture builders: seats, inputs, schemas, saves and replays, without boilerplate.

import type {
  EngineInput,
  EngineReplay,
  Json,
  JobOutcome,
  Replay,
  RngState,
  SaveEnvelope,
  SeatChange,
  SeatId,
  SeatInfo,
  SimulationReplay,
  StandardSchemaV1,
  TickInput,
  Validator,
} from '@joystyk/contracts';

const NAMES = ['Ana', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana'];

/**
 * `count` human seats with ids 0 … count − 1 and stable names. Pass `ai` to make some seats
 * AI seats: `seats(4, { ai: [1, 2, 3], aiLevel: 'easy' })`.
 */
export const seats = (
  count: number,
  options: { readonly ai?: readonly SeatId[]; readonly aiLevel?: string } = {},
): SeatInfo[] =>
  Array.from({ length: count }, (_, id): SeatInfo => {
    const name = NAMES[id] ?? `Seat ${id + 1}`;
    if (!(options.ai ?? []).includes(id)) return { id, name, controller: 'human' };
    return options.aiLevel === undefined
      ? { id, name: `${name} (AI)`, controller: 'ai' }
      : { id, name: `${name} (AI)`, controller: 'ai', aiLevel: options.aiLevel };
  });

/** A `command` input. */
export const commandInput = <C>(seat: SeatId, command: C): EngineInput<C> => ({ kind: 'command', seat, command });

/** A `resign` input. */
export const resignInput = <C = never>(seat: SeatId): EngineInput<C> => ({ kind: 'resign', seat });

/** A `timeout` input. */
export const timeoutInput = <C = never>(seat: SeatId): EngineInput<C> => ({ kind: 'timeout', seat });

/** A `seat` input. */
export const seatInput = <C = never>(seat: SeatId, change: SeatChange): EngineInput<C> => ({
  kind: 'seat',
  seat,
  change,
});

/** A `job` input carrying a successful outcome (without presentation, as the runner feeds it). */
export const jobResult = <C = never>(jobId: string, value: Json): EngineInput<C> => ({
  kind: 'job',
  jobId,
  outcome: { ok: true, value },
});

/** A `job` input carrying a failed outcome. */
export const jobFailure = <C = never>(jobId: string, reason: 'timeout' | 'failed' = 'failed'): EngineInput<C> => ({
  kind: 'job',
  jobId,
  outcome: { ok: false, reason } satisfies JobOutcome,
});

/**
 * A Standard Schema from a type guard. Enough for fixtures and tests; real games use a schema
 * library (Zod 4 by default, D-22).
 */
export const guardSchema = <T>(guard: (value: unknown) => value is T, message = 'Invalid value.'): Validator<T> => ({
  '~standard': {
    version: 1,
    vendor: 'joystyk-testing',
    validate: (value): StandardSchemaV1.Result<T> => (guard(value) ? { value } : { issues: [{ message }] }),
  },
});

/** A Standard Schema that accepts anything as `T`. Use it only where the test isn't about schemas. */
export const anySchema = <T>(): Validator<T> => ({
  '~standard': { version: 1, vendor: 'joystyk-testing', validate: (value) => ({ value: value as T }) },
});

/** A save fixture: the stored state of one shipped save version. */
export type SaveFixture = {
  /** A label for reports, e.g. "v1 mid-game". */
  readonly name: string;
  readonly saveVersion: number;
  readonly state: Json;
};

/** A save fixture, for the `saves` option of the engine suite. */
export const saveFixture = (name: string, saveVersion: number, state: Json): SaveFixture => ({
  name,
  saveVersion,
  state,
});

/** A save envelope with test defaults for everything but the state and the random state. */
export const saveEnvelope = (fields: Pick<SaveEnvelope, 'state' | 'rng'> & Partial<SaveEnvelope>): SaveEnvelope => ({
  gameId: 'test-game',
  build: '0.0.0-test',
  rulesVersion: 1,
  saveVersion: 1,
  seats: seats(2),
  ...fields,
});

/** A Layer 2 replay with test defaults. */
export const engineReplay = <C extends Json = Json, Cfg extends Json = Json>(fields: {
  readonly config: Cfg;
  readonly seats: readonly SeatInfo[];
  readonly seed: RngState;
  readonly inputs: readonly EngineInput<C>[];
  readonly gameId?: string;
  readonly rulesVersion?: number;
}): EngineReplay<C, Cfg> => ({
  layer: 2,
  gameId: fields.gameId ?? 'test-game',
  rulesVersion: fields.rulesVersion ?? 1,
  config: fields.config,
  seats: fields.seats,
  seed: fields.seed,
  inputs: fields.inputs,
});

/** A Layer 3 replay with test defaults. */
export const simulationReplay = <I extends Json = Json, Cfg extends Json = Json>(fields: {
  readonly config: Cfg;
  readonly seed: RngState;
  readonly inputs: readonly TickInput<I>[];
  readonly endTick: number;
  readonly gameId?: string;
  readonly rulesVersion?: number;
}): SimulationReplay<I, Cfg> => ({
  layer: 3,
  gameId: fields.gameId ?? 'test-game',
  rulesVersion: fields.rulesVersion ?? 1,
  config: fields.config,
  seed: fields.seed,
  inputs: fields.inputs,
  endTick: fields.endTick,
});

/** Narrows a replay by layer. */
export const isEngineReplay = (replay: Replay): replay is EngineReplay => replay.layer === 2;
