import { ok, type Result } from '@joystyk/contracts';
import * as z from 'zod/mini';
import type { StorageError } from './backend.ts';
import { gameKey } from './keys.ts';
import { createRecordStore, defineRecordKind, type RecordContext } from './record.ts';

/**
 * One player's daily streak for one game. The `daily` package decides how a streak grows
 * or breaks; this package only keeps it.
 */
export type Streak = {
  readonly current: number;
  readonly best: number;
  /** The last day played, `yyyy-mm-dd`, or null. */
  readonly lastDay: string | null;
};

export const EMPTY_STREAK: Streak = { current: 0, best: 0, lastDay: null };

const count = z.int().check(z.nonnegative());

/** Version 1 of the streak record. */
export const STREAK_RECORD = defineRecordKind<Streak>({
  store: 'streaks',
  version: 1,
  schema: z
    .object({
      current: count,
      best: count,
      lastDay: z.nullable(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/))),
    })
    .check(z.refine((streak) => streak.best >= streak.current, 'best must be at least current')),
  label: 'daily streak',
});

/** One player's daily streaks, by game id. v2 syncs them as "max wins" (offline-and-updates.md). */
export interface StreakStore {
  /** The game's streak, or `EMPTY_STREAK`. */
  get(gameId: string): Promise<Result<Streak, StorageError>>;
  set(gameId: string, streak: Streak): Promise<Result<void, StorageError>>;
}

export const createStreakStore = (context: RecordContext, playerId: string): StreakStore => {
  const records = createRecordStore(context, STREAK_RECORD);
  return {
    get: async (gameId) => {
      const key = gameKey(playerId, gameId);
      if (!key.ok) return key;
      const streak = await records.get(key.value);
      return streak.ok ? ok(streak.value ?? EMPTY_STREAK) : streak;
    },
    set: async (gameId, streak) => {
      const key = gameKey(playerId, gameId);
      return key.ok ? records.set(key.value, streak) : key;
    },
  };
};
