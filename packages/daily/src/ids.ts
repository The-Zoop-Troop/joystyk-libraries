// Daily puzzle ids: `<game>:<yyyy-mm-dd>`, built by the kit's `dailyId` (offline-and-updates.md).

import { isGameId } from '@joystyk/contracts';
import { dailyId, isIsoDate } from '@joystyk/kit';

/** A parsed daily puzzle id. */
export type PuzzleRef = {
  readonly gameId: string;
  /** The puzzle's own calendar date, `yyyy-mm-dd`. */
  readonly date: string;
};

/**
 * The daily puzzle id `<game>:<yyyy-mm-dd>`, e.g. "daily-word:2026-10-08". Throws a
 * `RangeError` for a game id that isn't kebab-case or a date that isn't real.
 */
export const puzzleId = (gameId: string, date: string): string => dailyId(gameId, date);

/** Splits a daily puzzle id into its game and date, or returns null when it isn't one. */
export const parsePuzzleId = (id: string): PuzzleRef | null => {
  const at = id.lastIndexOf(':');
  if (at < 0) return null;
  const gameId = id.slice(0, at);
  const date = id.slice(at + 1);
  return isGameId(gameId) && isIsoDate(date) ? { gameId, date } : null;
};

/** True for a well-formed daily puzzle id. */
export const isPuzzleId = (value: unknown): value is string =>
  typeof value === 'string' && parsePuzzleId(value) !== null;
