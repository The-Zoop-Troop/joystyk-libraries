import type { EngineInput } from './engine.ts';
import type { Json } from './json.ts';
import type { RngState } from './rng.ts';
import type { SeatInfo } from './seats.ts';

/**
 * A Layer 2 replay: `init` with the seed, then every input in order. It holds every player's
 * commands, including hidden ones, so it stays private to the authority (D-35: no shared
 * replay links in v1). Valid only for the `rulesVersion` that recorded it.
 */
export type EngineReplay<Command extends Json = Json, Config extends Json = Json> = {
  readonly layer: 2;
  readonly gameId: string;
  readonly rulesVersion: number;
  /** The engine's Config, after any preparation; replay never re-runs a preparer. */
  readonly config: Config;
  readonly seats: readonly SeatInfo[];
  /** The rng state `init` received. */
  readonly seed: RngState;
  /** Commands, seat changes, timeouts, resignations and job outcomes (without presentation). */
  readonly inputs: readonly EngineInput<Command>[];
};

/** An input with the tick the scheduler assigned it to. */
export type TickInput<Input> = {
  readonly tick: number;
  readonly input: Input;
};

/** A Layer 3 replay: `init` with the seed, then `step` up to `endTick`. */
export type SimulationReplay<Input extends Json = Json, Config extends Json = Json> = {
  readonly layer: 3;
  readonly gameId: string;
  readonly rulesVersion: number;
  readonly config: Config;
  readonly seed: RngState;
  /** Order within a tick is array order. */
  readonly inputs: readonly TickInput<Input>[];
  readonly endTick: number;
};

/** Either replay format; `layer` tells them apart. */
export type Replay = EngineReplay | SimulationReplay;
