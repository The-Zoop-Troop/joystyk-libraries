import { ok, type Outcome, type Result } from '@joystyk/contracts';
import * as z from 'zod/mini';
import type { StorageError } from './backend.ts';
import { gameKey } from './keys.ts';
import { createRecordStore, defineRecordKind, type RecordContext } from './record.ts';

/** One player's totals for one game, across every mode played on this device. */
export type GameStats = {
  readonly played: number;
  readonly won: number;
  readonly lost: number;
  readonly drawn: number;
  /** Solo games that end without winning or losing, such as a solved puzzle. */
  readonly completed: number;
  readonly abandoned: number;
  /** Active play time across all games, in milliseconds. */
  readonly totalElapsedMs: number;
  /** Epoch milliseconds of the last finished game, or null. */
  readonly lastPlayedAt: number | null;
};

export const EMPTY_STATS: GameStats = {
  played: 0,
  won: 0,
  lost: 0,
  drawn: 0,
  completed: 0,
  abandoned: 0,
  totalElapsedMs: 0,
  lastPlayedAt: null,
};

const count = z.int().check(z.nonnegative());

/** Version 1 of the stats record. */
export const STATS_RECORD = defineRecordKind<GameStats>({
  store: 'stats',
  version: 1,
  schema: z.object({
    played: count,
    won: count,
    lost: count,
    drawn: count,
    completed: count,
    abandoned: count,
    totalElapsedMs: z.number().check(z.nonnegative()),
    lastPlayedAt: z.nullable(z.number().check(z.nonnegative())),
  }),
  label: 'set of game stats',
});

const COUNTERS = {
  won: 'won',
  lost: 'lost',
  draw: 'drawn',
  completed: 'completed',
  abandoned: 'abandoned',
} as const satisfies Record<Outcome['result'], keyof GameStats>;

/** Adds one finished game to the totals. Pure. `at` is epoch milliseconds. */
export const recordOutcome = (stats: GameStats, outcome: Outcome, at: number): GameStats => {
  const counter = COUNTERS[outcome.result];
  return {
    ...stats,
    played: stats.played + 1,
    [counter]: stats[counter] + 1,
    totalElapsedMs: stats.totalElapsedMs + (outcome.elapsedMs ?? 0),
    lastPlayedAt: at,
  };
};

/**
 * One player's stats, by game id. Written through this interface so v2 can sync them to an
 * account without changing games.
 */
export interface StatsStore {
  /** The game's stats, or `EMPTY_STATS` when there are none yet. */
  get(gameId: string): Promise<Result<GameStats, StorageError>>;
  set(gameId: string, stats: GameStats): Promise<Result<void, StorageError>>;
  /** Reads, adds the outcome with `recordOutcome`, writes, and returns the new totals. */
  record(gameId: string, outcome: Outcome): Promise<Result<GameStats, StorageError>>;
}

export const createStatsStore = (context: RecordContext, playerId: string): StatsStore => {
  const records = createRecordStore(context, STATS_RECORD);
  const get = async (gameId: string): Promise<Result<GameStats, StorageError>> => {
    const key = gameKey(playerId, gameId);
    if (!key.ok) return key;
    const stats = await records.get(key.value);
    return stats.ok ? ok(stats.value ?? EMPTY_STATS) : stats;
  };
  const set = async (gameId: string, stats: GameStats): Promise<Result<void, StorageError>> => {
    const key = gameKey(playerId, gameId);
    return key.ok ? records.set(key.value, stats) : key;
  };
  return {
    get,
    set,
    record: async (gameId, outcome) => {
      const current = await get(gameId);
      if (!current.ok) return current;
      const next = recordOutcome(current.value, outcome, context.now());
      const written = await set(gameId, next);
      return written.ok ? ok(next) : written;
    },
  };
};
