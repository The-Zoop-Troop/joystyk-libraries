// `@joystyk/kit`: pure, deterministic building blocks for game engines. Nothing here reads a
// clock, a global random source, the DOM, storage or the network; randomness always comes
// from an `Rng` argument (game-contract.md, "Randomness").
//
// Each module is also a subpath export: `@joystyk/kit/rng`, `/cards`, `/dice`, `/grid`,
// `/daily` and `/turn`.

export { murmur3, utf8 } from './hash.ts';
export {
  SFC32,
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
export * from './cards/index.ts';
export { allSame, faceCounts, hasStraight, mostOfAKind, rollDice, rollDie, sumDice } from './dice.ts';
export {
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
  type Connectivity,
  type Grid,
  type GridSize,
  type Point,
} from './grid.ts';
export { addDays, dailyId, dailyRng, dailySeed, dateOfDay, dayNumber, isIsoDate } from './daily.ts';
export { boundedSearch, type SearchVerdict } from './search.ts';
export { nextActiveSeat, seatAfter, seatsFrom } from './turn.ts';

export { markGuess, type SymbolMark } from './marks.ts';
