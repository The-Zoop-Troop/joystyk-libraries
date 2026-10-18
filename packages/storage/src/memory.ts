import { err, ok, type Json, type Result } from '@joystyk/contracts';
import {
  MESSAGES,
  STORE_NAMES,
  storageError,
  type StorageBackend,
  type StorageError,
  type StoreName,
} from './backend.ts';

export type MemoryBackendOptions = {
  /**
   * Simulates a storage quota: a write fails with `QuotaExceeded` when the stored keys and
   * JSON text would exceed this many UTF-16 code units. Unlimited when absent.
   */
  readonly quota?: number;
};

/** A `StorageBackend` with read access to its raw contents, for tests. */
export interface MemoryBackend extends StorageBackend {
  /** Writes a raw value with no checks, as a corrupted or older database would hold it. */
  poke(store: StoreName, key: string, value: unknown): void;
  /** The raw value, or `undefined`. */
  peek(store: StoreName, key: string): unknown;
  /** The space in use, in the units `quota` counts. */
  used(): number;
}

// Node, browsers and workers all have structuredClone; the core's ES-only lib doesn't name it.
const { structuredClone } = globalThis as unknown as { structuredClone: <T>(value: T) => T };
const copy = <T>(value: T): T => structuredClone(value);

const sizeOf = (key: string, value: unknown): number => key.length + (JSON.stringify(value)?.length ?? 0);

/**
 * An in-memory backend for unit tests and server rendering, where there is no IndexedDB.
 * It copies values on the way in and out, as IndexedDB's structured clone does, so a caller
 * that mutates a value it read can't change what is stored.
 */
export const createMemoryBackend = (options: MemoryBackendOptions = {}): MemoryBackend => {
  const stores = new Map<StoreName, Map<string, unknown>>(STORE_NAMES.map((name) => [name, new Map()]));
  const store = (name: StoreName): Map<string, unknown> => {
    const found = stores.get(name);
    if (found === undefined) throw new Error(`Unknown store "${name}"`);
    return found;
  };
  const used = (): number => {
    let total = 0;
    for (const entries of stores.values()) for (const [key, value] of entries) total += sizeOf(key, value);
    return total;
  };

  const put = (name: StoreName, key: string, value: Json): Result<void, StorageError> => {
    const entries = store(name);
    if (options.quota !== undefined) {
      const previous = entries.has(key) ? sizeOf(key, entries.get(key)) : 0;
      if (used() - previous + sizeOf(key, value) > options.quota) {
        return err(storageError('QuotaExceeded', MESSAGES.QuotaExceeded));
      }
    }
    entries.set(key, copy(value));
    return ok(undefined);
  };

  return {
    get: async (name, key) => ok(copy(store(name).get(key))),
    put: async (name, key, value: Json) => put(name, key, value),
    // Check and write in one synchronous step, so no other call can come between them.
    putIfAbsent: async (name, key, value: Json) => {
      const existing = store(name).get(key);
      if (existing !== undefined) return ok({ written: false, value: copy(existing) });
      const written = put(name, key, value);
      return written.ok ? ok({ written: true }) : written;
    },
    delete: async (name, key) => {
      store(name).delete(key);
      return ok(undefined);
    },
    keys: async (name, prefix) =>
      ok([...store(name).keys()].filter((key) => key.startsWith(prefix)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    clear: async (name) => {
      store(name).clear();
      return ok(undefined);
    },
    close: () => {},
    poke: (name, key, value) => {
      store(name).set(key, value);
    },
    peek: (name, key) => store(name).get(key),
    used,
  };
};
