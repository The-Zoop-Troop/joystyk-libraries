// The content client in real Chromium: IndexedDB for the offline cache, Web Crypto for content
// hashes, and a fake `fetch` standing in for the site.
import type { Json } from '@joystyk/contracts';
import { openBrowserStorage } from '@joystyk/storage/browser';
import type { Storage } from '@joystyk/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays } from '../index.ts';
import { CACHED_PUZZLE_RECORD, contentHashOf, createDailyClient, type FetchLike } from './index.ts';

const BASE = 'https://joystyk.example/daily/';
const GAME = 'daily-word';
const TODAY = '2026-10-08';
const config = z.object({ answer: z.string().check(z.length(5)) });

type Published = { date: string; hash: string; body: Json };

/** A fake site: published files, an index, a switch for going offline, and a request log. */
const fakeSite = () => {
  const files = new Map<string, Published>();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  let offline = false;

  const publish = async (
    date: string,
    answer: string,
    overrides: Partial<Record<string, Json>> = {},
  ): Promise<Published> => {
    const cfg = { answer };
    const hash = (await contentHashOf(cfg)) ?? '';
    const body: Json = {
      schemaVersion: 1,
      puzzleId: `${GAME}:${date}`,
      date,
      contentHash: hash,
      config: cfg,
      ...overrides,
    };
    const entry = { date, hash, body };
    files.set(date, entry);
    return entry;
  };

  const respond = (status: number, body: unknown): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    if (offline) throw new TypeError('Failed to fetch');
    const path = url.slice(BASE.length);
    if (path === `${GAME}/index.json`) {
      const dates = [...files.values()].map((entry) => ({
        date: entry.date,
        hash: entry.hash,
        size: JSON.stringify(entry.body).length,
      }));
      return respond(200, { schemaVersion: 1, gameId: GAME, dates });
    }
    const match = /^daily-word\/(\d{4}-\d{2}-\d{2})\.([0-9a-f]{12})\.json$/.exec(path);
    const entry = match === null ? undefined : files.get(match[1] ?? '');
    if (entry === undefined || entry.hash !== match?.[2]) return respond(404, 'Not found');
    return respond(200, entry.body);
  };

  return {
    fetch,
    publish,
    files,
    requests,
    goOffline: (value = true) => {
      offline = value;
    },
    fileRequests: () => requests.filter((r) => !r.url.endsWith('index.json')).length,
  };
};

let name = '';
let storage: Storage;

beforeEach(async () => {
  name = `joystyk-daily-test-${Date.now()}-${Math.random()}`;
  storage = await openBrowserStorage({ indexedDb: { name } });
});

afterEach(async () => {
  storage.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

const clientFor = (site: ReturnType<typeof fakeSite>, store = storage) =>
  createDailyClient({ baseUrl: BASE, gameId: GAME, config, storage: store, fetch: site.fetch });

describe('puzzle', () => {
  it('downloads, decodes and caches today, then serves it from the cache while the hash holds', async () => {
    const site = fakeSite();
    const published = await site.publish(TODAY, 'PQVJO');
    const client = clientFor(site);

    const first = await client.puzzle(TODAY);
    expect(first).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        puzzleId: 'daily-word:2026-10-08',
        date: TODAY,
        contentHash: published.hash,
        config: { answer: 'PQVJO' },
        source: 'network',
      },
    });
    const second = await client.puzzle(TODAY);
    expect(second.ok && second.value.source).toBe('cache');
    expect(site.fileRequests()).toBe(1);
  });

  it('keeps the cache across reopening the database', async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    await clientFor(site).puzzle(TODAY);
    storage.close();

    storage = await openBrowserStorage({ indexedDb: { name } });
    site.goOffline();
    const offline = await clientFor(site).puzzle(TODAY);
    expect(offline.ok && offline.value).toMatchObject({ config: { answer: 'PQVJO' }, source: 'cache' });
  });

  it('says plainly that an uncached puzzle needs a connection when offline', async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    site.goOffline();
    const result = await clientFor(site).puzzle(TODAY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('Offline');
      expect(result.error.message).toBe("This puzzle needs a connection. It will download next time you're online.");
    }
  });

  it("refuses a date the index doesn't list", async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    const result = await clientFor(site).puzzle('2026-10-09');
    expect(!result.ok && result.error.code).toBe('NotPublished');
  });

  it('downloads a replacement when the index carries a new hash (withdraw and replace)', async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    const client = clientFor(site);
    await client.puzzle(TODAY);
    const replaced = await site.publish(TODAY, 'ZXQWV');
    const result = await client.puzzle(TODAY);
    expect(result.ok && result.value).toMatchObject({
      contentHash: replaced.hash,
      config: { answer: 'ZXQWV' },
      source: 'network',
    });
    expect((await client.cached(TODAY))?.contentHash).toBe(replaced.hash);
  });

  it('refuses the older copy when the index replaces it and the new file is invalid', async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    const client = clientFor(site);
    await client.puzzle(TODAY);
    await site.publish(TODAY, 'ZXQWV', { config: { answer: 'TOO LONG' } });
    const result = await client.puzzle(TODAY);
    expect(result).toMatchObject({ ok: false, error: { code: 'Invalid' } });
  });

  it("refuses and doesn't cache a file that fails the game's schema", async () => {
    const site = fakeSite();
    const entry = await site.publish(TODAY, 'PQVJO');
    site.files.set(TODAY, { ...entry, body: { ...(entry.body as object), config: { answer: 'TOOLONG' } } });
    const client = clientFor(site);
    const result = await client.puzzle(TODAY);
    expect(!result.ok && result.error.code).toBe('Invalid');
    expect(await client.cached(TODAY)).toBeNull();
  });

  it("refuses a file whose content doesn't match its hash", async () => {
    const site = fakeSite();
    const entry = await site.publish(TODAY, 'PQVJO');
    site.files.set(TODAY, { ...entry, body: { ...(entry.body as object), config: { answer: 'ABCDE' } } });
    const result = await clientFor(site).puzzle(TODAY);
    expect(!result.ok && result.error.code).toBe('Invalid');
  });

  it('sends no cookies, referrer or query string, and revalidates the index every time', async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    await clientFor(site).puzzle(TODAY);
    for (const request of site.requests) {
      expect(request.url).not.toMatch(/[?#]/);
      expect(request.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    }
    expect(site.requests[0]).toMatchObject({ url: `${BASE}${GAME}/index.json`, init: { cache: 'no-cache' } });
  });

  it('decodes cached files again on every read and drops any that no longer pass', async () => {
    const site = fakeSite();
    const entry = await site.publish(TODAY, 'PQVJO');
    const client = clientFor(site);
    await client.puzzle(TODAY);
    const cache = storage.records(CACHED_PUZZLE_RECORD);
    await cache.set(`~daily/${GAME}/${TODAY}`, {
      hash: entry.hash,
      file: { ...(entry.body as object), config: { answer: 7 } },
    });
    expect(await client.cached(TODAY)).toBeNull();
    expect(await cache.get(`~daily/${GAME}/${TODAY}`)).toEqual({ ok: true, value: null });
  });
});

