// Waiting in tests on a busy machine. The suite shares its machine with other work, so a
// test never sleeps for a fixed time and hopes, and never gives a condition a budget measured
// in seconds of wall-clock time it might not get. It waits for the condition itself, with a
// budget that only a real failure exhausts. A real-time game runs on `manualFrames`, which
// counts game time in frames the test runs, so load slows the test down but can't change
// what happens in it. See docs/design-docs/testing-under-load.md.
import type { FrameScheduler } from '@joystyk/session';

// This package names neither DOM nor Node types; these exist in both.
const host = globalThis as unknown as {
  setTimeout(callback: () => void, ms: number): unknown;
  performance: { now(): number };
  MessageChannel?: new () => {
    port1: { onmessage: (() => void) | null; close(): void };
    port2: { postMessage(message: unknown): void };
  };
};

/**
 * The default wall-clock budget for a wait: generous, but under the browser and e2e
 * projects' 60-second test timeout, so a wait that fails names what never happened instead of
 * ending in a bare timeout.
 */
export const WAIT_BUDGET_MS = 45_000;

/** Resolves after `ms` milliseconds: for yielding to the page, never for waiting on a result. */
export const pause = (ms: number): Promise<void> => new Promise((resolve) => host.setTimeout(resolve, ms));

/**
 * Resolves on a fresh task, without the 4 ms clamp nested timers get, so the events,
 * commands and due timers queued before it can run.
 */
export const nextTask = (): Promise<void> => {
  const Channel = host.MessageChannel;
  if (Channel === undefined) return pause(0);
  return new Promise((resolve) => {
    const channel = new Channel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
};

export type WaitOptions = {
  /** The wall-clock budget. Default `WAIT_BUDGET_MS`. */
  readonly timeoutMs?: number;
  /** How often to check. Default 10 ms. */
  readonly intervalMs?: number;
};

/**
 * Resolves once `condition` holds, checking every few milliseconds. Fails with "Timed out
 * waiting for <what>" after the budget, which by default is most of the test's own timeout.
 */
export const waitUntil = async (condition: () => boolean, what: string, options: WaitOptions = {}): Promise<void> => {
  const budget = options.timeoutMs ?? WAIT_BUDGET_MS;
  const start = host.performance.now();
  while (!condition()) {
    if (host.performance.now() - start > budget)
      throw new Error(`Timed out after ${String(budget)} ms waiting for ${what}.`);
    await pause(options.intervalMs ?? 10);
  }
};

export type FrameWaitOptions = {
  /** The most frames that may run a callback before the wait fails: game time. Default 3600 (a minute at 60 Hz). */
  readonly maxFrames?: number;
  /** The wall-clock budget, for waits on the UI while the runner is paused. Default `WAIT_BUDGET_MS`. */
  readonly timeoutMs?: number;
};

/** A frame scheduler that runs only when the test says so. */
export interface ManualFrames {
  /** Pass this as the runner's `frames` port. */
  readonly port: FrameScheduler;
  /**
   * Runs `count` frames, each `frameMs` after the last, and returns how many of them had a
   * callback waiting. A paused or finished runner requests none, so it returns 0.
   */
  run(count: number): number;
  /** True when a callback waits for the next frame. */
  pending(): boolean;
  /**
   * Runs `count` frames, yielding to the page between them as `until` does, so input that
   * arrives meanwhile is handled. For checking that nothing happens over some game time.
   * Returns how many frames had a callback waiting.
   */
  advance(count: number): Promise<number>;
  /**
   * Runs one frame at a time until `condition` holds, yielding to the page between frames
   * so events, commands and timers run. Game time can't outrun the check, so a phase that
   * lasts a few ticks is never skipped, and a busy machine only makes the wait take longer.
   * Fails after `maxFrames` frames that ran a callback, or after the wall-clock budget.
   */
  until(condition: () => boolean, what: string, options?: FrameWaitOptions): Promise<void>;
}

/** A manual frame scheduler for a fixed-step runner, at `frameMs` per frame (default 60 Hz). */
export const manualFrames = (frameMs = 1000 / 60): ManualFrames => {
  let pending: ((now: number) => void) | null = null;
  let now = 0;
  const port: FrameScheduler = {
    request: (callback) => {
      pending = callback;
      return () => {
        if (pending === callback) pending = null;
      };
    },
  };
  const run = (count: number): number => {
    let ran = 0;
    for (let i = 0; i < count; i += 1) {
      const callback = pending;
      pending = null;
      if (callback !== null) {
        ran += 1;
        callback(now);
      }
      now += frameMs;
    }
    return ran;
  };
  const until = async (condition: () => boolean, what: string, options: FrameWaitOptions = {}): Promise<void> => {
    const maxFrames = options.maxFrames ?? 3600;
    const budget = options.timeoutMs ?? WAIT_BUDGET_MS;
    const start = host.performance.now();
    let frames = 0;
    while (!condition()) {
      if (frames >= maxFrames) throw new Error(`Gave up waiting for ${what} after ${String(maxFrames)} frames.`);
      if (host.performance.now() - start > budget)
        throw new Error(`Timed out after ${String(budget)} ms waiting for ${what} (${String(frames)} frames run).`);
      if (pending === null) {
        // Nothing to run: the runner is paused or waiting on the UI. Let the page catch up.
        await pause(10);
      } else {
        frames += run(1);
        await nextTask();
      }
    }
  };
  const advance = async (count: number): Promise<number> => {
    let ran = 0;
    for (let i = 0; i < count; i += 1) {
      await nextTask();
      ran += run(1);
    }
    await nextTask();
    return ran;
  };
  return { port, run, pending: () => pending !== null, until, advance };
};
