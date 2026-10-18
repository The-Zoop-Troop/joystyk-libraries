import { isJson, type Rng } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { RAW_STEPS, SEEDS, SHUFFLES } from './known-answers.test-util.ts';
import { CHI_SQUARE_999, chiSquareUniform, forAll } from './properties.test-util.ts';
import {
  chance,
  createRng,
  dealSeed,
  forkRng,
  isRngState,
  pick,
  restoreRng,
  sample,
  seedFromParts,
  seedState,
  weightedPick,
} from './rng.ts';

const TWO_32 = 2 ** 32;
const u32s = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.int(0, TWO_32));

// Known answers, produced independently by C reference code (see known-answers.test-util.ts).
// rng.browser.test.ts checks the same vectors in Chromium.
describe('known answers', () => {
  it.each(RAW_STEPS)('steps SFC32 from the raw state $state.words', ({ state, outputs, after }) => {
    const rng = restoreRng(state);
    expect(u32s(rng, outputs.length)).toEqual(outputs);
    expect(rng.save()).toEqual(after);
  });

  it('steps SFC32 from the all-zero state, which the counter keeps moving', () => {
    const rng = restoreRng({ algorithm: 'sfc32', words: [0, 0, 0, 0] });
    expect(u32s(rng, 5)).toEqual([0, 1, 2, 12, 18874399]);
  });

  it.each(SEEDS)('seeds from the string $seed', ({ seed, words, outputs }) => {
    expect(seedState(seed)).toEqual({ algorithm: 'sfc32', words });
    expect(u32s(createRng(seed), outputs.length)).toEqual(outputs);
  });

  it.each(SHUFFLES)(
    'shuffles $size items, then draws floats and dice, from $seed',
    ({ seed, size, shuffled, floats, dice }) => {
      const rng = createRng(seed);
      expect(rng.shuffle(Array.from({ length: size }, (_, i) => i))).toEqual(shuffled);
      expect(floats.map(() => rng.next())).toEqual(floats);
      expect(dice.map(() => rng.int(1, 7))).toEqual(dice);
    },
  );
});