describe('prefetch', () => {
  it('holds today and the next day only, so tomorrow plays offline', async () => {
    const site = fakeSite();
    for (let i = 0; i < 3; i += 1) await site.publish(addDays(TODAY, i), ['PQVJO', 'ZXQWV', 'MNBVC'][i] ?? '');
    const client = clientFor(site);
    expect(await client.prefetch(TODAY)).toEqual({
      fetched: ['2026-10-08', '2026-10-09'],
      cached: [],
      unavailable: [],
      failed: [],
      error: null,
    });
    expect(await client.cached('2026-10-10')).toBeNull();

    site.goOffline();
    const later = await client.puzzle('2026-10-09');
    expect(later.ok && later.value).toMatchObject({ config: { answer: 'ZXQWV' }, source: 'cache' });
  });

  it("skips what's held and what isn't out yet", async () => {
    const site = fakeSite();
    await site.publish(TODAY, 'PQVJO');
    const client = clientFor(site);
    await client.puzzle(TODAY);
    expect(await client.prefetch(TODAY)).toEqual({
      fetched: [],
      cached: ['2026-10-08'],
      unavailable: ['2026-10-09'],
      failed: [],
      error: null,
    });
    await site.publish('2026-10-09', 'ZXQWV');
    expect(await client.prefetch(TODAY)).toMatchObject({ fetched: ['2026-10-09'], cached: ['2026-10-08'] });
  });

  it('reports every date as failed when the index is out of reach', async () => {
    const site = fakeSite();
    site.goOffline();
    const report = await clientFor(site).prefetch(TODAY);
    expect(report).toMatchObject({ fetched: [], failed: ['2026-10-08', '2026-10-09'] });
    expect(report.error?.code).toBe('Offline');
  });
});

describe('prune', () => {
  it('drops puzzles older than yesterday', async () => {
    const site = fakeSite();
    const dates = ['2026-10-05', '2026-10-06', '2026-10-07', TODAY];
    for (const date of dates) await site.publish(date, 'PQVJO');
    const client = clientFor(site);
    for (const date of dates) await client.puzzle(date);
    await client.prune(TODAY);
    const held = await Promise.all(dates.map(async (date) => (await client.cached(date)) !== null));
    expect(held).toEqual([false, false, true, true]);
  });
});

it('purges a superseded puzzle when its replacement cannot be loaded, including subsequent offline reads', async () => {
  const site = fakeSite();
  await site.publish(TODAY, 'PQVJO');
  const client = clientFor(site);
  expect((await client.puzzle(TODAY)).ok).toBe(true);
  await site.publish(TODAY, 'ZXQWV', { config: { answer: 'TOO LONG' } });
  expect((await client.puzzle(TODAY)).ok).toBe(false);
  expect(await client.cached(TODAY)).toBeNull();
  site.goOffline(true);
  expect((await client.puzzle(TODAY)).ok).toBe(false);
});
