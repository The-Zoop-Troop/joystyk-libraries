// What the mounted Tally fixture observed. Kept apart from module.ts so the module stays a
// lazily loaded chunk while tests import the probe directly.
import type { Preferences } from '@joystyk/contracts';

export const tallyProbe = {
  mounts: 0,
  disposals: 0,
  /** Every preferences value the game received, first the current one. */
  preferences: [] as Preferences[],
  /** The `plays` counter read from the game's scoped storage at each mount. */
  plays: [] as number[],
  reset(): void {
    this.mounts = 0;
    this.disposals = 0;
    this.preferences = [];
    this.plays = [];
  },
};
