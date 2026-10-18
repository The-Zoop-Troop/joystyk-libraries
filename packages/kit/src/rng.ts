// The seeded random source behind the contract's `Rng`, and helpers that draw from any `Rng`.
//
// Algorithm: SFC32, Chris Doty-Humphrey's "small fast chaotic" generator from PractRand.
// - It passes PractRand and TestU01's BigCrush.
// - Its state is four 32-bit words, so `RngState` is four small JSON numbers.
// - One step is three additions, a xor, two shifts and a rotation, all on 32-bit integers.
//   JavaScript computes those exactly in every engine, so a seed gives the same stream in
//   Node, Chromium, Firefox and Safari. There is no floating-point step to drift.
// - The fourth word is a counter, so no seed falls into a short cycle: every stream is at
//   least 2^32 outputs long, and about 2^127 on average.
// It is not cryptographic. That is fine: the state never leaves the authority, and a
// client that can't see it can't predict a shuffle (game-contract.md, "Randomness").

import type { Rng, RngState } from '@joystyk/contracts';
import { murmur3 } from './hash.ts';

/** The algorithm name stored in `RngState.algorithm`. */
export const SFC32 = 'sfc32';

const TWO_26 = 67108864;
const TWO_32 = 4294967296;
const TWO_53 = 9007199254740992;

/** Steps discarded after seeding, as PractRand's reference seeding does. */
const WARM_UP = 12;

