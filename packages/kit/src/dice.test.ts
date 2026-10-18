import { describe, expect, it } from 'vitest';
import { allSame, faceCounts, hasStraight, mostOfAKind, rollDice, rollDie, sumDice } from './dice.ts';
import { CHI_SQUARE_999, chiSquareUniform, forAll } from './properties.test-util.ts';
import { createRng } from './rng.ts';

describe('rolling', () => {
  it('rolls faces from 1 to sides', () => {
    forAll(
      'dice-bounds',
      200,
      (rng) => ({ count: rng.int(0, 10), sides: [2, 4, 6, 8, 10, 12, 20][rng.int(0, 7)]! }),
      ({ count, sides }, rng) => {
        const dice = rollDice(rng, count, sides);
        expect(dice).toHaveLength(count);
        expect(dice.every((d) => Number.isInteger(d) && d >= 1 && d <= sides)).toBe(true);
      },
    );
  });

  it('rolls a fair six-sided die', () => {
    const rng = createRng('fair-die');
    const counts = faceCounts(Array.from({ length: 12000 }, () => rollDie(rng)));
    expect(chiSquareUniform(counts)).toBeLessThan(CHI_SQUARE_999[5]!);
  });

  it('rolls doubles on two dice one time in six', () => {
    const rng = createRng('doubles');
    let doubles = 0;
    for (let i = 0; i < 30000; i += 1) if (allSame(rollDice(rng, 2))) doubles += 1;
    expect(Math.abs(doubles / 30000 - 1 / 6)).toBeLessThan(0.01);
  });

  it('rolls the same dice from the same seed', () => {
    expect(rollDice(createRng('same'), 20)).toEqual(rollDice(createRng('same'), 20));
  });

  it('rejects bad dice', () => {
    const rng = createRng('bad');
    expect(() => rollDie(rng, 1)).toThrow(RangeError);
    expect(() => rollDice(rng, -1)).toThrow(RangeError);
  });
});

describe('counting', () => {
  it('counts faces', () => {
    expect(faceCounts([2, 5, 5], 6)).toEqual([0, 1, 0, 0, 2, 0]);
    expect(() => faceCounts([7], 6)).toThrow(RangeError);
  });

  it('sums, matches and finds straights', () => {
    expect(sumDice([3, 4, 6])).toBe(13);
    expect(allSame([4, 4])).toBe(true);
    expect(allSame([4])).toBe(false);
    expect(allSame([4, 5])).toBe(false);
    expect(mostOfAKind([4, 4, 1, 4])).toBe(3);
    expect(mostOfAKind([])).toBe(0);
    expect(hasStraight([6, 2, 3, 1, 5, 4], 1, 6)).toBe(true);
    expect(hasStraight([6, 2, 3, 1, 5, 5], 1, 6)).toBe(false);
  });
});
