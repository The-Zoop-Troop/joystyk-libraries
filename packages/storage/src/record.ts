import {
  err,
  isJson,
  ok,
  runMigrations,
  type Json,
  type Migration,
  type Result,
  type Validator,
} from '@joystyk/contracts';
import * as z from 'zod/mini';
import { MESSAGES, storageError, type StorageBackend, type StorageError, type StoreName } from './backend.ts';
import { json, validate, type Issue } from './validate.ts';

/**
 * One kind of record: where it lives, the current version of its shape, the schema that
 * decodes it and the migrations that bring older versions up to date. Every record a
 * `RecordStore` reads passes through all three before anyone sees it.
 */
export type RecordKind<T extends Json> = {
  readonly store: StoreName;
  /** The current shape's version, from 1. Bump it, and add a migration, when the shape changes. */
  readonly version: number;
  readonly schema: Validator<T>;
  /** Pure steps from each older version to the next (the contracts' `Migration`). */
  readonly migrations: readonly Migration[];
  /**
   * What happens to a record that fails to decode: `discard` deletes it; `archive` moves its
   * raw value to the `archive` store first, where nothing reads it as trusted data, so a bug
   * report or a later build can still recover it. Saves are archived (offline-and-updates.md,
   * Rule 3).
   */
  readonly onInvalid: 'discard' | 'archive';
  /** How notices name this record to a player, e.g. "saved game". */
  readonly label: string;
};

/** Fills in a record kind's defaults: no migrations, and invalid records discarded. */
export const defineRecordKind = <T extends Json>(
  kind: Omit<RecordKind<T>, 'migrations' | 'onInvalid'> & Partial<Pick<RecordKind<T>, 'migrations' | 'onInvalid'>>,
): RecordKind<T> => ({ migrations: [], onInvalid: 'discard', ...kind });

/** Why the store is telling the player something. */
export type StorageNoticeCode =
  /** A record failed to decode and was deleted. */
  | 'RecordDiscarded'
  /** A record failed to decode and was moved to the archive. */
  | 'RecordArchived'
  /** A record was written by a newer build. It is kept, but this build can't read it. */
  | 'RecordFromFuture'
  /** A write failed because storage is full, even after clearing the archive. */
  | 'QuotaExceeded'
  /** Storage can't be opened at all. */
  | 'Unavailable';

/**
 * Something the frame should show the player, shaped like the contracts' `Notice` plus where
 * it happened. `issues` is developer detail for logs; never show it to players.
 */
export type StorageNotice = {
  readonly code: StorageNoticeCode;
  readonly message: string;
  /** Where it happened; null for a notice about storage as a whole. */
  readonly store: StoreName | null;
  readonly key: string | null;
  readonly issues: readonly Issue[];
};

/** What every record store shares: the backend, the notice sink and the clock. */
export type RecordContext = {
  readonly backend: StorageBackend;
  readonly notify: (notice: StorageNotice) => void;
  /** Epoch milliseconds, recorded with each write for v2 sync ("newest wins"). */
  readonly now: () => number;
};

/** Typed, validated access to one kind of record. */
export interface RecordStore<T extends Json> {
  /** The decoded value, or null when it is absent or failed to decode (with a notice). */
  get(key: string): Promise<Result<T | null, StorageError>>;
  /** Validates `value` against the kind's schema, then writes it at the current version. */
  set(key: string, value: T): Promise<Result<void, StorageError>>;
  /**
   * Validates `value`, then writes it only when the key holds no readable record, atomically
   * (see `StorageBackend.putIfAbsent`). Resolves to the record the key holds afterwards: this
   * value, or the one another caller, perhaps in another tab, wrote first. A record that fails
   * to decode is discarded or archived first, as `get` does. When the key holds a record from
   * a newer build, the value is returned unwritten.
   */
  setIfAbsent(key: string, value: T): Promise<Result<T, StorageError>>;
  delete(key: string): Promise<Result<void, StorageError>>;
  /** Keys that start with `prefix`, ascending. */
  keys(prefix?: string): Promise<Result<readonly string[], StorageError>>;
  /**
   * Discards or archives a record (by the kind's `onInvalid`) that decoded but failed a later
   * check, such as a game's own save schema, and tells the player.
   */
  reject(key: string, issues: readonly Issue[]): Promise<void>;
}

/** How every record sits in a backend: its shape's version, when it was written, and the value. */
const storedRecord = z.object({
  version: z.int().check(z.positive()),
  writtenAt: z.number().check(z.nonnegative()),
  value: json,
});

/** What the archive store holds for a record that failed to decode. */
export type ArchivedRecord = {
  readonly store: StoreName;
  readonly key: string;
  readonly archivedAt: number;
  readonly issues: readonly string[];
  /** The raw record, or null when it wasn't even JSON. */
  readonly raw: Json | null;
};

type Decoded<T> =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly value: T; readonly migrated: boolean }
  | { readonly kind: 'future'; readonly issues: readonly Issue[] }
  | { readonly kind: 'invalid'; readonly issues: readonly Issue[] };

/**
 * Decodes a raw backend value as a record of `kind`: checks the record's own shape, runs the
 * migrations from its version to the current one, then validates the value with the kind's
 * schema. Pure apart from the schema, which may be async.
 */
