// Fakes for the session runner's ports, so a game's tests can play it through
// `createLocalSession` with time and saves under the test's control.

import type { SaveEnvelope } from '@joystyk/contracts';
import type { Clock, SaveStore } from '@joystyk/session';
import type { FakeClock } from './clock.ts';

/** The runner's `Clock` port, driven by a fake clock: time moves only on `advance`. */
export const runnerClock = (fake: FakeClock): Clock => ({
  now: () => fake.now(),
  after: (ms, callback) => {
    const timer = fake.setTimeout(callback, ms);
    return () => timer.cancel();
  },
});

/** A runner `SaveStore` in memory, with what a test needs to inspect it. */
export interface MemorySaveStore extends SaveStore {
  /** What the slot holds: a JSON copy of the last write since the last `clear`, or null. */
  slot(): SaveEnvelope | null;
  /** How many writes landed. */
  writes(): number;
  /** How many times the runner cleared the slot. */
  clears(): number;
}

/** An in-memory save slot, which the runner writes and clears as the launcher's does. */
export const createMemorySaveStore = (): MemorySaveStore => {
  let slot: SaveEnvelope | null = null;
  let writes = 0;
  let clears = 0;
  return {
    write: async (save) => {
      slot = JSON.parse(JSON.stringify(save)) as SaveEnvelope;
      writes += 1;
    },
    clear: async () => {
      slot = null;
      clears += 1;
    },
    slot: () => slot,
    writes: () => writes,
    clears: () => clears,
  };
};
