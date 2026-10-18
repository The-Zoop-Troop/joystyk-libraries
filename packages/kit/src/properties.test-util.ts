// A tiny property-test harness for the kit's own tests. It draws cases from the kit's own
// seeded generator, so every run checks the same cases and a failure names the case index
// to replay. Hand-rolled rather than a library: the kit's tests need only this much.

import type { Rng } from '@joystyk/contracts';
import { createRng } from './rng.ts';

/**
 * Runs `check` on `runs` cases drawn by `generate` from a generator seeded with `seed`.
 * A failing case is rethrown with its index and value attached.
 */
export const forAll = <T>(
  seed: string,
  runs: number,
  generate: (rng: Rng) => T,
  check: (value: T, rng: Rng) => void,
): void => {
  const rng = createRng(seed);
  for (let i = 0; i < runs; i += 1) {
    const value = generate(rng);
    try {
      check(value, rng);
    } catch (error) {
      throw new Error(`Property "${seed}" failed on case ${i}: ${JSON.stringify(value)}`, { cause: error });
    }
  }
};

/** Pearson's chi-square statistic for observed counts against equal expected counts. */
export const chiSquareUniform = (observed: readonly number[]): number => {
  const total = observed.reduce((sum, n) => sum + n, 0);
  const expected = total / observed.length;
  return observed.reduce((sum, n) => sum + ((n - expected) * (n - expected)) / expected, 0);
};

/**
 * Upper critical values of the chi-square distribution at p = 0.001, by degrees of freedom.
 * A fair source exceeds them one time in a thousand; with fixed seeds the tests never flake.
 */
export const CHI_SQUARE_999: Readonly<Record<number, number>> = {
  1: 10.828,
  2: 13.816,
  3: 16.266,
  5: 20.515,
  9: 27.877,
  12: 32.909,
  23: 49.728,
  31: 61.098,
  51: 87.968,
};
