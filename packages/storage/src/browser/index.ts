// @joystyk/storage/browser: the browser-only parts. IndexedDB, persistent storage, and the
// system settings that preferences resolve against.
import { createMemoryBackend } from '../memory.ts';
import { MESSAGES } from '../backend.ts';
import type { SystemEnvironment } from '../preferences.ts';
import { openStorage, type Storage, type StorageOptions } from '../storage.ts';
import { openChangeFeed } from './changes.ts';
import { openIndexedDbBackend, type IndexedDbOptions } from './indexeddb.ts';

export {
  broadcastChangeFeed,
  CHANGE_CHANNEL,
  openChangeFeed,
  storageEventChangeFeed,
  type ChangeFeedHost,
} from './changes.ts';
export {
  DATABASE_UPGRADES,
  openIndexedDbBackend,
  toStorageError,
  type DatabaseUpgrade,
  type IndexedDbOptions,
} from './indexeddb.ts';
export {
  estimateStorage,
  isStoragePersisted,
  requestPersistentStorage,
  type PersistResult,
  type StorageManagerLike,
} from './persist.ts';

/**
 * Opens storage over IndexedDB, with a change feed (`openChangeFeed`) that keeps other tabs'
 * preferences in step; pass `changes` to use another. Where IndexedDB is missing or refused
 * (some private modes, blocked site data), it falls back to memory so the site still works,
 * and sends an `Unavailable` notice: progress lasts only until the tab closes. Memory isn't
 * shared between tabs, so that storage has no change feed.
 */
export const openBrowserStorage = async (
  options: Omit<StorageOptions, 'backend'> & { readonly indexedDb?: IndexedDbOptions } = {},
): Promise<Storage> => {
  const backend = await openIndexedDbBackend(options.indexedDb);
  if (backend.ok)
    return openStorage({ ...options, backend: backend.value, changes: options.changes ?? openChangeFeed() });
  options.onNotice?.({
    code: 'Unavailable',
    message: MESSAGES.Unavailable,
    store: null,
    key: null,
    issues: [`${backend.error.code}: ${String(backend.error.detail ?? backend.error.message)}`],
  });
  const { changes: _unshared, ...rest } = options;
  return openStorage({ ...rest, backend: createMemoryBackend() });
};

/** Reads the system settings that `resolvePreferences` falls back on. */
export const systemEnvironment = (view: Window = window): SystemEnvironment => ({
  prefersReducedMotion: view.matchMedia('(prefers-reduced-motion: reduce)').matches,
  prefersDark: view.matchMedia('(prefers-color-scheme: dark)').matches,
  locale: view.navigator.language,
});
