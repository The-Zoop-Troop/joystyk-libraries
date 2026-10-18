// A thin IndexedDB backend: one database, one object store per StoreName, string keys, JSON
// values. No IndexedDB library; just requests wrapped in promises and errors mapped to
// StorageError results.
import { err, ok, type Json, type Result } from '@joystyk/contracts';
import {
  MESSAGES,
  STORE_NAMES,
  storageError,
  type PutIfAbsent,
  type StorageBackend,
  type StorageError,
  type StoreName,
} from '../backend.ts';

/** One step of the database's own schema: which object stores exist. */
export type DatabaseUpgrade = {
  /** The database version this step produces, from 1, with no gaps. */
  readonly version: number;
  /** Runs inside the `versionchange` transaction. Create or delete object stores here. */
  upgrade(db: IDBDatabase, transaction: IDBTransaction): void;
};

/**
 * The database schema, oldest first. Record shapes are versioned per record (see
 * `RecordKind`); this list changes only when an object store is added or removed.
 */
export const DATABASE_UPGRADES: readonly DatabaseUpgrade[] = [
  {
    version: 1,
    upgrade: (db) => {
      for (const name of STORE_NAMES) db.createObjectStore(name);
    },
  },
];

export type IndexedDbOptions = {
  /** Defaults to "joystyk". */
  readonly name?: string;
  /** Defaults to the global `indexedDB`. */
  readonly factory?: IDBFactory;
  /** Defaults to `DATABASE_UPGRADES`. */
  readonly upgrades?: readonly DatabaseUpgrade[];
  /**
   * Another tab holds an older connection open, so the upgrade waits. The frame can ask the
   * player to close other tabs of the site.
   */
  readonly onBlocked?: () => void;
  /**
   * Another tab needs a newer database version. This connection closes so that tab can
   * upgrade, and later operations fail with `Unavailable`; the frame should offer a reload.
   */
  readonly onVersionChange?: () => void;
};

const QUOTA_NAMES = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

/** Maps a DOMException (or anything thrown) to a StorageError. */
export const toStorageError = (cause: unknown): StorageError => {
  const name = typeof cause === 'object' && cause !== null ? String((cause as { name?: unknown }).name) : '';
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  if (QUOTA_NAMES.has(name)) return storageError('QuotaExceeded', MESSAGES.QuotaExceeded, detail);
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError') {
    return storageError('Unavailable', MESSAGES.Unavailable, detail);
  }
  if (name === 'DataCloneError' || name === 'DataError')
    return storageError('InvalidValue', MESSAGES.InvalidValue, detail);
  return storageError('Failed', MESSAGES.Failed, detail);
};

const checkUpgrades = (upgrades: readonly DatabaseUpgrade[]): number => {
  upgrades.forEach((step, index) => {
    if (step.version !== index + 1) {
      throw new RangeError(`Database upgrades must be numbered 1, 2, 3…; step ${index} is version ${step.version}`);
    }
  });
  if (upgrades.length === 0) throw new RangeError('At least one database upgrade is required');
  return upgrades.length;
};

/**
 * Opens (creating or upgrading) the database and returns a backend over it. Runs every
 * upgrade step newer than the stored version, in order, inside one `versionchange`
 * transaction. Resolves to `Unavailable` where IndexedDB is missing or refused.
 */
export const openIndexedDbBackend = (options: IndexedDbOptions = {}): Promise<Result<StorageBackend, StorageError>> => {
  const upgrades = options.upgrades ?? DATABASE_UPGRADES;
  const version = checkUpgrades(upgrades);
  const factory = options.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory === undefined) return Promise.resolve(err(storageError('Unavailable', MESSAGES.Unavailable)));

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(options.name ?? 'joystyk', version);
    } catch (cause) {
      resolve(err(toStorageError(cause)));
      return;
    }
    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (transaction === null) return;
      for (const step of upgrades) {
        if (step.version > event.oldVersion) step.upgrade(request.result, transaction);
      }
    };
    request.onblocked = () => options.onBlocked?.();
    request.onerror = (event) => {
      event.preventDefault();
      resolve(err(toStorageError(request.error)));
    };
    request.onsuccess = () => resolve(ok(createBackend(request.result, options)));
  });
};

const createBackend = (db: IDBDatabase, options: IndexedDbOptions): StorageBackend => {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    db.close();
  };
  db.onversionchange = () => {
    close();
    options.onVersionChange?.();
  };
  // The browser closed the connection itself, e.g. when site data was cleared.
  db.onclose = () => {
    closed = true;
  };

  /**
   * Runs `work` in a transaction on one store and resolves when the transaction commits, so
   * a write counts as done only once it is durable. Quota errors often surface only as the
   * transaction aborting, so the abort is mapped too.
   */
  const run = <T>(
    store: StoreName,
    mode: IDBTransactionMode,
    work: (objectStore: IDBObjectStore, done: (value: T) => void) => void,
  ): Promise<Result<T, StorageError>> =>
    new Promise((resolve) => {
      if (closed) {
        resolve(err(storageError('Unavailable', MESSAGES.Unavailable)));
        return;
      }
      let value: T | undefined;
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(store, mode);
        work(transaction.objectStore(store), (result) => {
          value = result;
        });
      } catch (cause) {
        resolve(err(toStorageError(cause)));
        return;
      }
      transaction.oncomplete = () => resolve(ok(value as T));
      transaction.onabort = () => resolve(err(toStorageError(transaction.error)));
      // An error event is followed by an abort; prevent it from reaching window.onerror.
      transaction.onerror = (event) => event.preventDefault();
    });

  return {
    get: (store, key) =>
      run<unknown>(store, 'readonly', (objectStore, done) => {
        const request = objectStore.get(key);
        request.onsuccess = () => done(request.result);
      }),
    put: (store, key, value: Json) =>
      run<void>(store, 'readwrite', (objectStore) => {
        objectStore.put(value, key);
      }),
    // One readwrite transaction reads and adds. IndexedDB runs readwrite transactions on the
    // same store one at a time, across every connection to the database, so two tabs can't
    // both find the key absent.
    putIfAbsent: (store, key, value: Json) =>
      run<PutIfAbsent>(store, 'readwrite', (objectStore, done) => {
        const request = objectStore.get(key);
        request.onsuccess = () => {
          if (request.result !== undefined) return done({ written: false, value: request.result });
          objectStore.add(value, key);
          done({ written: true });
        };
      }),
    delete: (store, key) =>
      run<void>(store, 'readwrite', (objectStore) => {
        objectStore.delete(key);
      }),
    keys: (store, prefix) =>
      run<readonly string[]>(store, 'readonly', (objectStore, done) => {
        const keys: string[] = [];
        done(keys);
        const request = objectStore.openKeyCursor(prefix === '' ? null : IDBKeyRange.lowerBound(prefix));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          const key = cursor.key;
          if (typeof key !== 'string' || !key.startsWith(prefix)) return;
          keys.push(key);
          cursor.continue();
        };
      }),
    clear: (store) =>
      run<void>(store, 'readwrite', (objectStore) => {
        objectStore.clear();
      }),
    close,
  };
};
