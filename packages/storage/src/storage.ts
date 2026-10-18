import type { GameStorage, Json } from '@joystyk/contracts';
import type { StorageBackend } from './backend.ts';
import type { ChangeFeed } from './changes.ts';
import { createGameStorage } from './game-data.ts';
import { isKeyPart } from './keys.ts';
import { createPreferencesStore, type PreferencesStore } from './preferences.ts';
import {
  createRecordStore,
  type RecordContext,
  type RecordKind,
  type RecordStore,
  type StorageNotice,
} from './record.ts';
import { createSaveStore, type SaveStore } from './saves.ts';
import { createStatsStore, type StatsStore } from './stats.ts';
import { createStreakStore, type StreakStore } from './streaks.ts';

export type StorageOptions = {
  /** `createMemoryBackend()` in tests and on the server; `openIndexedDbBackend()` in the browser. */
  readonly backend: StorageBackend;
  /** Receives every notice; the frame shows them to the player. */
  readonly onNotice?: (notice: StorageNotice) => void;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Tells other tabs about changes and hears theirs, so a preference set in one tab reaches
   * the rest (gp-d4v). `openBrowserStorage` provides one; without it, changes stay in this tab.
   */
  readonly changes?: ChangeFeed;
};

/** Everything one player keeps. Every key starts with the player id, never a device id. */
export interface PlayerStorage {
  readonly playerId: string;
  readonly saves: SaveStore;
  readonly stats: StatsStore;
  readonly streaks: StreakStore;
  readonly preferences: PreferencesStore;
  /** The `PlatformApi.storage` for one game. */
  gameStorage(gameId: string): GameStorage;
}

/** The opened storage: typed record stores over one backend. */
export interface Storage {
  /**
   * One player's data. Throws a `RangeError` for an id that can't be part of a key, which
   * is a bug: ids come from `@joystyk/identity`.
   */
  player(playerId: string): PlayerStorage;
  /** A typed store for a record kind another package defines, such as identity's profile. */
  records<T extends Json>(kind: RecordKind<T>): RecordStore<T>;
  /** Closes the backend and the change feed. Idempotent. */
  close(): void;
}

/** Opens typed, validated storage over a backend. */
export const openStorage = (options: StorageOptions): Storage => {
  const context: RecordContext = {
    backend: options.backend,
    notify: options.onNotice ?? (() => {}),
    now: options.now ?? Date.now,
  };
  const players = new Map<string, PlayerStorage>();

  return {
    player: (playerId) => {
      if (!isKeyPart(playerId)) throw new RangeError(`"${playerId}" is not a valid player id`);
      const existing = players.get(playerId);
      if (existing !== undefined) return existing;
      const player: PlayerStorage = {
        playerId,
        saves: createSaveStore(context, playerId),
        stats: createStatsStore(context, playerId),
        streaks: createStreakStore(context, playerId),
        preferences: createPreferencesStore(context, playerId, options.changes),
        gameStorage: (gameId) => createGameStorage(context, playerId, gameId),
      };
      players.set(playerId, player);
      return player;
    },
    records: (kind) => createRecordStore(context, kind),
    close: () => {
      options.changes?.close();
      options.backend.close();
    },
  };
};
