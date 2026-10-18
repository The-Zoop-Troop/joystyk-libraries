import type { GameStorage, Json, Result } from '@joystyk/contracts';
import type { StorageError } from './backend.ts';
import { gameDataKey } from './keys.ts';
import { createRecordStore, defineRecordKind, type RecordContext } from './record.ts';
import { json } from './validate.ts';

/** Version 1 of a game's own key-value record: any JSON. */
export const GAME_DATA_RECORD = defineRecordKind<Json>({
  store: 'game-data',
  version: 1,
  schema: json,
  label: 'piece of game data',
});

/** Thrown (as a rejection) by a `GameStorage` write that failed; `error` says why. */
export class StorageFailure extends Error {
  readonly error: StorageError;
  constructor(error: StorageError) {
    super(error.message);
    this.name = 'StorageFailure';
    this.error = error;
  }
}

const orThrow = async <T>(result: Promise<Result<T, StorageError>>): Promise<T> => {
  const settled = await result;
  if (!settled.ok) throw new StorageFailure(settled.error);
  return settled.value;
};

/**
 * The contracts' `GameStorage` (`PlatformApi.storage`) for one player and game. The game's
 * keys are free-form, 1–256 characters. A read that fails resolves to null (the player has
 * already been told); a failed write rejects with a `StorageFailure`, because the contract's
 * `Promise<void>` has no other way to report it.
 */
export const createGameStorage = (context: RecordContext, playerId: string, gameId: string): GameStorage => {
  const records = createRecordStore(context, GAME_DATA_RECORD);
  return {
    get: async (key) => {
      const full = gameDataKey(playerId, gameId, key);
      if (!full.ok) return null;
      const value = await records.get(full.value);
      return value.ok ? value.value : null;
    },
    set: async (key, value) => {
      const full = gameDataKey(playerId, gameId, key);
      await orThrow(full.ok ? records.set(full.value, value) : Promise.resolve(full));
    },
    delete: async (key) => {
      const full = gameDataKey(playerId, gameId, key);
      await orThrow(full.ok ? records.delete(full.value) : Promise.resolve(full));
    },
  };
};
