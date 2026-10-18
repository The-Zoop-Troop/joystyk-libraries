// Dice rolled from the engine's `rng`, and the counting helpers dice games score with.
// A die shows 1 … sides.

import type { Rng } from '@joystyk/contracts';

const checkSides = (sides: number): void => {
  if (!Number.isSafeInteger(sides) || sides < 2) throw new RangeError(`A die needs at least 2 sides, got ${sides}.`);
};

/** One die, uniformly 1 … `sides` (six by default). */
export const rollDie = (rng: Rng, sides = 6): number => {
  checkSides(sides);
  return rng.int(1, sides + 1);
};

/** `count` dice, rolled in order. */
export const rollDice = (rng: Rng, count: number, sides = 6): number[] => {
  checkSides(sides);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new RangeError(`count must be a non-negative integer, got ${count}.`);
  return Array.from({ length: count }, () => rng.int(1, sides + 1));
};

/**
 * How many dice show each face: `faceCounts([2, 5, 5], 6)` is `[0, 1, 0, 0, 2, 0]`, where
 * index 0 counts ones. Throws a `RangeError` for a value that isn't a face.
 */
export const faceCounts = (dice: readonly number[], sides = 6): number[] => {
  checkSides(sides);
  const counts = Array.from({ length: sides }, () => 0);
  for (const value of dice) {
    if (!Number.isSafeInteger(value) || value < 1 || value > sides) {
      throw new RangeError(`${value} isn't a face of a ${sides}-sided die.`);
    }
    counts[value - 1]! += 1;
  }
  return counts;
};

/** The total of the dice. */
export const sumDice = (dice: readonly number[]): number => dice.reduce((sum, value) => sum + value, 0);

/** True when there are at least two dice and all show the same face, as doubles do. */
export const allSame = (dice: readonly number[]): boolean =>
  dice.length >= 2 && dice.every((value) => value === dice[0]);

/** The size of the largest group of equal faces: 3 for `[4, 4, 1, 4]`, 0 for no dice. */
export const mostOfAKind = (dice: readonly number[]): number => {
  const counts = new Map<number, number>();
  let most = 0;
  for (const value of dice) {
    const n = (counts.get(value) ?? 0) + 1;
    counts.set(value, n);
    most = Math.max(most, n);
  }
  return most;
};

/** True when the dice include every face from `low` to `high`: `hasStraight(dice, 1, 6)` for a six-die straight. */
export const hasStraight = (dice: readonly number[], low: number, high: number): boolean => {
  const present = new Set(dice);
  for (let face = low; face <= high; face += 1) if (!present.has(face)) return false;
  return true;
};
