// Known-answer vectors for the seeded generator, shared by the Node tests (rng.test.ts) and
// the Chromium tests (rng.browser.test.ts), so both engines check the same numbers.
//
// Every vector was produced independently by C reference code compiled with gcc:
// PractRand's sfc32 `raw32` and smhasher's `MurmurHash3_x86_32`, seeded the way
// `seedState` documents, with rejection sampling and Fisher–Yates written out in C. They
// pin the algorithm, not just this implementation's past output. Never edit them: saves,
// replays, deal numbers and daily puzzles depend on these exact streams.

import type { RngState } from '@joystyk/contracts';

/** Raw SFC32 steps from a given state: the first ten `int(0, 2^32)` outputs and the state after. */
export const RAW_STEPS: readonly { state: RngState; outputs: readonly number[]; after: RngState }[] = [
  {
    state: { algorithm: 'sfc32', words: [1, 2, 3, 4] },
    outputs: [7, 34, 56623200, 188882296, 3431242869, 399395954, 785775158, 3843710725, 2124393435, 4040705074],
    after: { algorithm: 'sfc32', words: [2067905029, 4109138475, 2739295667, 14] },
  },
];

/** Seed strings, their states after seeding, and the next eight `int(0, 2^32)` outputs. */
export const SEEDS: readonly { seed: string; words: readonly number[]; outputs: readonly number[] }[] = [
  {
    seed: 'joystyk',
    words: [2162358500, 684222655, 2270343989, 3585253940],
    outputs: [2136867799, 3229023133, 2915154630, 2752604219, 3538120443, 1155291516, 1185434114, 4169296260],
  },
  {
    seed: 'klondike:2026-10-08',
    words: [797581415, 3791915302, 4058552180, 2589139019],
    outputs: [2883668440, 4260724354, 2319230020, 3190744629, 1837178423, 1884534703, 2315901822, 1770369872],
  },
  {
    seed: '',
    words: [3203026661, 183085155, 1484677167, 2247144499],
    outputs: [1338289019, 2907632274, 2778571467, 1361290428, 3138870750, 234156838, 2542421742, 3447388034],
  },
];

/**
 * From a fresh `createRng(seed)`: `shuffle` of 0 … size − 1, then three `next()` floats,
 * then ten `int(1, 7)` die rolls.
 */
export const SHUFFLES: readonly {
  seed: string;
  size: number;
  shuffled: readonly number[];
  floats: readonly number[];
  dice: readonly number[];
}[] = [
  {
    seed: 'joystyk',
    size: 10,
    shuffled: [4, 5, 0, 2, 7, 3, 8, 6, 1, 9],
    floats: [0.67255763264384527, 0.83105195186181813, 0.078330483310258936],
    dice: [2, 2, 5, 6, 2, 5, 4, 1, 4, 3],
  },
  {
    seed: 'deck',
    size: 52,
    shuffled: [
      20, 8, 34, 10, 0, 2, 6, 45, 21, 51, 49, 12, 15, 33, 30, 44, 27, 38, 35, 42, 48, 39, 28, 43, 11, 26, 41, 37, 17,
      19, 31, 13, 14, 1, 36, 5, 25, 18, 23, 16, 7, 47, 24, 50, 32, 3, 40, 4, 22, 29, 46, 9,
    ],
    floats: [0.81950907785416849, 0.27474748422298723, 0.31635025145265983],
    dice: [3, 1, 3, 2, 3, 4, 6, 4, 2, 3],
  },
];
