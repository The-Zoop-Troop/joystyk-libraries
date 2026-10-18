import { isJson } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import {
  cellAt,
  chebyshev,
  createGrid,
  fillGrid,
  floodFill,
  inBounds,
  indexOf,
  manhattan,
  mapGrid,
  neighbors,
  neighbors4,
  neighbors8,
  pointOf,
  regions,
  rows,
  setCell,
  type Grid,
} from './grid.ts';
import { forAll } from './properties.test-util.ts';

/** Parses rows of text ("#" wall, "." open) into a grid. */
const parse = (...lines: string[]): Grid<string> =>
  createGrid(lines[0]!.length, lines.length, ({ x, y }) => lines[y]![x]!);

describe('grid basics', () => {
  it('is JSON, row-major, top-left at (0, 0)', () => {
    const grid = createGrid(3, 2, ({ x, y }) => `${x},${y}`);
    expect(isJson(grid)).toBe(true);
    expect(grid.cells).toEqual(['0,0', '1,0', '2,0', '0,1', '1,1', '2,1']);
    expect(rows(grid)).toEqual([
      ['0,0', '1,0', '2,0'],
      ['0,1', '1,1', '2,1'],
    ]);
  });

  it('converts between points and indices', () => {
    forAll(
      'grid-index',
      200,
      (rng) => ({ width: rng.int(1, 20), height: rng.int(1, 20) }),
      (size, rng) => {
        const i = rng.int(0, size.width * size.height);
        expect(indexOf(size, pointOf(size, i))).toBe(i);
        expect(inBounds(size, pointOf(size, i))).toBe(true);
      },
    );
  });

  it('checks bounds', () => {
    const size = { width: 3, height: 2 };
    expect(
      [
        { x: 0, y: 0 },
        { x: 2, y: 1 },
        { x: 3, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 2 },
        { x: 0.5, y: 0 },
      ].map((p) => inBounds(size, p)),
    ).toEqual([true, true, false, false, false, false]);
  });

  it('reads, writes and maps cells without mutating', () => {
    const grid = fillGrid(2, 2, 0);
    const changed = setCell(grid, { x: 1, y: 0 }, 5);
    expect(grid.cells).toEqual([0, 0, 0, 0]);
    expect(changed.cells).toEqual([0, 5, 0, 0]);
    expect(cellAt(changed, { x: 1, y: 0 })).toBe(5);
    expect(cellAt(changed, { x: 2, y: 0 })).toBe(undefined);
    expect(mapGrid(changed, (v, p) => v + p.y).cells).toEqual([0, 5, 1, 1]);
    expect(() => setCell(grid, { x: 2, y: 2 }, 1)).toThrow(RangeError);
    expect(() => createGrid(-1, 2, () => 0)).toThrow(RangeError);
  });
});

describe('neighbors', () => {
  const size = { width: 3, height: 3 };

  it('lists edge neighbors clockwise from north, on the grid only', () => {
    expect(neighbors4(size, { x: 1, y: 1 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 1 },
    ]);
    expect(neighbors4(size, { x: 0, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
  });

  it('includes diagonals with 8-connectivity', () => {
    expect(neighbors8(size, { x: 1, y: 1 })).toHaveLength(8);
    expect(neighbors8(size, { x: 0, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    expect(neighbors(size, { x: 2, y: 2 }, 8)).toHaveLength(3);
    expect(neighbors(size, { x: 2, y: 2 })).toHaveLength(2);
  });

  it('measures distances', () => {
    expect(manhattan({ x: 0, y: 0 }, { x: 3, y: -4 })).toBe(7);
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: -4 })).toBe(4);
  });
});

describe('flood fill and regions', () => {
  const grid = parse(
    '..#..', //
    '..#..',
    '###..',
    '.#...',
  );
  const open = (p: { x: number; y: number }): boolean => cellAt(grid, p) === '.';

  it('fills the cells reachable from a start, breadth first', () => {
    const region = floodFill(grid, { x: 0, y: 0 }, open);
    expect(region[0]).toEqual({ x: 0, y: 0 });
    expect(region.map((p) => indexOf(grid, p)).sort((a, b) => a - b)).toEqual([0, 1, 5, 6]);
    expect(floodFill(grid, { x: 2, y: 0 }, open)).toEqual([]);
    expect(floodFill(grid, { x: 9, y: 9 }, open)).toEqual([]);
  });

  it('crosses diagonals only with 8-connectivity', () => {
    expect(floodFill(grid, { x: 0, y: 3 }, open)).toHaveLength(1);
    // (0,3) touches nothing open diagonally either: (1,2) is a wall.
    expect(floodFill(grid, { x: 0, y: 3 }, open, 8)).toHaveLength(1);
    expect(floodFill(grid, { x: 1, y: 1 }, open, 8)).toHaveLength(4);
  });

  it('labels every region in cell order', () => {
    const { labels, count } = regions(grid, open);
    expect(count).toBe(3);
    expect(rows({ ...grid, cells: labels })).toEqual([
      [0, 0, -1, 1, 1],
      [0, 0, -1, 1, 1],
      [-1, -1, -1, 1, 1],
      [2, -1, 1, 1, 1],
    ]);
  });

  it('agrees with flood fill on random grids', () => {
    forAll(
      'regions',
      100,
      (rng) => createGrid(rng.int(1, 12), rng.int(1, 12), () => rng.int(0, 3) > 0),
      (random) => {
        const passable = (p: { x: number; y: number }): boolean => cellAt(random, p) === true;
        for (const connectivity of [4, 8] as const) {
          const { labels } = regions(random, passable, connectivity);
          random.cells.forEach((cell, i) => {
            if (!cell) return expect(labels[i]).toBe(-1);
            const region = floodFill(random, pointOf(random, i), passable, connectivity);
            const same = labels.flatMap((l, j) => (l === labels[i] ? [j] : []));
            expect(region.map((p) => indexOf(random, p)).sort((a, b) => a - b)).toEqual(same);
          });
        }
      },
    );
  });
});
