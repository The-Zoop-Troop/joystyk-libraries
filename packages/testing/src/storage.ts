// A fake storage port: the contract's `GameStorage`, in memory, with failure injection.

import { isJson, type GameStorage, type Json } from '@joystyk/contracts';

export type StorageOperation = 'get' | 'set' | 'delete';

/** One call the fake storage received, in order. */
export type StorageCall =
  | { readonly op: 'get'; readonly key: string }
  | { readonly op: 'set'; readonly key: string; readonly value: Json }
  | { readonly op: 'delete'; readonly key: string };

/** `GameStorage` plus what a test needs to inspect and break it. */
export interface FakeStorage extends GameStorage {
  /** The stored values, decoded, keyed by storage key. */
  entries(): Record<string, Json>;
  /** Every call so far, in order (failed calls included). */
  calls(): readonly StorageCall[];
  /** Makes the next call of `op` reject with `error` (default: an Error naming the key). */
  failNext(op: StorageOperation, error?: unknown): void;
}

/**
 * An in-memory `GameStorage`. Values are stored as JSON text, as a real store serializes
 * them, so reading returns a fresh copy and storing a value that isn't JSON (`undefined`,
 * `NaN`, a `Date`, a class instance) rejects with a `TypeError` instead of passing silently.
 */
export const createFakeStorage = (initial: Readonly<Record<string, Json>> = {}): FakeStorage => {
  const data = new Map<string, string>();
  const log: StorageCall[] = [];
  const failures: { op: StorageOperation; error: unknown }[] = [];

  const put = (key: string, value: Json): void => {
    if (!isJson(value)) throw new TypeError(`Storage values must be JSON; "${key}" isn't.`);
    data.set(key, JSON.stringify(value));
  };
  for (const [key, value] of Object.entries(initial)) put(key, value);

  const takeFailure = (op: StorageOperation, key: string): void => {
    const index = failures.findIndex((f) => f.op === op);
    if (index === -1) return;
    const [failure] = failures.splice(index, 1);
    throw failure?.error ?? new Error(`Fake storage: ${op} "${key}" failed.`);
  };

  return {
    get: async (key) => {
      log.push({ op: 'get', key });
      takeFailure('get', key);
      const text = data.get(key);
      return text === undefined ? null : (JSON.parse(text) as Json);
    },
    set: async (key, value) => {
      log.push({ op: 'set', key, value });
      takeFailure('set', key);
      put(key, value);
    },
    delete: async (key) => {
      log.push({ op: 'delete', key });
      takeFailure('delete', key);
      data.delete(key);
    },
    entries: () => Object.fromEntries([...data].map(([key, text]) => [key, JSON.parse(text) as Json])),
    calls: () => log.slice(),
    failNext: (op, error) => {
      failures.push({ op, error: error ?? new Error(`Fake storage: injected ${op} failure.`) });
    },
  };
};
