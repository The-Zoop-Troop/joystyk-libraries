import { err, isGameId, ok, type Result } from '@joystyk/contracts';
import { MESSAGES, storageError, type StorageError } from './backend.ts';

// Keys are paths: `<playerId>/<gameId>/<slot>`. Every part but a game's own free-form key is
// restricted, so a part can never contain the separator and a prefix lists exactly one
// player's or one game's records.

const PART = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** True for a player id or slot name that can be part of a key: 1–64 letters, digits, `_` or `-`. */
export const isKeyPart = (value: unknown): value is string => typeof value === 'string' && PART.test(value);

/** The longest free-form key a game may use through `PlatformApi.storage`. */
export const MAX_GAME_KEY_LENGTH = 256;

const invalid = (what: string, value: string): Result<never, StorageError> =>
  err(storageError('InvalidKey', MESSAGES.InvalidKey, { [what]: value }));

/** `<playerId>/<gameId>/`: the prefix of everything one player keeps for one game. */
export const gamePrefix = (playerId: string, gameId: string): Result<string, StorageError> =>
  isGameId(gameId) ? ok(`${playerId}/${gameId}/`) : invalid('gameId', gameId);

/** `<playerId>/<gameId>/<slot>`, for saves. */
export const slotKey = (playerId: string, gameId: string, slot: string): Result<string, StorageError> => {
  const prefix = gamePrefix(playerId, gameId);
  if (!prefix.ok) return prefix;
  return isKeyPart(slot) ? ok(prefix.value + slot) : invalid('slot', slot);
};

/** `<playerId>/<gameId>/<key>`, for a game's own key-value data. The key is free-form. */
export const gameDataKey = (playerId: string, gameId: string, key: string): Result<string, StorageError> => {
  const prefix = gamePrefix(playerId, gameId);
  if (!prefix.ok) return prefix;
  return key.length > 0 && key.length <= MAX_GAME_KEY_LENGTH ? ok(prefix.value + key) : invalid('key', key);
};

/** `<playerId>/<gameId>`, for per-game records with one value each (stats, streaks). */
export const gameKey = (playerId: string, gameId: string): Result<string, StorageError> =>
  isGameId(gameId) ? ok(`${playerId}/${gameId}`) : invalid('gameId', gameId);
