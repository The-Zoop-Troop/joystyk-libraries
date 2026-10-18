// Active play time (game-contract.md, "Saves"): it starts at the input that starts the clock
// (the first accepted one, or the engine's `startsClock` transition), pauses while the page is
// hidden or the game is paused, and stops at the outcome.
import type { Clock } from './ports.ts';

export type Stopwatch = {
  /** Milliseconds of active play so far, rounded to a whole number. */
  elapsed(): number;
  /** Starts the clock. Later calls do nothing. */
  start(): void;
  /** True once `start` was called (or the game was restored with its clock started). */
  started(): boolean;
  /** A confirmed new game: clear elapsed time and wait for its first meaningful input. */
  restart(): void;
  /** Stops for good (the game is over). */
  finish(): void;
  setHidden(hidden: boolean): void;
  setPaused(paused: boolean): void;
  running(): boolean;
};

export const createStopwatch = (
  clock: Clock,
  initial: {
    readonly elapsedMs: number;
    readonly started: boolean;
    readonly finished: boolean;
    readonly hidden: boolean;
  },
): Stopwatch => {
  let banked = initial.elapsedMs;
  let since: number | null = null;
  let started = initial.started;
  let finished = initial.finished;
  let hidden = initial.hidden;
  let paused = false;

  const shouldRun = (): boolean => started && !finished && !hidden && !paused;
  const sync = (): void => {
    const run = shouldRun();
    if (run && since === null) since = clock.now();
    if (!run && since !== null) {
      banked += Math.max(0, clock.now() - since);
      since = null;
    }
  };
  sync();

  return {
    elapsed: () => Math.round(banked + (since === null ? 0 : Math.max(0, clock.now() - since))),
    start: () => {
      started = true;
      sync();
    },
    started: () => started,
    restart: () => {
      banked = 0;
      since = null;
      started = false;
      finished = false;
      sync();
    },
    finish: () => {
      finished = true;
      sync();
    },
    setHidden: (value) => {
      hidden = value;
      sync();
    },
    setPaused: (value) => {
      paused = value;
      sync();
    },
    running: () => since !== null,
  };
};
