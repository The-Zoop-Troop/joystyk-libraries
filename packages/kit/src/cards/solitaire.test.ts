import { expect, test } from 'vitest';
import { isAdjacent, isFree, makesThirteen, triangularCovers } from './solitaire.ts';
test('adjacency is symmetric, wraps only when requested, and never includes the same rank', () => {
  for (let a = 1; a <= 13; a += 1)
    for (let b = 1; b <= 13; b += 1) {
      expect(isAdjacent(a as 1, b as 1)).toBe(Math.abs(a - b) === 1 || Math.abs(a - b) === 12);
      expect(isAdjacent(a as 1, b as 1, false)).toBe(Math.abs(a - b) === 1);
    }
  expect(makesThirteen({ rank: 13, suit: 'S' })).toBe(true);
  expect(makesThirteen({ rank: 1, suit: 'S' }, { rank: 12, suit: 'H' })).toBe(true);
});
test('every triangular parent has precisely its two children; removal frees it only after both', () => {
  const graph = triangularCovers(7);
  expect(graph).toHaveLength(28);
  expect(graph[0]).toEqual([1, 2]);
  expect(graph[20]).toEqual([26, 27]);
  expect(graph.slice(21)).toEqual(Array.from({ length: 7 }, () => []));
  const cards: (number | null)[] = Array.from({ length: 28 }, (_, n) => n);
  expect(isFree(cards, graph, 14)).toBe(false);
  cards[19] = null;
  expect(isFree(cards, graph, 14)).toBe(false);
  cards[20] = null;
  expect(isFree(cards, graph, 14)).toBe(true);
  cards[14] = null;
  expect(isFree(cards, graph, 14)).toBe(false);
});
