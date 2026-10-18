import {
  err,
  ok,
  runMigrations,
  type Json,
  type Migration,
  type Result,
  type SaveEnvelope,
  type Validator,
} from '@joystyk/contracts';
import * as z from 'zod/mini';
import { MESSAGES, storageError, type StorageError } from './backend.ts';
import { saveEnvelope } from './envelope.ts';
import { gamePrefix, slotKey } from './keys.ts';
import { createRecordStore, defineRecordKind, type RecordContext } from './record.ts';
import { validate } from './validate.ts';

/** One saved game in a slot. */
export type SavedGame = {
  readonly slot: string;
  /** Epoch milliseconds of the write. */
  readonly savedAt: number;
  readonly envelope: SaveEnvelope;
};

/** What a game supplies to bring its saved state up to date: the game module's chain and schema. */
export type SaveDecoder = {
  /** The game's current save version (`manifest.versions.save`). */
  readonly saveVersion: number;
  readonly migrations: readonly Migration[];
  /** The engine's `schemas.state` (or the simulation's). */
  readonly state: Validator<Json>;
};

type SaveRecord = { readonly savedAt: number; readonly envelope: SaveEnvelope };

/** Version 1 of the save record: the contracts' envelope plus the time it was written. */
export const SAVE_RECORD = defineRecordKind<SaveRecord>({
  store: 'saves',
  version: 1,
  schema: z.object({ savedAt: z.number().check(z.nonnegative()), envelope: saveEnvelope }),
  onInvalid: 'archive',
  label: 'saved game',
});

/** One player's save slots, by game id and slot name. */
export interface SaveStore {
  /** Every readable save of one game, by slot name. Unreadable ones are archived with a notice. */
  list(gameId: string): Promise<Result<readonly SavedGame[], StorageError>>;
  /**
   * The save in a slot with its envelope decoded, or null. The game's own state is not
   * migrated or checked; use `load` to resume play.
   */
  read(gameId: string, slot: string): Promise<Result<SavedGame | null, StorageError>>;
  /**
   * The save in a slot, ready to resume: its state migrated from the saved version to the
   * game's current one and validated with the game's schema. A save that can't be brought up
   * to date is archived with a notice and comes back as null. The caller still compares
   * `rulesVersion` with the game's (offline-and-updates.md, Rule 3).
   */
  load(gameId: string, slot: string, decoder: SaveDecoder): Promise<Result<SavedGame | null, StorageError>>;
  /** Writes an envelope to a slot. The envelope's `gameId` must be `gameId`. */
  write(gameId: string, slot: string, envelope: SaveEnvelope): Promise<Result<void, StorageError>>;
  delete(gameId: string, slot: string): Promise<Result<void, StorageError>>;
}

export const createSaveStore = (context: RecordContext, playerId: string): SaveStore => {
  const records = createRecordStore(context, SAVE_RECORD);

  const read = async (gameId: string, slot: string): Promise<Result<SavedGame | null, StorageError>> => {
    const key = slotKey(playerId, gameId, slot);
    if (!key.ok) return key;
    const record = await records.get(key.value);
    if (!record.ok || record.value === null) return record as Result<null, StorageError>;
    if (record.value.envelope.gameId !== gameId) {
      await records.reject(key.value, [`envelope.gameId: expected "${gameId}"`]);
      return ok(null);
    }
    return ok({ slot, ...record.value });
  };

  return {
    list: async (gameId) => {
      const prefix = gamePrefix(playerId, gameId);
      if (!prefix.ok) return prefix;
      const keys = await records.keys(prefix.value);
      if (!keys.ok) return keys;
      const saves: SavedGame[] = [];
      for (const key of keys.value) {
        const save = await read(gameId, key.slice(prefix.value.length));
        if (!save.ok) return save;
        if (save.value !== null) saves.push(save.value);
      }
      return ok(saves);
    },
    read,
    load: async (gameId, slot, decoder) => {
      const save = await read(gameId, slot);
      if (!save.ok || save.value === null) return save;
      const { envelope } = save.value;
      const migrated = runMigrations(decoder.migrations, envelope.state, envelope.saveVersion, decoder.saveVersion);
      if (!migrated.ok && migrated.error.code === 'SaveFromFuture') {
        // A newer build of the game wrote it: keep it for that build rather than archive it.
        context.notify({
          code: 'RecordFromFuture',
          message: `This ${SAVE_RECORD.label} was made by a newer version of the game. Reload the page to open it.`,
          store: SAVE_RECORD.store,
          key: `${playerId}/${gameId}/${slot}`,
          issues: [`${migrated.error.code}: ${migrated.error.message}`],
        });
        return ok(null);
      }
      const state = migrated.ok
        ? await validate(decoder.state, migrated.value)
        : err([`${migrated.error.code}: ${migrated.error.message}`]);
      if (!state.ok) {
        const key = slotKey(playerId, gameId, slot);
        if (key.ok) await records.reject(key.value, state.error);
        return ok(null);
      }
      return ok({
        ...save.value,
        envelope: { ...envelope, saveVersion: decoder.saveVersion, state: state.value },
      });
    },
    write: async (gameId, slot, envelope) => {
      const key = slotKey(playerId, gameId, slot);
      if (!key.ok) return key;
      if (envelope.gameId !== gameId) {
        return err(storageError('InvalidValue', MESSAGES.InvalidValue, { gameId: envelope.gameId }));
      }
      return records.set(key.value, { savedAt: context.now(), envelope });
    },
    delete: async (gameId, slot) => {
      const key = slotKey(playerId, gameId, slot);
      if (!key.ok) return key;
      return records.delete(key.value);
    },
  };
};
