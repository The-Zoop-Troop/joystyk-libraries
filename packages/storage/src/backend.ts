import type { GameError, Json, Result } from '@joystyk/contracts';

/**
 * The object stores every backend provides. IndexedDB creates one object store per name;
 * the memory backend keeps one map per name.
 */
export const STORE_NAMES = ['saves', 'stats', 'streaks', 'preferences', 'game-data', 'identity', 'archive'] as const;

/** One of the backend's object stores. */
export type StoreName = (typeof STORE_NAMES)[number];

/** Why a storage operation failed. */
export type StorageErrorCode =
  /** The browser refused the write because the origin's storage is full. */
  | 'QuotaExceeded'
  /** Storage can't be opened: private browsing, blocked site data, or no IndexedDB at all. */
  | 'Unavailable'
  /** The value isn't JSON or doesn't match its record's schema; nothing was written. */
  | 'InvalidValue'
  /** A key part is empty, too long or contains characters keys may not use. */
  | 'InvalidKey'
  /** Anything else the backend reported. */
  | 'Failed';

/** An expected storage failure, worded for players. Shaped like `GameError`. */
export type StorageError = GameError & { readonly code: StorageErrorCode };

/** Builds a `StorageError`, leaving out an absent `detail` so the error stays JSON. */
export const storageError = (code: StorageErrorCode, message: string, detail?: Json): StorageError =>
  detail === undefined ? { code, message } : { code, message, detail };

/** Player-facing wording for each failure. */
export const MESSAGES = {
  QuotaExceeded: "Your browser's storage for this site is full, so this couldn't be saved.",
  Unavailable: "This browser isn't letting the site store data, so progress won't be kept.",
  InvalidValue: "This couldn't be saved because it isn't in a form the site can store.",
  InvalidKey: "This couldn't be saved because its name isn't valid.",
  Failed: 'Something went wrong while saving or loading.',
} as const satisfies Record<StorageErrorCode, string>;

/** What `putIfAbsent` found: `written`, or the value another write left at the key. */
export type PutIfAbsent = { readonly written: true } | { readonly written: false; readonly value: unknown };

/**
 * Raw key-value persistence: the only part that differs between IndexedDB and memory.
 * Values are JSON. Every operation resolves to a `Result`; expected failures, such as a full
 * quota, never reject. Keys are strings, ordered by code unit, and `keys` lists those that
 * start with a prefix.
 */
export interface StorageBackend {
  /** `undefined` when the key is absent. The value is untrusted: decode it before use. */
  get(store: StoreName, key: string): Promise<Result<unknown, StorageError>>;
  put(store: StoreName, key: string, value: Json): Promise<Result<void, StorageError>>;
  /**
   * Writes `value` only when `key` is absent, as one atomic step: of two callers racing, even
   * in two tabs, exactly one writes. Resolves to whether this call wrote, and the value the
   * key holds afterwards (untrusted when another caller wrote it).
   */
  putIfAbsent(store: StoreName, key: string, value: Json): Promise<Result<PutIfAbsent, StorageError>>;
  delete(store: StoreName, key: string): Promise<Result<void, StorageError>>;
  /** The keys that start with `prefix`, in ascending order. */
  keys(store: StoreName, prefix: string): Promise<Result<readonly string[], StorageError>>;
  clear(store: StoreName): Promise<Result<void, StorageError>>;
  /** Releases the connection. Idempotent. */
  close(): void;
}
