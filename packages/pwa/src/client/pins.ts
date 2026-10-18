// Tier 3, from the page: "Make available offline" writes a game's whole build into its own
// cache, `game:<id>:<version>`, which the worker checks before anything else it doesn't
// precache. The page and the worker share the origin's Cache Storage, so no message passes
// between them (the blog's design). A pin holds every file in the game's asset manifest and
// the game's page, so it is complete or it isn't kept.
import { err, ok, type Result } from '@joystyk/contracts';
import type { PersistResult } from '@joystyk/storage/browser';
import { parseAssetManifest, planPin, referencedAssets, type GameAssetManifest } from '../asset-manifest.ts';
import { parsePinnedCacheName, PIN_RECORD_PATH, pinnedCacheName } from '../names.ts';
import type { PinRecord } from '../pin-record.ts';
import { pinnedGames, type CachePorts } from './pinned.ts';

/** What pinning touches; tests pass fakes. */
export type PinPorts = CachePorts & {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Asks the browser to keep the site's data; called on the first pin only. */
  readonly persist: () => Promise<PersistResult>;
};

export const browserPinPorts = (): PinPorts => ({
  caches: globalThis.caches,
  fetch: (url, init) => fetch(url, init),
  origin: location.origin,
  // Loaded on first use: the storage package's browser code is a chunk of its own.
  persist: async () => (await import('@joystyk/storage/browser')).requestPersistentStorage(),
});

export type PinErrorCode = 'Offline' | 'Quota' | 'Invalid' | 'Incomplete' | 'Unsupported';

export type PinError = {
  readonly code: PinErrorCode;
  /** For players. */
  readonly message: string;
  /** For developers. */
  readonly detail: string;
};

export const PIN_MESSAGES: Readonly<Record<PinErrorCode, string>> = {
  Offline: "You're offline. Connect to the internet, then try again.",
  Quota: "This device is out of storage space, so the game couldn't be saved for offline play.",
  Invalid: "This game can't be saved for offline play right now.",
  Incomplete: "This game couldn't be saved for offline play right now. Try again in a minute.",
  Unsupported: "This browser can't keep games for offline play.",
};

const pinError = (code: PinErrorCode, detail: string): PinError => ({ code, message: PIN_MESSAGES[code], detail });

class PinFailure extends Error {
  readonly code: PinErrorCode;
  constructor(code: PinErrorCode, detail: string) {
    super(detail);
    this.code = code;
  }
}

const toPinError = (cause: unknown): PinError => {
  if (cause instanceof PinFailure) return pinError(cause.code, cause.message);
  if (cause instanceof DOMException && cause.name === 'QuotaExceededError') return pinError('Quota', cause.message);
  if (cause instanceof TypeError) return pinError('Offline', cause.message);
  return pinError('Incomplete', String(cause));
};

export type Pinned = {
  readonly record: PinRecord;
  /** Set on the first pin, when persistent storage was requested; null otherwise. */
  readonly persisted: PersistResult | null;
};

const pathsIn = async (cache: Cache): Promise<string[]> =>
  (await cache.keys()).map((request) => new URL(request.url).pathname);

const fetchOk = async (ports: PinPorts, url: string, cache: RequestCache): Promise<Response> => {
  const response = await ports.fetch(url, {
    cache,
    credentials: 'same-origin',
    ...(cache === 'no-cache' ? { headers: { 'X-Joystyk-Pin-Refresh': '1' } } : {}),
  });
  if (!response.ok || response.redirected)
    throw new PinFailure(
      'Incomplete',
      `${url}: HTTP ${String(response.status)}${response.redirected ? ' (redirected)' : ''}`,
    );
  return response;
};

const loadManifest = async (
  ports: PinPorts,
  gameId: string,
  assets: string,
): Promise<{ manifest: GameAssetManifest; response: Response }> => {
  const response = await fetchOk(ports, assets, 'no-cache').catch((cause: unknown) => {
    throw cause instanceof PinFailure ? new PinFailure('Invalid', cause.message) : cause;
  });
  const raw: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const parsed = parseAssetManifest(raw);
  if (!parsed.ok) throw new PinFailure('Invalid', `${assets}: ${parsed.error.join('; ')}`);
  if (parsed.value.id !== gameId)
    throw new PinFailure('Invalid', `${assets} describes ${parsed.value.id}, not ${gameId}`);
  return { manifest: parsed.value, response };
};