describe('state', () => {
  it('is JSON and survives a round trip', () => {
    const rng = createRng('state');
    rng.shuffle([1, 2, 3]);
    const state = rng.save();
    expect(isJson(state)).toBe(true);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(isRngState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it('restores to continue exactly where it stopped', () => {
    forAll(
      'restore',
      50,
      (rng) => ({ seed: String(rng.int(0, 1e9)), skip: rng.int(0, 200) }),
      ({ seed, skip }) => {
        const a = createRng(seed);
        u32s(a, skip);
        const b = restoreRng(JSON.parse(JSON.stringify(a.save())));
        expect(u32s(b, 20)).toEqual(u32s(a, 20));
      },
    );
  });

  it('rejects states it did not produce', () => {
    for (const bad of [
      null,
      { algorithm: 'xoshiro128**', words: [1, 2, 3, 4] },
      { algorithm: 'sfc32', words: [1, 2, 3] },
      { algorithm: 'sfc32', words: [1, 2, 3, -1] },
      { algorithm: 'sfc32', words: [1, 2, 3, 2 ** 32] },
      { algorithm: 'sfc32', words: [1, 2, 3, 0.5] },
      { algorithm: 'sfc32', words: [1, 2, 3, -0] },
    ]) {
      expect(isRngState(bad)).toBe(false);
    }
    expect(() => restoreRng({ algorithm: 'sfc32', words: [1] })).toThrow(RangeError);
  });

  it('keeps every word an unsigned 32-bit integer', () => {
    const rng = createRng('words');
    for (let i = 0; i < 1000; i += 1) {
      rng.next();
      expect(isRngState(rng.save())).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('gives the same stream for the same seed, and a different one for another seed', () => {
    forAll(
      'determinism',
      50,
      (rng) => String(rng.int(0, 1e9)),
      (seed) => {
        const items = Array.from({ length: 30 }, (_, i) => i);
        const run = (s: string) => {
          const rng = createRng(s);
          return [rng.next(), rng.int(-5, 5), rng.shuffle(items), rng.int(0, 2 ** 40), rng.save()];
        };
        expect(run(seed)).toEqual(run(seed));
        expect(run(seed)).not.toEqual(run(`${seed}x`));
      },
    );
  });
});

describe('next', () => {
  it('stays in [0, 1) and averages one half', () => {
    const rng = createRng('next');
    let sum = 0;
    for (let i = 0; i < 20000; i += 1) {
      const x = rng.next();
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
    }
    expect(Math.abs(sum / 20000 - 0.5)).toBeLessThan(0.01);
  });
});

describe('int', () => {
  it('stays within [min, max) for any range', () => {
    forAll(
      'int-bounds',
      500,
      (rng) => {
        const min = rng.int(-1e6, 1e6);
        const span = [1, 2, 3, rng.int(1, 100), rng.int(1, 2 ** 31), 2 ** 32, 2 ** 32 + 1, rng.int(1, 2 ** 52)][
          rng.int(0, 8)
        ]!;
        return { min, max: min + span };
      },
      ({ min, max }, rng) => {
        for (let i = 0; i < 20; i += 1) {
          const n = rng.int(min, max);
          expect(Number.isSafeInteger(n) && n >= min && n < max).toBe(true);
          expect(Object.is(n, -0)).toBe(false);
        }
      },
    );
  });

  it('returns min for a range of one', () => {
    expect(createRng('one').int(7, 8)).toBe(7);
  });

  it('removes modulo bias by rejection', () => {
    // For a range of 3 · 2^30, plain `u32 % range` would land below 2^30 half the time,
    // because the top quarter of the 32-bit space wraps onto it. Rejection gives one third.
    const rng = createRng('bias');
    const range = 3 * 2 ** 30;
    const n = 30000;
    let low = 0;
    for (let i = 0; i < n; i += 1) if (rng.int(0, range) < 2 ** 30) low += 1;
    expect(Math.abs(low / n - 1 / 3)).toBeLessThan(0.015);
  });

  it('is uniform over small ranges', () => {
    const rng = createRng('uniform-int');
    for (const range of [2, 3, 6, 10, 13]) {
      const counts = Array.from({ length: range }, () => 0);
      for (let i = 0; i < range * 2000; i += 1) counts[rng.int(0, range)]! += 1;
      const df = range - 1;
      const critical = CHI_SQUARE_999[df] ?? 0;
      if (critical > 0) expect(chiSquareUniform(counts)).toBeLessThan(critical);
    }
  });

  it('is uniform over a range wider than 2^32', () => {
    const rng = createRng('wide');
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 8000; i += 1) counts[Math.floor(rng.int(0, 2 ** 40) / 2 ** 38)]! += 1;
    expect(chiSquareUniform(counts)).toBeLessThan(CHI_SQUARE_999[3]!);
  });

  it('throws for bad arguments without advancing the state', () => {
    const rng = createRng('bad');
    const before = rng.save();
    for (const [min, max] of [
      [0, 0],
      [5, 1],
      [0, 1.5],
      [Number.NaN, 3],
      [0, Infinity],
      [-(2 ** 53 - 1), 2 ** 53 - 1],
    ] as const) {
      expect(() => rng.int(min, max)).toThrow(RangeError);
    }
    expect(rng.save()).toEqual(before);
  });
});

describe('shuffle', () => {
  it('returns a new array holding the same items', () => {
    forAll(
      'shuffle-permutation',
      100,
      (rng) => Array.from({ length: rng.int(0, 60) }, () => rng.int(0, 10)),
      (items, rng) => {
        const frozen = Object.freeze(items.slice());
        const shuffled = rng.shuffle(frozen);
        expect(shuffled).not.toBe(frozen);
        expect(shuffled.slice().sort()).toEqual(frozen.slice().sort());
      },
    );
  });

  it('makes all 24 orders of four items equally likely (chi-square, fixed seed)', () => {
    const rng = createRng('shuffle-uniformity');
    const counts = new Map<string, number>();
    const n = 48000;
    for (let i = 0; i < n; i += 1) {
      const key = rng.shuffle(['a', 'b', 'c', 'd']).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(24);
    expect(chiSquareUniform([...counts.values()])).toBeLessThan(CHI_SQUARE_999[23]!);
  });

  it('puts every card of a 52-card deck on top equally often', () => {
    const rng = createRng('shuffle-top');
    const deck = Array.from({ length: 52 }, (_, i) => i);
    const counts = Array.from({ length: 52 }, () => 0);
    for (let i = 0; i < 52 * 400; i += 1) counts[rng.shuffle(deck)[0]!]! += 1;
    expect(chiSquareUniform(counts)).toBeLessThan(CHI_SQUARE_999[51]!);
  });
});

describe('helpers', () => {
  it('pick chooses each item equally often', () => {
    const rng = createRng('pick');
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 12000; i += 1) counts[pick(rng, [0, 1, 2, 3, 4, 5])]! += 1;
    expect(chiSquareUniform(counts)).toBeLessThan(CHI_SQUARE_999[5]!);
    expect(() => pick(rng, [])).toThrow(RangeError);
  });

  it('weightedPick follows integer weights exactly, skipping zero weights', () => {
    const rng = createRng('weighted');
    const counts = { a: 0, b: 0, c: 0 };
    const n = 30000;
    for (let i = 0; i < n; i += 1) {
      counts[weightedPick(rng, ['a', 'b', 'c'] as const, (item) => ({ a: 1, b: 0, c: 2 })[item])] += 1;
    }
    expect(counts.b).toBe(0);
    expect(Math.abs(counts.a / n - 1 / 3)).toBeLessThan(0.015);
    expect(() => weightedPick(rng, ['a'], () => 0)).toThrow(RangeError);
    expect(() => weightedPick(rng, ['a'], () => 0.5)).toThrow(RangeError);
    expect(() => weightedPick(rng, ['a'], () => -1)).toThrow(RangeError);
  });

  it('sample returns distinct items from the list', () => {
    forAll(
      'sample',
      100,
      (rng) => {
        const size = rng.int(0, 30);
        return { size, count: rng.int(0, size + 1) };
      },
      ({ size, count }, rng) => {
        const items = Array.from({ length: size }, (_, i) => i);
        const chosen = sample(rng, items, count);
        expect(chosen).toHaveLength(count);
        expect(new Set(chosen).size).toBe(count);
        expect(chosen.every((x) => x >= 0 && x < size)).toBe(true);
      },
    );
    expect(() => sample(createRng('x'), [1, 2], 3)).toThrow(RangeError);
  });

  it('chance is true with the given probability', () => {
    const rng = createRng('chance');
    let hits = 0;
    for (let i = 0; i < 30000; i += 1) if (chance(rng, 1, 6)) hits += 1;
    expect(Math.abs(hits / 30000 - 1 / 6)).toBeLessThan(0.01);
  });

  it('forkRng advances the parent by exactly four draws', () => {
    const parent = createRng('fork');
    const twin = restoreRng(parent.save());
    const child = forkRng(parent);
    u32s(child, 100);
    u32s(twin, 4);
    expect(parent.save()).toEqual(twin.save());
    expect(u32s(child, 5)).not.toEqual(u32s(parent, 5));
  });
});

describe('seeds', () => {
  it('builds a seed from parts joined with ":"', () => {
    expect(seedFromParts(['klondike', 'draw-3', 42])).toEqual(seedState('klondike:draw-3:42'));
    expect(dealSeed('klondike', 'draw-3', 42)).toEqual(seedState('klondike:draw-3:42'));
  });

  it('rejects parts that would make two part lists collide', () => {
    expect(() => seedFromParts(['a:b', 'c'])).toThrow(RangeError);
    expect(() => seedFromParts(['a', 1.5])).toThrow(RangeError);
  });

  it('gives different deals different states', () => {
    const states = new Set<string>();
    for (let deal = 0; deal < 1000; deal += 1) states.add(JSON.stringify(dealSeed('freecell', 'classic', deal)));
    expect(states.size).toBe(1000);
  });
});