class Sfc32 implements Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(words: readonly number[]) {
    this.#a = words[0]! | 0;
    this.#b = words[1]! | 0;
    this.#c = words[2]! | 0;
    this.#d = words[3]! | 0;
  }

  /** One SFC32 step: a uniform unsigned 32-bit integer. */
  u32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** A uniform integer in [0, 2^53), from two steps. */
  #u53(): number {
    return (this.u32() >>> 5) * TWO_26 + (this.u32() >>> 6);
  }

  /** A uniform float in [0, 1) with 53 bits of precision: every double k / 2^53 is equally likely. */
  next(): number {
    return this.#u53() / TWO_53;
  }

  /**
   * A uniform integer in [min, max). Rejection sampling removes modulo bias: a draw from
   * the top, incomplete copy of the range is thrown away and drawn again. Ranges up to 2^32
   * use one step per draw; larger ranges, up to 2^53, use two.
   */
  int(min: number, max: number): number {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min) {
      throw new RangeError(`rng.int(${min}, ${max}) needs safe integers with min < max.`);
    }
    const range = max - min;
    if (range > TWO_53) {
      throw new RangeError(`rng.int(${min}, ${max}) spans more than 2^53 values.`);
    }
    if (range <= TWO_32) {
      const limit = TWO_32 - (TWO_32 % range);
      let u = this.u32();
      while (u >= limit) u = this.u32();
      return min + (u % range);
    }
    const limit = TWO_53 - (TWO_53 % range);
    let u = this.#u53();
    while (u >= limit) u = this.#u53();
    return min + (u % range);
  }

  /**
   * Fisher–Yates into a new array. It walks from the last index down to 1 and swaps each
   * position with `int(0, i + 1)`. The order of draws is part of the golden fixtures, so it
   * never changes.
   */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i + 1);
      const swap = out[i]!;
      out[i] = out[j]!;
      out[j] = swap;
    }
    return out;
  }

  save(): RngState {
    return { algorithm: SFC32, words: [this.#a >>> 0, this.#b >>> 0, this.#c >>> 0, this.#d >>> 0] };
  }
}

const isWord = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < TWO_32 && !Object.is(value, -0);

/** True when `value` is an SFC32 state this kit can restore: four unsigned 32-bit integers. */
export const isRngState = (value: unknown): value is RngState => {
  if (typeof value !== 'object' || value === null) return false;
  const { algorithm, words } = value as { algorithm?: unknown; words?: unknown };
  return algorithm === SFC32 && Array.isArray(words) && words.length === 4 && words.every(isWord);
};

/**
 * Rebuilds a generator from a saved state. The restored generator continues exactly where
 * the saved one stopped. Throws a `RangeError` for a state this kit didn't produce; parse
 * stored states with `isRngState` first.
 */
export const restoreRng = (state: RngState): Rng => {
  if (!isRngState(state)) {
    throw new RangeError(`Not an ${SFC32} state: ${JSON.stringify(state)}.`);
  }
  return new Sfc32(state.words);
};

/**
 * The state for a seed string. Each of the four words is MurmurHash3 (x86, 32-bit) of the
 * seed's UTF-8 bytes, with hash seeds 0, 1, 2 and 3; the generator then discards its first
 * 12 outputs. The same string gives the same state forever: it is part of the save format.
 */
export const seedState = (seed: string): RngState => {
  const rng = new Sfc32([murmur3(seed, 0), murmur3(seed, 1), murmur3(seed, 2), murmur3(seed, 3)]);
  for (let i = 0; i < WARM_UP; i += 1) rng.u32();
  return rng.save();
};

/** A generator seeded from a string, such as a daily id. Same string, same stream. */
export const createRng = (seed: string): Rng => restoreRng(seedState(seed));

/**
 * The state for a seed built from parts, joined with ":". `seedFromParts(['klondike',
 * 'draw-3', 42])` hashes `"klondike:draw-3:42"`. String parts may not contain ":", so two
 * different part lists never produce the same string; number parts must be safe integers.
 */
export const seedFromParts = (parts: readonly (string | number)[]): RngState => {
  for (const part of parts) {
    if (typeof part === 'string' ? part.includes(':') : !Number.isSafeInteger(part)) {
      throw new RangeError(`Seed part ${JSON.stringify(part)} must be a string without ":" or a safe integer.`);
    }
  }
  return seedState(parts.map(String).join(':'));
};

/**
 * The state for a numbered deal of a game variant: `dealSeed('klondike', 'draw-3', 42)`. The
 * same deal number gives the same deal on every device, so players can share deal numbers.
 */
export const dealSeed = (gameId: string, variant: string, dealNumber: number): RngState =>
  seedFromParts([gameId, variant, dealNumber]);

/**
 * A new, independent generator seeded from four 32-bit draws of `rng`. Use it to hand a
 * sub-task its own stream (an AI search, a puzzle generator) while the parent advances by a
 * fixed amount, however many numbers the sub-task draws.
 */
export const forkRng = (rng: Rng): Rng => {
  const child = new Sfc32([rng.int(0, TWO_32), rng.int(0, TWO_32), rng.int(0, TWO_32), rng.int(0, TWO_32)]);
  for (let i = 0; i < WARM_UP; i += 1) child.u32();
  return child;
};

/** One item, uniformly. Throws a `RangeError` for an empty list. */
export const pick = <T>(rng: Rng, items: readonly T[]): T => {
  if (items.length === 0) throw new RangeError('pick needs at least one item.');
  return items[rng.int(0, items.length)]!;
};

/**
 * One item, with probability proportional to its weight. Weights are non-negative safe
 * integers, so the choice is exact: weights 1 and 2 give exactly 1/3 and 2/3. Scale
 * fractional weights to integers first. Throws a `RangeError` when no item has weight.
 */
export const weightedPick = <T>(rng: Rng, items: readonly T[], weightOf: (item: T, index: number) => number): T => {
  const weights = items.map(weightOf);
  let total = 0;
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError(`weightedPick weights must be non-negative safe integers, got ${weight}.`);
    }
    total += weight;
  }
  if (total === 0 || !Number.isSafeInteger(total)) {
    throw new RangeError('weightedPick needs a positive total weight below 2^53.');
  }
  let ticket = rng.int(0, total);
  for (let i = 0; i < items.length; i += 1) {
    ticket -= weights[i]!;
    if (ticket < 0) return items[i]!;
  }
  throw new RangeError('unreachable');
};

/**
 * `count` distinct items in random order, by a partial Fisher–Yates: the first `count`
 * swaps of a shuffle that walks from the front. Throws a `RangeError` when `count` exceeds
 * the list.
 */
export const sample = <T>(rng: Rng, items: readonly T[], count: number): T[] => {
  if (!Number.isSafeInteger(count) || count < 0 || count > items.length) {
    throw new RangeError(`sample needs 0 <= count <= ${items.length}, got ${count}.`);
  }
  const pool = items.slice();
  for (let i = 0; i < count; i += 1) {
    const j = rng.int(i, pool.length);
    const swap = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = swap;
  }
  return pool.slice(0, count);
};

/** True with probability exactly `numerator / denominator`, e.g. `chance(rng, 1, 6)`. */
export const chance = (rng: Rng, numerator: number, denominator: number): boolean =>
  rng.int(0, denominator) < numerator;