const pinOnce = async (ports: PinPorts, gameId: string, assets: string): Promise<Pinned> => {
  const { manifest, response: manifestResponse } = await loadManifest(ports, gameId, assets);
  const names = await ports.caches.keys();
  const firstPin = !names.some((name) => parsePinnedCacheName(name) !== null);
  const existing: { cacheName: string; paths: string[] }[] = [];
  for (const name of names) {
    if (parsePinnedCacheName(name)?.id === gameId)
      existing.push({ cacheName: name, paths: await pathsIn(await ports.caches.open(name)) });
  }
  const target = pinnedCacheName(manifest.id, manifest.version);
  const created = !names.includes(target);
  const plan = planPin(manifest, assets, target, existing, PIN_RECORD_PATH);
  const key = (path: string): string => new URL(path, ports.origin).href;
  const cache = await ports.caches.open(target);
  try {
    // Hashed files first: they never change, so the browser's HTTP cache may answer.
    for (const url of plan.fetch) await cache.put(key(url), await fetchOk(ports, url, 'default'));
    // Then the pages, fresh. A deploy between reading the manifest and the page would leave a
    // page naming files the pin lacks; refuse it, and the caller tries once more.
    const files = new Set(manifest.files.map((file) => file.url));
    const documents: [string, Response][] = [];
    for (const url of plan.documents) {
      documents.push([url, url === assets ? manifestResponse : await fetchOk(ports, url, 'no-cache')]);
    }
    const page = documents.find(([url]) => url === manifest.page)?.[1];
    if (page !== undefined) {
      const missing = referencedAssets(await page.clone().text()).filter((url) => !files.has(url));
      if (missing.length > 0)
        throw new PinFailure(
          'Incomplete',
          `${manifest.page} needs files the asset manifest doesn't list: ${missing.join(', ')}`,
        );
    }
    for (const [url, response] of documents) await cache.put(key(url), response);
    const record: PinRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      release: manifest.release,
      page: manifest.page,
      assets,
      totalBytes: manifest.totalBytes,
    };
    await cache.put(
      key(PIN_RECORD_PATH),
      new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json' } }),
    );
    // Only now, with the new build complete, drop what it replaced.
    for (const url of plan.remove) await cache.delete(key(url));
    for (const name of plan.dropCaches) await ports.caches.delete(name);
    return { record, persisted: firstPin ? await ports.persist() : null };
  } catch (cause) {
    if (created) await ports.caches.delete(target);
    throw cause;
  }
};

/**
 * Makes a game available offline, or brings its pin up to date: reads the asset manifest at
 * `assets` (the game manifest's `assets`), caches every file and the game's page, then
 * removes older builds. The first pin asks for persistent storage.
 */
export const pinGame = async (
  input: { readonly gameId: string; readonly assets: string },
  ports: PinPorts = browserPinPorts(),
): Promise<Result<Pinned, PinError>> => {
  if ((ports.caches as CacheStorage | undefined) === undefined) return err(pinError('Unsupported', 'no Cache Storage'));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return ok(await pinOnce(ports, input.gameId, input.assets));
    } catch (cause) {
      const error = toPinError(cause);
      if (error.code !== 'Incomplete' || attempt === 2) return err(error);
    }
  }
};

/**
 * Brings every pin up to the build the server has now: same version, missing files added and
 * stale ones dropped; a new version, a new cache, then the old one removed. Call it at a safe
 * point while online (Rule 2); a pin that fails to refresh keeps its old build.
 */
export const refreshPinnedGames = async (
  ports: PinPorts = browserPinPorts(),
): Promise<{ refreshed: string[]; failed: string[] }> => {
  const refreshed: string[] = [];
  const failed: string[] = [];
  for (const record of await pinnedGames(ports)) {
    const result = await pinGame({ gameId: record.id, assets: record.assets }, ports);
    (result.ok ? refreshed : failed).push(record.id);
  }
  return { refreshed, failed };
};
