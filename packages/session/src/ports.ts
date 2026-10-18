// The runners' ports: everything outside pure computation arrives through one of these, so
// the core stays headless and tests drive time, visibility, storage, frames and jobs by hand.
// Browser implementations live in `@joystyk/session/browser`.
import type { JobRequest, JobSpec, Rng, RngState, SaveEnvelope, SeatId } from '@joystyk/contracts';

/** Work that finishes later and can be abandoned. After `cancel`, the result is ignored. */
export type Task<T> = {
  readonly result: Promise<T>;
  cancel(): void;
};

/** Monotonic time and timers. */
export interface Clock {
  /** Milliseconds from an arbitrary origin; never goes backwards. */
  now(): number;
  /** Runs `callback` after `ms` milliseconds. The returned function cancels it. */
  after(ms: number, callback: () => void): () => void;
}

/** Whether the page is hidden (another tab, a locked phone). */
export interface Visibility {
  hidden(): boolean;
  /** Calls `listener` on every change. The returned function unsubscribes. */
  subscribe(listener: (hidden: boolean) => void): () => void;
}

/** Where a runner writes its save envelope after each accepted change. */
export interface SaveStore {
  write(save: SaveEnvelope): Promise<void>;
  /**
   * Removes the saved game, when the position is no longer worth resuming (the engine's
   * `worthSaving`). Without it, the runner only stops writing.
   */
  clear?(): Promise<void>;
}

/**
 * Performs an engine's asynchronous jobs (Greed's dice throw). The runner validates the
 * payload before calling it and parses the result afterwards, so the result is `unknown`.
 * It enforces `spec.timeoutMs` itself.
 */
export interface JobRunner {
  run(job: JobRequest, spec: JobSpec): Task<unknown>;
}

/**
 * What an AI runner receives: one seat's view, never the state, and the random state the
 * choice must draw from (restore it with the kit's `restoreRng`). All of it is JSON, so it
 * can be posted to a worker as is.
 */
export type AiTask<View> = {
  readonly view: View;
  readonly seat: SeatId;
  readonly level: string;
  /** This decision's own stream, forked from the AI's saved stream. Always the kit's SFC32. */
  readonly rng: RngState;
};

/**
 * Chooses commands for AI seats. The default runs the engine's `ai.choose` after a short
 * delay on the clock; a game whose manifest declares heavy AI gets one that runs in a worker
 * (`workerAiRunner` in `@joystyk/session/browser`). The command is parsed with the engine's
 * command schema, so the result is `unknown`.
 */
export interface AiRunner<View> {
  choose(task: AiTask<View>): Task<unknown>;
}

/** Schedules one callback for the next display frame. The returned function cancels it. */
export interface FrameScheduler {
  request(callback: (now: number) => void): () => void;
}

/** Rebuilds a seeded random source from its saved state. The default is the kit's `restoreRng`. */
export type RngFactory = (state: RngState) => Rng;

/**
 * Receives bugs the runner caught and survived: an engine that threw, a listener that threw,
 * a failed save. The player sees a notice; this is for logs.
 */
export type Reporter = (error: unknown, context: string) => void;

/** A page that is never hidden: the default when no visibility port is given. */
export const alwaysVisible: Visibility = {
  hidden: () => false,
  subscribe: () => () => {},
};
