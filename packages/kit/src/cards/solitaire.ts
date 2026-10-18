import type { Rank, SuitedFace } from './card.ts';

/** Consecutive ranks, optionally joining king and ace. Suits have no bearing. */
export const isAdjacent = (a: SuitedFace | Rank, b: SuitedFace | Rank, wrap = true): boolean => {
  const ar = typeof a === 'number' ? a : a.rank;
  const br = typeof b === 'number' ? b : b.rank;
  return Math.abs(ar - br) === 1 || (wrap && Math.abs(ar - br) === 12);
};

/** Ace 1, jack 11, queen 12, king 13, for thirteen-pair solitaires. */
export const pyramidValue = (card: SuitedFace): number => card.rank;
export const makesThirteen = (a: SuitedFace, b?: SuitedFace): boolean => a.rank + (b?.rank ?? 0) === 13;

/** A layout's covering graph. An empty slot no longer covers the cards above it. */
export const isFree = <T>(
  cards: readonly (T | null)[],
  covers: readonly (readonly number[])[],
  index: number,
): boolean =>
  cards[index] !== undefined && cards[index] !== null && (covers[index] ?? []).every((n) => cards[n] === null);

/** Triangular rows, in reading order. The final row has no covering cards. */
export const triangularCovers = (rows: number): readonly (readonly number[])[] =>
  Array.from({ length: (rows * (rows + 1)) / 2 }, (_, i) => {
    let row = 0;
    while (((row + 1) * (row + 2)) / 2 <= i) row += 1;
    return row === rows - 1 ? [] : [i + row + 1, i + row + 2];
  });
