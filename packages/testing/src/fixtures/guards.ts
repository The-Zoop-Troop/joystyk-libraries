// Tiny type guards for the fixtures' schemas.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isInt = (value: unknown, min = -Infinity, max = Infinity): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max && !Object.is(value, -0);

export const isSeat = (value: unknown): value is number => isInt(value, 0, 7);

export const isSeatOrNull = (value: unknown): value is number | null => value === null || isSeat(value);

export const isArrayOf = <T>(value: unknown, item: (v: unknown) => v is T): value is T[] =>
  Array.isArray(value) && value.every((v) => item(v));

/** Placements and results shared by the fixtures' outcomes. */
export const rankPlaces = (
  scores: readonly number[],
  last: number | null = null,
): { seat: number; place: number; score: number }[] =>
  scores.map((score, seat) => ({
    seat,
    place: seat === last ? scores.length : 1 + scores.filter((other, s) => s !== last && other > score).length,
    score,
  }));
