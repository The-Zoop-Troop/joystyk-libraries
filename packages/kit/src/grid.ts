// Small rectangular-grid utilities for puzzles (Minesweeper, Nonogram, Sudoku, 2048) and
// board games, and for Containment's region filling. A grid is JSON: its cells are one flat
// array in row-major order, so cell (x, y) is `cells[y * width + x]`. x grows to the
// right and y grows downward; (0, 0) is the top-left cell.

/** A cell position. */
export type Point = { readonly x: number; readonly y: number };

/** A grid's dimensions. Every helper that only needs the shape takes this. */
export type GridSize = { readonly width: number; readonly height: number };

/** A grid of cells, row-major. */
export type Grid<T> = GridSize & { readonly cells: readonly T[] };

/** 4 for edge neighbors only; 8 to include diagonals. */
export type Connectivity = 4 | 8;

const checkSize = (width: number, height: number): void => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`A grid needs non-negative integer dimensions, got ${width} × ${height}.`);
  }
};

/** A grid whose cells are `init(point)`, filled row by row. */
export const createGrid = <T>(width: number, height: number, init: (point: Point) => T): Grid<T> => {
  checkSize(width, height);
  const cells: T[] = [];
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) cells.push(init({ x, y }));
  return { width, height, cells };
};

/** A grid with every cell set to `value`. */
export const fillGrid = <T>(width: number, height: number, value: T): Grid<T> => createGrid(width, height, () => value);

/** True when `point` lies on the grid. */
export const inBounds = (size: GridSize, point: Point): boolean =>
  Number.isInteger(point.x) &&
  Number.isInteger(point.y) &&
  point.x >= 0 &&
  point.y >= 0 &&
  point.x < size.width &&
  point.y < size.height;

/** A point's index in `cells`. */
export const indexOf = (size: GridSize, point: Point): number => point.y * size.width + point.x;

/** The point at an index in `cells`. */
export const pointOf = (size: GridSize, index: number): Point => ({
  x: index % size.width,
  y: Math.floor(index / size.width),
});

/** The cell at `point`, or undefined off the grid. */
export const cellAt = <T>(grid: Grid<T>, point: Point): T | undefined =>
  inBounds(grid, point) ? grid.cells[indexOf(grid, point)] : undefined;

/** A copy of the grid with one cell replaced. Throws a `RangeError` off the grid. */
export const setCell = <T>(grid: Grid<T>, point: Point, value: T): Grid<T> => {
  if (!inBounds(grid, point))
    throw new RangeError(`(${point.x}, ${point.y}) is off the ${grid.width} × ${grid.height} grid.`);
  const cells = grid.cells.slice();
  cells[indexOf(grid, point)] = value;
  return { width: grid.width, height: grid.height, cells };
};

/** A grid of the same shape with each cell transformed. */
export const mapGrid = <T, U>(grid: Grid<T>, fn: (value: T, point: Point) => U): Grid<U> => ({
  width: grid.width,
  height: grid.height,
  cells: grid.cells.map((value, i) => fn(value, pointOf(grid, i))),
});

/** The grid's rows, top to bottom, for rendering or fixtures. */
export const rows = <T>(grid: Grid<T>): T[][] =>
  Array.from({ length: grid.height }, (_, y) => grid.cells.slice(y * grid.width, (y + 1) * grid.width));

/** Offsets in clockwise order from north. */
const ORTHOGONAL: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

const ALL_DIRECTIONS: readonly Point[] = [
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
];

/** The on-grid neighbors of `point`, clockwise from north: N, E, S, W. */
export const neighbors4 = (size: GridSize, point: Point): Point[] =>
  ORTHOGONAL.map((d) => ({ x: point.x + d.x, y: point.y + d.y })).filter((p) => inBounds(size, p));

/** The on-grid neighbors of `point` including diagonals, clockwise from north: N, NE, E, SE, S, SW, W, NW. */
export const neighbors8 = (size: GridSize, point: Point): Point[] =>
  ALL_DIRECTIONS.map((d) => ({ x: point.x + d.x, y: point.y + d.y })).filter((p) => inBounds(size, p));

/** Neighbors by connectivity. */
export const neighbors = (size: GridSize, point: Point, connectivity: Connectivity = 4): Point[] =>
  connectivity === 8 ? neighbors8(size, point) : neighbors4(size, point);

/**
 * Every cell reachable from `start` through passable cells, in breadth-first order
 * (`start` first). Empty when `start` is off the grid or not passable.
 */
export const floodFill = (
  size: GridSize,
  start: Point,
  passable: (point: Point) => boolean,
  connectivity: Connectivity = 4,
): Point[] => {
  if (!inBounds(size, start) || !passable(start)) return [];
  const seen = new Uint8Array(size.width * size.height);
  seen[indexOf(size, start)] = 1;
  const queue: Point[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    for (const next of neighbors(size, queue[head]!, connectivity)) {
      const i = indexOf(size, next);
      if (seen[i] === 0 && passable(next)) {
        seen[i] = 1;
        queue.push(next);
      }
    }
  }
  return queue;
};

/**
 * Labels the connected regions of passable cells. `labels[i]` is the region of cell `i`
 * (0, 1, …, numbered in cell order), or -1 for a cell that isn't passable. Containment uses
 * it to find the regions no atom can reach.
 */
export const regions = (
  size: GridSize,
  passable: (point: Point) => boolean,
  connectivity: Connectivity = 4,
): { labels: number[]; count: number } => {
  const labels = Array.from({ length: size.width * size.height }, () => -1);
  let count = 0;
  for (let i = 0; i < labels.length; i += 1) {
    if (labels[i] !== -1) continue;
    const point = pointOf(size, i);
    const region = floodFill(size, point, passable, connectivity);
    if (region.length === 0) continue;
    for (const p of region) labels[indexOf(size, p)] = count;
    count += 1;
  }
  return { labels, count };
};

/** Steps between two cells moving only along rows and columns. */
export const manhattan = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Steps between two cells when diagonal moves are allowed (a king's distance). */
export const chebyshev = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
