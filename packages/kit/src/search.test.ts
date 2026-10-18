import { expect, test } from 'vitest';
import { boundedSearch } from './search.ts';
test('a bounded search distinguishes proof, exhausted impossibility and a budget stop', () => {
  const spec = {
    key: (n: number) => String(n),
    won: (n: number) => n === 4,
    next: (n: number) =>
      n < 4
        ? [
            { state: n + 1, move: n + 1 },
            { state: n, move: n },
          ]
        : [],
    budget: 10,
  };
  expect(boundedSearch(0, spec)).toEqual({ verdict: 'winnable', path: [1, 2, 3, 4], nodes: 4 });
  expect(boundedSearch(0, { ...spec, budget: 2 }).verdict).toBe('unproven');
  expect(boundedSearch(0, { ...spec, won: () => false }).verdict).toBe('unwinnable');
});
test('long proofs use an explicit stack and depth limits can revisit shallower paths', () => {
  const long = boundedSearch<number, number>(0, {
    key: String,
    won: (n) => n === 12_000,
    next: (n) => [{ state: n + 1, move: n + 1 }],
    budget: 12_001,
  });
  expect(long.verdict).toBe('winnable');
  expect(long.path).toHaveLength(12_000);
  const bounded = {
    key: String,
    won: (n: number) => n === 4,
    next: (n: number) =>
      n === 0
        ? [
            { state: 1, move: 1 },
            { state: 3, move: 3 },
          ]
        : n < 4
          ? [{ state: n + 1, move: n + 1 }]
          : [],
    budget: 20,
    maxDepth: 2,
  };
  expect(boundedSearch(0, bounded)).toMatchObject({ verdict: 'winnable', path: [3, 4] });
  expect(
    boundedSearch<number, number>(0, { ...bounded, next: (n) => (n < 4 ? [{ state: n + 1, move: n + 1 }] : []) })
      .verdict,
  ).toBe('unproven');
});
