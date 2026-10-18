/**
 * The serializable state of a seeded random source. It lives in the runner's envelope, never
 * in game state or a view: a client that saw it could predict the next shuffle.
 */
export type RngState = {
  /** The algorithm, e.g. "sfc32". `@joystyk/kit` implements the algorithms. */
  readonly algorithm: string;
  readonly words: readonly number[];
};

/**
 * The only source of randomness an engine or simulation may use. The runner owns it; an
 * engine draws from it only during the call it was given and never keeps a reference.
 * Implementations live in `@joystyk/kit`.
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max). */
  int(min: number, max: number): number;
  /** Fisher–Yates shuffle into a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Current state, for saves and checkpoints. */
  save(): RngState;
}
