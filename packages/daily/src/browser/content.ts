// The content client: fetch a game's index and puzzle files from the site, decode them through
// the game's schema, and keep them on the device so a downloaded day plays offline
// (content-pipeline.md, "Delivery" and "Prefetching for offline play").
//
// Downloaded puzzles are kept as raw JSON in the storage package's `game-data` store, under
// `~daily/<game>/<date>`. The `~` can't start a player id, so these keys never meet a player's
// own records. Every read, from the network or from the cache, decodes the file again.

import { err, isGameId, isJson, ok, type Json, type Result, type Validator } from '@joystyk/contracts';
import { defineRecordKind, type RecordStore, type Storage } from '@joystyk/storage';
import * as z from 'zod/mini';
import { addDays, isIsoDate } from '../dates.ts';
import { prefetchDates } from '../release.ts';
import {
  CONTENT_HASH,
  dailyEnvelope,
  dailyIndex,
  decode,
  json,
  type DailyEnvelope,
  type DailyIndex,
} from '../schemas.ts';
import { dailyError, type DailyError } from './errors.ts';
import { contentHashOf } from './hash.ts';

/** A downloaded puzzle file, as the cache keeps it. */
export type CachedPuzzle = {
  readonly hash: string;
  /** The file exactly as served; decoded again on every read. */
  readonly file: Json;
};

/** Version 1 of a cached puzzle file. */
export const CACHED_PUZZLE_RECORD = defineRecordKind<CachedPuzzle>({
  store: 'game-data',
  version: 1,
  schema: z.object({ hash: z.string().check(z.regex(CONTENT_HASH)), file: json }),
  label: 'downloaded daily puzzle',
});

/** The cache key prefix for one game's downloaded puzzles. */
export const cachePrefix = (gameId: string): string => `~daily/${gameId}/`;

/** Just enough of `fetch` for the client; tests pass a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type DailyClientOptions<Config> = {
  /** Where the site serves daily content: "/daily" or "https://example.com/daily". */
  readonly baseUrl: string;
  readonly gameId: string;
  /** The game's `schemas.config`, which every puzzle file's `config` must pass. */
  readonly config: Validator<Config>;
  readonly storage: Storage;
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /**
   * Check each downloaded file's content hash with Web Crypto before keeping it. Default true;
   * skipped where `crypto.subtle` is missing (pages served over plain http).
   */
  readonly verifyHash?: boolean;
};

/** A decoded puzzle and where it came from. */
export type DailyPuzzle<Config> = DailyEnvelope<Config> & { readonly source: 'network' | 'cache' };

/** What a prefetch did with each date. */
export type PrefetchReport = {
  /** Downloaded and kept now. */
  readonly fetched: readonly string[];
  /** Already on the device with the current hash. */
  readonly cached: readonly string[];
  /** Not listed in the index yet. */
  readonly unavailable: readonly string[];
  /** Listed, but the download or decode failed. Tried again next time. */
  readonly failed: readonly string[];
  /** Set when the index itself couldn't be loaded; then every date is in `failed`. */
  readonly error: DailyError | null;
};

