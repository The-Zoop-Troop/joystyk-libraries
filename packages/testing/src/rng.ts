// Deterministic random sources for tests, built on the kit's seeded generator.

import type { Rng, RngState } from '@joystyk/contracts';
import { restoreRng, seedState } from '@joystyk/kit';

/** Every test seed is namespaced, so a test seed never equals a production deal or daily seed. */
const PREFIX = 'joystyk-test';

/**
 * The seed state for a test. `testSeed('nim', 3)` hashes `"joystyk-test/nim/3"`. The same
 * parts give the same state on every machine and in every run.
 */
export const testSeed = (...parts: readonly (string | number)[]): RngState =>
  seedState([PREFIX, ...parts.map(String)].join('/'));

/**
 * A seeded generator for a test, from the kit's SFC32. Pass the same parts to get the same
 * stream again, for example to reproduce a failure the suites report.
 */
export const testRng = (...parts: readonly (string | number)[]): Rng => restoreRng(testSeed(...parts));

/** `count` distinct, reproducible seed states derived from `base`. */
export const testSeeds = (base: string, count: number): RngState[] =>
  Array.from({ length: count }, (_, i) => testSeed(base, i));

/**
 * An independent copy of `rng` at its current position. Drawing from the copy leaves `rng`
 * untouched, which is how the suites try an input without consuming randomness.
 */
export const cloneRng = (rng: Rng): Rng => restoreRng(rng.save());
