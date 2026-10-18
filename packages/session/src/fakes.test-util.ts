// Test doubles for the runners' ports: a deterministic RNG, a manual clock, visibility,
// storage, frames and jobs. Tests drive each one by hand.
import type { JobRequest, Rng, RngState, SaveEnvelope } from '@joystyk/contracts';
import type { Clock, FrameScheduler, JobRunner, SaveStore, Task, Visibility } from './ports.ts';

/**
 * Mulberry32: a tiny seeded generator, standing in for `@joystyk/kit` in these tests. Its
 * state is one 32-bit word.
 */
export const testRng = (state: RngState): Rng => {
  if (state.algorithm !== 'mulberry32') throw new Error(`testRng can't run ${state.algorithm}`);
  let a = (state.words[0] ?? 0) | 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min));
  return {
    next,
    int,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = int(0, i + 1);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
    save: () => ({ algorithm: 'mulberry32', words: [a >>> 0] }),
  };
};

export const seed = (n: number): RngState => ({ algorithm: 'mulberry32', words: [n] });

/** Lets every pending promise callback run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

export type ManualClock = Clock & {
  advance(ms: number): void;
  readonly pending: () => number;
};

/** Time moves only when a test calls `advance`; due timers fire in order. */
export const manualClock = (start = 1000): ManualClock => {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { readonly at: number; readonly callback: () => void }>();
  return {
    now: () => now,
    after: (ms, callback) => {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), callback });
      return () => {
        timers.delete(id);
      };
    },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((x, y) => x[1].at - y[1].at || x[0] - y[0])[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = end;
    },
    pending: () => timers.size,
  };
};

export type ManualVisibility = Visibility & { set(hidden: boolean): void; readonly listeners: () => number };

export const manualVisibility = (hidden = false): ManualVisibility => {
  let current = hidden;
  const listeners = new Set<(hidden: boolean) => void>();
  return {
    hidden: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (value) => {
      current = value;
      for (const listener of [...listeners]) listener(value);
    },
    listeners: () => listeners.size,
  };
};

export type MemoryStore = SaveStore & {
  readonly saves: SaveEnvelope[];
  last(): SaveEnvelope | undefined;
  /** What the slot holds now: the last write since the last `clear`, or null. */
  slot(): SaveEnvelope | null;
  /** How many times the runner cleared the slot. */
  clears: number;
  /** When set, writes wait until `release()`. */
  hold: boolean;
  release(): void;
  failNext: boolean;
};

export const memoryStore = (): MemoryStore => {
  let waiting: (() => void)[] = [];
  let slot: SaveEnvelope | null = null;
  const keep = (copy: SaveEnvelope): void => {
    store.saves.push(copy);
    slot = copy;
  };
  const store: MemoryStore = {
    saves: [],
    last: () => store.saves.at(-1),
    slot: () => slot,
    clears: 0,
    clear: () => {
      store.clears += 1;
      slot = null;
      return Promise.resolve();
    },
    hold: false,
    failNext: false,
    release: () => {
      const run = waiting;
      waiting = [];
      for (const resolve of run) resolve();
    },
    write: (save) => {
      if (store.failNext) {
        store.failNext = false;
        return Promise.reject(new Error('quota exceeded'));
      }
      // A JSON round trip, as real storage would do.
      const copy = JSON.parse(JSON.stringify(save)) as SaveEnvelope;
      if (!store.hold) {
        keep(copy);
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiting.push(() => {
          keep(copy);
          resolve();
        });
      });
    },
  };
  return store;
};

export type ManualFrames = FrameScheduler & {
  /** Runs the waiting frame callback, if any, at time `now`. */
  frame(now: number): boolean;
  readonly waiting: () => boolean;
};

export const manualFrames = (): ManualFrames => {
  let callback: ((now: number) => void) | null = null;
  return {
    request: (next) => {
      callback = next;
      return () => {
        if (callback === next) callback = null;
      };
    },
    frame: (now) => {
      const run = callback;
      callback = null;
      run?.(now);
      return run !== null;
    },
    waiting: () => callback !== null,
  };
};

export type ManualJobs = JobRunner & {
  readonly started: JobRequest[];
  readonly cancelled: string[];
  resolve(id: string, outcome: unknown): void;
  reject(id: string, error: Error): void;
};

export const manualJobs = (): ManualJobs => {
  const open = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const jobs: ManualJobs = {
    started: [],
    cancelled: [],
    run: (job): Task<unknown> => {
      jobs.started.push(job);
      const result = new Promise<unknown>((resolve, reject) => open.set(job.id, { resolve, reject }));
      return {
        result,
        cancel: () => {
          jobs.cancelled.push(job.id);
          open.delete(job.id);
        },
      };
    },
    resolve: (id, outcome) => {
      open.get(id)?.resolve(outcome);
      open.delete(id);
    },
    reject: (id, error) => {
      open.get(id)?.reject(error);
      open.delete(id);
    },
  };
  return jobs;
};
