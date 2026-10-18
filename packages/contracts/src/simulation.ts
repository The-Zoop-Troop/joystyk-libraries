import type { ShareSummary } from './engine.ts';
import type { Json } from './json.ts';
import type { Outcome } from './outcome.ts';
import type { Result } from './result.ts';
import type { Rng } from './rng.ts';
import type { Validator } from './schema.ts';

/** The Standard Schemas a simulation publishes. Its view need not be JSON, so it has none. */
export interface SimulationSchemas<State, Input, Event, Config> {
  readonly config: Validator<Config>;
  readonly input: Validator<Input>;
  /** The current checkpoint shape. */
  readonly state: Validator<State>;
  readonly event: Validator<Event>;
}

/** The result of one tick. */
export type StepResult<State, Event> = {
  readonly state: State;
  /** One-off events for sound and effects, e.g. "wall completed". Never needed to rebuild state. */
  readonly events?: readonly Event[];
};

/**
 * Layer 3: a fixed-step simulation for real-time games. The platform's scheduler owns time:
 * it runs `step` once per tick at `stepHz`, assigns each input to the next tick, and pauses
 * when the page is hidden. Game timers count ticks, never wall time.
 */
export interface FixedStepSimulation<
  State extends Json,
  Input extends Json,
  View,
  Event extends Json,
  Config extends Json,
> {
  readonly rulesVersion: number;
  /** Simulation steps per second, e.g. 60. Independent of the display's refresh rate. */
  readonly stepHz: number;
  readonly schemas: SimulationSchemas<State, Input, Event, Config>;

  init(config: Config, rng: Rng): Result<State>;

  /** Advances exactly one tick. `inputs` are those assigned to this tick, in order. */
  step(state: State, inputs: readonly Input[], rng: Rng): StepResult<State, Event>;

  /** What the renderer draws. May be a cheap projection; need not be JSON. */
  view(state: State): View;

  outcome(state: State): Outcome | null;

  /** Spoiler-free daily results, derived only from the finished state. */
  share?(state: State): ShareSummary;

  /** When false, the platform waits before offering updates. */
  safePoint?(state: State): boolean;

  /** Pure checkpoint policy after a frame's ticks; e.g. save when a word clears. */
  checkpoint?(state: State, events: readonly Event[]): boolean;
}

/** Any simulation, as the launcher holds it without knowing the game's types. */
export type AnyFixedStepSimulation = FixedStepSimulation<Json, Json, unknown, Json, Json>;

/** Returns the simulation unchanged, so TypeScript infers its type parameters. */
export const defineSimulation = <State extends Json, Input extends Json, View, Event extends Json, Config extends Json>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
): FixedStepSimulation<State, Input, View, Event, Config> => simulation;