export const decodeRecord = async <T extends Json>(kind: RecordKind<T>, raw: unknown): Promise<Decoded<T>> => {
  if (raw === undefined) return { kind: 'absent' };
  const record = await validate(storedRecord, raw);
  if (!record.ok) return { kind: 'invalid', issues: record.error };
  const { version, value } = record.value;
  const migrated = runMigrations(kind.migrations, value, version, kind.version);
  if (!migrated.ok) {
    const issues = [`${migrated.error.code}: ${migrated.error.message}`];
    return migrated.error.code === 'SaveFromFuture' ? { kind: 'future', issues } : { kind: 'invalid', issues };
  }
  const decoded = await validate(kind.schema, migrated.value);
  if (!decoded.ok) return { kind: 'invalid', issues: decoded.error };
  return { kind: 'valid', value: decoded.value, migrated: version !== kind.version };
};

/**
 * Writes a value, and when storage is full, clears the archive (the least valuable data the
 * site keeps) and tries once more.
 */
export const putWithQuotaRetry = async (
  context: RecordContext,
  store: StoreName,
  key: string,
  value: Json,
): Promise<Result<void, StorageError>> => {
  const first = await context.backend.put(store, key, value);
  if (first.ok || first.error.code !== 'QuotaExceeded' || store === 'archive') return first;
  const cleared = await context.backend.clear('archive');
  if (!cleared.ok) return first;
  return context.backend.put(store, key, value);
};

const failureNotice = (store: StoreName, key: string, error: StorageError): StorageNotice | null =>
  error.code === 'QuotaExceeded' || error.code === 'Unavailable'
    ? { code: error.code, message: error.message, store, key, issues: [] }
    : null;

/** Creates the typed store for one kind of record. */
export const createRecordStore = <T extends Json>(context: RecordContext, kind: RecordKind<T>): RecordStore<T> => {
  const { backend, notify } = context;

  const reportFailure = <V>(key: string, result: Result<V, StorageError>): Result<V, StorageError> => {
    if (!result.ok) {
      const notice = failureNotice(kind.store, key, result.error);
      if (notice !== null) notify(notice);
    }
    return result;
  };

  const write = async (key: string, value: Json): Promise<Result<void, StorageError>> =>
    reportFailure(
      key,
      await putWithQuotaRetry(context, kind.store, key, { version: kind.version, writtenAt: context.now(), value }),
    );

  const reject = async (key: string, raw: unknown, issues: readonly Issue[]): Promise<void> => {
    if (kind.onInvalid === 'archive') {
      const archivedAt = context.now();
      const entry: ArchivedRecord = { store: kind.store, key, archivedAt, issues, raw: isJson(raw) ? raw : null };
      // Best effort: a full archive must not keep a broken record in the live store.
      await backend.put('archive', `${kind.store}/${key}@${archivedAt}`, entry);
    }
    await backend.delete(kind.store, key);
    const message =
      kind.onInvalid === 'archive'
        ? `A ${kind.label} couldn't be opened, so it was set aside.`
        : `A ${kind.label} couldn't be read, so it was removed.`;
    notify({
      code: kind.onInvalid === 'archive' ? 'RecordArchived' : 'RecordDiscarded',
      message,
      store: kind.store,
      key,
      issues,
    });
  };

  const get = async (key: string): Promise<Result<T | null, StorageError>> => {
    const raw = await backend.get(kind.store, key);
    if (!raw.ok) return reportFailure(key, raw);
    const decoded = await decodeRecord(kind, raw.value);
    switch (decoded.kind) {
      case 'absent':
        return ok(null);
      case 'future':
        notify({
          code: 'RecordFromFuture',
          message: `This ${kind.label} was saved by a newer version of the site. Reload the page to open it.`,
          store: kind.store,
          key,
          issues: decoded.issues,
        });
        return ok(null);
      case 'invalid':
        await reject(key, raw.value, decoded.issues);
        return ok(null);
      case 'valid':
        // Store the upgraded shape, so the migration runs once. Failing to is harmless.
        if (decoded.migrated) await write(key, decoded.value);
        return ok(decoded.value);
    }
  };

  const check = async (value: T): Promise<Result<T, StorageError>> => {
    if (!isJson(value)) return err(storageError('InvalidValue', MESSAGES.InvalidValue));
    const checked = await validate(kind.schema, value);
    return checked.ok
      ? ok(checked.value)
      : err(storageError('InvalidValue', MESSAGES.InvalidValue, [...checked.error]));
  };

  /** One atomic attempt, with the same quota retry as `write`. */
  const putIfAbsent = async (key: string, value: T) => {
    const record = { version: kind.version, writtenAt: context.now(), value };
    const first = await backend.putIfAbsent(kind.store, key, record);
    if (first.ok || first.error.code !== 'QuotaExceeded') return reportFailure(key, first);
    const cleared = await backend.clear('archive');
    return reportFailure(key, cleared.ok ? await backend.putIfAbsent(kind.store, key, record) : first);
  };

  return {
    get,
    set: async (key, value) => {
      const checked = await check(value);
      return checked.ok ? write(key, checked.value) : checked;
    },
    setIfAbsent: async (key, value) => {
      const checked = await check(value);
      if (!checked.ok) return checked;
      // A second attempt follows a record that failed to decode and was removed.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const put = await putIfAbsent(key, checked.value);
        if (!put.ok) return put;
        if (put.value.written) return ok(checked.value);
        const existing = await get(key);
        if (!existing.ok) return existing;
        if (existing.value !== null) return ok(existing.value);
      }
      return ok(checked.value);
    },
    delete: async (key) => reportFailure(key, await backend.delete(kind.store, key)),
    keys: async (prefix = '') => reportFailure(prefix, await backend.keys(kind.store, prefix)),
    reject: async (key, issues) => {
      const raw = await backend.get(kind.store, key);
      await reject(key, raw.ok ? raw.value : undefined, issues);
    },
  };
};
