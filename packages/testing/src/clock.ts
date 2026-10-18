// A fake clock: time moves only when a test says so.

/** A scheduled callback; cancelling it twice, or after it fired, is harmless. */
export type TimerHandle = { cancel(): void };

/**
 * A manual clock with timers. It has the shape of the room server's `Clock` port
 * (`now` and `setTimer`, room-server.md section 4.1) plus controls for tests.
 */
export interface FakeClock {
  /** Current time in milliseconds. */
  now(): number;
  /** Calls `fire` once the clock reaches `at`. A time in the past fires on the next advance. */
  setTimer(at: number, fire: () => void): TimerHandle;
  /** Calls `fire` after `delayMs` more milliseconds. */
  setTimeout(fire: () => void, delayMs: number): TimerHandle;
  /**
   * Moves time forward by `ms`, firing due timers in time order (ties in the order they were
   * set). The clock reads each timer's own time while it fires, and timers set by a callback
   * fire in the same call if they fall due. Returns how many fired.
   */
  advance(ms: number): number;
  /** Like `advance`, to an absolute time. Moving backwards throws. */
  advanceTo(time: number): number;
  /** Advances to each pending timer in turn until none is left. Throws after `limit` firings. */
  runAll(limit?: number): number;
  /** How many timers are waiting. */
  pendingTimers(): number;
}

type Timer = { readonly at: number; readonly order: number; readonly fire: () => void; cancelled: boolean };

/** A fake clock starting at `start` milliseconds (default 0). */
export const createFakeClock = (start = 0): FakeClock => {
  let time = start;
  let order = 0;
  let timers: Timer[] = [];

  const setTimer = (at: number, fire: () => void): TimerHandle => {
    if (!Number.isFinite(at)) throw new RangeError(`Timer time must be finite, got ${at}.`);
    const timer: Timer = { at, order: (order += 1), fire, cancelled: false };
    timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  };

  const nextDue = (until: number): Timer | undefined => {
    timers = timers.filter((t) => !t.cancelled);
    let best: Timer | undefined;
    for (const t of timers) {
      if (t.at <= until && (best === undefined || t.at < best.at || (t.at === best.at && t.order < best.order)))
        best = t;
    }
    return best;
  };

  const advanceTo = (target: number): number => {
    if (target < time) throw new RangeError(`The fake clock can't go back from ${time} to ${target}.`);
    let fired = 0;
    for (let timer = nextDue(target); timer !== undefined; timer = nextDue(target)) {
      timer.cancelled = true;
      time = Math.max(time, timer.at);
      fired += 1;
      timer.fire();
    }
    time = target;
    return fired;
  };

  return {
    now: () => time,
    setTimer,
    setTimeout: (fire, delayMs) => setTimer(time + delayMs, fire),
    advance: (ms) => advanceTo(time + ms),
    advanceTo,
    runAll: (limit = 10_000) => {
      let fired = 0;
      for (let timer = nextDue(Infinity); timer !== undefined; timer = nextDue(Infinity)) {
        if (fired >= limit)
          throw new Error(`runAll fired ${limit} timers and timers remain; a timer probably reschedules itself.`);
        fired += advanceTo(Math.max(time, timer.at));
      }
      return fired;
    },
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
};