export interface DailyClient<Config> {
  /** Fetches and decodes the game's index, revalidating every time. */
  index(): Promise<Result<DailyIndex, DailyError>>;
  /**
   * The puzzle for `date`. Checks the index; uses the cached file when its hash is current,
   * otherwise downloads, verifies, decodes and caches it. Offline, or when the server fails,
   * it falls back to a cached file only when the index itself is unreachable. A known
   * superseded or unlisted copy is purged, including for subsequent offline reads.
   * Pick `date` with `canStart`; this client doesn't judge which dates a player may start.
   */
  puzzle(date: string): Promise<Result<DailyPuzzle<Config>, DailyError>>;
  /** The cached puzzle for `date`, decoded, or null. Never touches the network. */
  cached(date: string): Promise<DailyPuzzle<Config> | null>;
  /**
   * Downloads today's puzzle and the next day's (D-46), where the index lists them and the
   * device doesn't hold them yet. The next day's puzzle stays locked until its UTC day begins
   * (`canStart`). The PWA calls this at a safe point for installed clients and pinned games;
   * this package doesn't decide who prefetches.
   */
  prefetch(today: string): Promise<PrefetchReport>;
  /** Deletes cached puzzles older than `keepPast` days before `today` (default 1: keep yesterday). */
  prune(today: string, keepPast?: number): Promise<void>;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

const checkDate = (date: string): void => {
  if (!isIsoDate(date)) throw new RangeError(`Expected a "yyyy-mm-dd" date, got ${JSON.stringify(date)}.`);
};

/** Creates the content client for one daily game. */
export const createDailyClient = <Config>(options: DailyClientOptions<Config>): DailyClient<Config> => {
  const { gameId, storage } = options;
  if (!isGameId(gameId)) throw new RangeError(`Expected a kebab-case game id, got ${JSON.stringify(gameId)}.`);
  const base = `${trimSlash(options.baseUrl)}/${gameId}`;
  const fetchJson = options.fetch ?? ((url, init) => fetch(url, init));
  const verify = options.verifyHash ?? true;
  const cache: RecordStore<CachedPuzzle> = storage.records(CACHED_PUZZLE_RECORD);
  const keyOf = (date: string): string => `${cachePrefix(gameId)}${date}`;

  // No cookies, identifiers or query strings: only the path (content-pipeline.md, "Delivery").
  const getJson = async (url: string, init: RequestInit): Promise<Result<unknown, DailyError>> => {
    let response: Response;
    try {
      response = await fetchJson(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (cause) {
      return err(dailyError('Offline', String(cause)));
    }
    if (response.status === 404) return err(dailyError('NotPublished', `${url}: 404`));
    if (!response.ok) return err(dailyError('Failed', `${url}: HTTP ${response.status}`));
    try {
      return ok(await response.json());
    } catch (cause) {
      return err(dailyError('Invalid', `${url}: ${String(cause)}`));
    }
  };

  const index = async (): Promise<Result<DailyIndex, DailyError>> => {
    const url = `${base}/index.json`;
    const raw = await getJson(url, { cache: 'no-cache' });
    if (!raw.ok) return raw;
    const decoded = await decode(dailyIndex, raw.value);
    if (!decoded.ok) return err(dailyError('Invalid', [url, ...decoded.error]));
    if (decoded.value.gameId !== gameId)
      return err(dailyError('Invalid', [url, `index is for ${decoded.value.gameId}`]));
    return decoded;
  };

  const decodeFile = async (raw: unknown, date: string, hash: string) =>
    decode(dailyEnvelope(options.config, { gameId, date, contentHash: hash }), raw);

  const cached = async (date: string): Promise<DailyPuzzle<Config> | null> => {
    checkDate(date);
    const record = await cache.get(keyOf(date));
    if (!record.ok || record.value === null) return null;
    const decoded = await decodeFile(record.value.file, date, record.value.hash);
    if (!decoded.ok) {
      // Usually a newer game build whose config schema changed; the next load downloads it again.
      await cache.delete(keyOf(date));
      return null;
    }
    return { ...decoded.value, source: 'cache' };
  };

  const download = async (date: string, hash: string): Promise<Result<DailyPuzzle<Config>, DailyError>> => {
    const url = `${base}/${date}.${hash}.json`;
    const raw = await getJson(url, {});
    if (!raw.ok) return raw.error.code === 'NotPublished' ? err(dailyError('Failed', raw.error.detail)) : raw;
    const decoded = await decodeFile(raw.value, date, hash);
    if (!decoded.ok || !isJson(raw.value))
      return err(dailyError('Invalid', [url, ...(decoded.ok ? [] : decoded.error)]));
    if (verify) {
      const actual = await contentHashOf((raw.value as { config: Json }).config);
      if (actual !== null && actual !== hash) return err(dailyError('Invalid', [url, `content hash is ${actual}`]));
    }
    // A failed write is reported by storage itself; the puzzle still plays from memory.
    await cache.set(keyOf(date), { hash, file: raw.value });
    return ok({ ...decoded.value, source: 'network' });
  };

  const load = async (
    date: string,
    listing: DailyIndex,
    held: DailyPuzzle<Config> | null,
  ): Promise<Result<DailyPuzzle<Config>, DailyError>> => {
    const entry = listing.dates.find((candidate) => candidate.date === date);
    if (entry === undefined) {
      await cache.delete(keyOf(date));
      return err(dailyError('NotPublished', `${gameId} ${date}`));
    }
    if (held !== null && held.contentHash === entry.hash) return ok(held);
    // The index revoked this version. Do not resurrect it if the new download fails.
    if (held !== null) await cache.delete(keyOf(date));
    return download(date, entry.hash);
  };

  return {
    index,
    cached,
    puzzle: async (date) => {
      checkDate(date);
      const held = await cached(date);
      const listing = await index();
      if (!listing.ok) return held === null ? listing : ok(held);
      return load(date, listing.value, held);
    },
    prefetch: async (today) => {
      checkDate(today);
      const dates = prefetchDates(today);
      const report = {
        fetched: [] as string[],
        cached: [] as string[],
        unavailable: [] as string[],
        failed: [] as string[],
      };
      const listing = await index();
      if (!listing.ok) return { ...report, failed: [...dates], error: listing.error };
      for (const date of dates) {
        const entry = listing.value.dates.find((candidate) => candidate.date === date);
        if (entry === undefined) {
          await cache.delete(keyOf(date));
          report.unavailable.push(date);
          continue;
        }
        if ((await cached(date))?.contentHash === entry.hash) {
          report.cached.push(date);
          continue;
        }
        await cache.delete(keyOf(date));
        const fetched = await download(date, entry.hash);
        (fetched.ok ? report.fetched : report.failed).push(date);
      }
      return { ...report, error: null };
    },
    prune: async (today, keepPast = 1) => {
      checkDate(today);
      const oldest = addDays(today, -keepPast);
      const keys = await cache.keys(cachePrefix(gameId));
      if (!keys.ok) return;
      for (const key of keys.value) {
        const date = key.slice(cachePrefix(gameId).length);
        if (!isIsoDate(date) || date < oldest) await cache.delete(key);
      }
    },
  };
};
