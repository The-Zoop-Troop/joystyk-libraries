// @joystyk/storage: versioned, validated player data over a pluggable backend. This entry
// point is headless (no DOM), so it runs in Node for server rendering and unit tests. The
// IndexedDB backend and the persistent-storage helper live in '@joystyk/storage/browser'.

export {
  MESSAGES,
  STORE_NAMES,
  storageError,
  type PutIfAbsent,
  type StorageBackend,
  type StorageError,
  type StorageErrorCode,
  type StoreName,
} from './backend.ts';
export { createMemoryChangeHub, parseStorageChange, type ChangeFeed, type StorageChange } from './changes.ts';
export { createMemoryBackend, type MemoryBackend, type MemoryBackendOptions } from './memory.ts';
export {
  createRecordStore,
  decodeRecord,
  defineRecordKind,
  putWithQuotaRetry,
  type ArchivedRecord,
  type RecordContext,
  type RecordKind,
  type RecordStore,
  type StorageNotice,
  type StorageNoticeCode,
} from './record.ts';
export { isKeyPart, MAX_GAME_KEY_LENGTH } from './keys.ts';
export { json, validate, type Issue } from './validate.ts';
export { saveEnvelope } from './envelope.ts';
export { SAVE_RECORD, type SavedGame, type SaveDecoder, type SaveStore } from './saves.ts';
export { EMPTY_STATS, recordOutcome, STATS_RECORD, type GameStats, type StatsStore } from './stats.ts';
export { EMPTY_STREAK, STREAK_RECORD, type Streak, type StreakStore } from './streaks.ts';
export {
  DEFAULT_PREFERENCES,
  PREFERENCES_RECORD,
  resolvePreferences,
  type PreferencesSource,
  type PreferencesStore,
  type ResolvedPreferences,
  type StoredPreferences,
  type SystemEnvironment,
} from './preferences.ts';
export { GAME_DATA_RECORD, StorageFailure } from './game-data.ts';
export { openStorage, type PlayerStorage, type Storage, type StorageOptions } from './storage.ts';
