// The results store: one `DailyResult` per puzzle id and variant, and the streaks computed
// from them, kept through the storage package (content-pipeline.md, "Results and streaks").
//
// Where things live:
// - results: the `game-data` store, `<playerId>/~daily/<game>/<date>/<variant or ->`. A game's
//   own keys there are `<playerId>/<game>/…`, and a game id never starts with `~`, so the two
//   never meet;
// - the days-finished streak: the player's `StreakStore`, under the game id;
// - the win streak: the `streaks` store, `<playerId>/<game>/win`, in the same record shape.
// The streak records are a summary for the frame and for v2 sync ("max wins"); the results
// stay the source of truth, and a stored best only ever grows.

import { isGameId, ok, type Result } from '@joystyk/contracts';
import {
  defineRecordKind,
  EMPTY_STREAK,
  STREAK_RECORD,
  type RecordStore,
  type Storage,
  type StorageError,
  type Streak,
} from '@joystyk/storage';
import { parsePuzzleId } from '../ids.ts';
import { dailyResult, type DailyResult } from '../schemas.ts';
import { streaks as computeStreaks, type Streaks } from '../streaks.ts';

/** Version 1 of a stored daily result. */
export const DAILY_RESULT_RECORD = defineRecordKind<DailyResult>({
  store: 'game-data',
  version: 1,
  schema: dailyResult,
  label: 'daily result',
});

/** What `record` did. */
export type Recorded = {
  /** The result now stored: the new one, or the earlier one when this puzzle was already finished. */
  readonly result: DailyResult;
  /** False when a result for this puzzle and variant already existed; it is kept as it was. */
  readonly isNew: boolean;
  readonly streaks: Streaks;
};

/** One player's daily results and streaks. */
export interface DailyResults {
  /**
   * Keeps a finished puzzle's result, unless one already exists for the same puzzle and
   * variant (a finished result stays as it was), then returns the game's streaks for `today`.
   */
  record(result: DailyResult, today: string): Promise<Result<Recorded, StorageError>>;
  /** The result for a puzzle and variant, or null. */
  get(puzzleId: string, variant: string | null): Promise<Result<DailyResult | null, StorageError>>;
  /** Every result kept for a game, oldest puzzle first. */
  list(gameId: string): Promise<Result<readonly DailyResult[], StorageError>>;
  /**
   * The game's streaks on `today`, today's UTC date, computed from the results.
   * Also writes the streak records, so a missed date resets the stored current streak the
   * next time the player opens the game. A stored best higher than the computed one is kept.
   */
  streaks(gameId: string, today: string): Promise<Result<Streaks, StorageError>>;
}

const checkGame = (gameId: string): string => {
  if (!isGameId(gameId)) {
    throw new RangeError(`Expected a kebab-case game id, got ${JSON.stringify(gameId)}.`);
  }
  return gameId;
};

/**
 * The results store for one player. Throws a `RangeError` for a player id that can't be part
 * of a storage key, as `storage.player` does.
 */
export const createDailyResults = (storage: Storage, playerId: string): DailyResults => {
  const player = storage.player(playerId);
  const results: RecordStore<DailyResult> = storage.records(DAILY_RESULT_RECORD);
  const streakRecords: RecordStore<Streak> = storage.records(STREAK_RECORD);
  const prefix = (gameId: string): string => `${playerId}/~daily/${checkGame(gameId)}/`;
  const refOf = (puzzleId: string) => {
    const ref = parsePuzzleId(puzzleId);
    if (ref === null) throw new RangeError(`Not a daily puzzle id: ${JSON.stringify(puzzleId)}.`);
    return ref;
  };
  const gameOf = (puzzleId: string): string => refOf(puzzleId).gameId;
  const keyOf = (puzzleId: string, variant: string | null): string => {
    const ref = refOf(puzzleId);
    return `${prefix(ref.gameId)}${ref.date}/${variant ?? '-'}`;
  };
  const winKey = (gameId: string): string => `${playerId}/${checkGame(gameId)}/win`;

  const list = async (gameId: string): Promise<Result<readonly DailyResult[], StorageError>> => {
    const keys = await results.keys(prefix(gameId));
    if (!keys.ok) return keys;
    const found: DailyResult[] = [];
    for (const key of keys.value) {
      const result = await results.get(key);
      if (!result.ok) return result;
      if (result.value !== null) found.push(result.value);
    }
    return ok(found);
  };

  const streaks = async (gameId: string, today: string): Promise<Result<Streaks, StorageError>> => {
    const all = await list(gameId);
    if (!all.ok) return all;
    const computed = computeStreaks(all.value, today);
    const [stored, storedWin] = await Promise.all([player.streaks.get(gameId), streakRecords.get(winKey(gameId))]);
    const best = Math.max(computed.best, stored.ok ? stored.value.best : 0);
    const winBest = Math.max(computed.winBest, storedWin.ok ? (storedWin.value ?? EMPTY_STREAK).best : 0);
    const merged: Streaks = { ...computed, best, winBest };

    const days: Streak = { current: merged.current, best, lastDay: merged.lastDay };
    const wins: Streak = { current: merged.winCurrent, best: winBest, lastDay: merged.lastDay };
    const wrote = await player.streaks.set(gameId, days);
    if (!wrote.ok) return wrote;
    const wroteWin = await streakRecords.set(winKey(gameId), wins);
    return wroteWin.ok ? ok(merged) : wroteWin;
  };

  return {
    get: async (puzzleId, variant) => results.get(keyOf(puzzleId, variant)),
    list,
    streaks,
    record: async (result, today) => {
      const key = keyOf(result.puzzleId, result.variant);
      const existing = await results.get(key);
      if (!existing.ok) return existing;
      const isNew = existing.value === null;
      if (isNew) {
        const written = await results.set(key, result);
        if (!written.ok) return written;
      }
      const current = await streaks(gameOf(result.puzzleId), today);
      if (!current.ok) return current;
      return ok({ result: existing.value ?? result, isNew, streaks: current.value });
    },
  };
};
