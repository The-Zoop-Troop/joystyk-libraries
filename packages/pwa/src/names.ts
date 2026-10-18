// Cache names and fixed URLs, shared by the service worker, the page and the build. Every
// cache the PWA owns says what it holds and, where it can go stale, which version
// (offline-and-updates.md, "Cache tiers"), so cleanup after an update is exact.

/** Tier 1: Workbox's precache, one per release; Workbox tracks revisions inside it. */
export const PRECACHE_PREFIX = 'joystyk';
export const PRECACHE_NAME = 'shell';

/** Tier 2 kinds: each has its own capped cache. */
export const RECENT_KINDS = ['code', 'art', 'audio', 'wasm'] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];

/** Bump the suffix when a Tier 2 cache's contents change shape; old ones are then deleted. */
export const recentCacheName = (kind: RecentKind): string => `recent:${kind}:v1`;

const PINNED = /^game:([a-z0-9]+(?:-[a-z0-9]+)*):([0-9A-Za-z.+-]+)$/;

/** Tier 3: one cache per pinned game build, `game:<id>:<version>` (offline-and-updates.md). */
export const pinnedCacheName = (id: string, version: string): string => {
  const name = `game:${id}:${version}`;
  if (!PINNED.test(name))
    throw new RangeError(
      `Can't name a pinned cache for game ${JSON.stringify(id)} at version ${JSON.stringify(version)}.`,
    );
  return name;
};

/** The game and version a pinned cache holds, or null for any other cache. */
export const parsePinnedCacheName = (name: string): { readonly id: string; readonly version: string } | null => {
  const match = PINNED.exec(name);
  return match === null ? null : { id: match[1] ?? '', version: match[2] ?? '' };
};

/** Every cache this site's PWA may create; the kill switch deletes them all. */
export const isPwaCache = (name: string): boolean =>
  name.startsWith(`${PRECACHE_PREFIX}-`) ||
  name.startsWith('recent:') ||
  name.startsWith('game:') ||
  name.startsWith('workbox-');

/** The service worker's own URL. Always served `no-cache`. */
export const SW_URL = '/sw.js';
/** The kill-switch flag file. Always served `no-cache`. */
export const CONTROL_URL = '/pwa-control.json';
/** The offline fallback page. */
export const OFFLINE_URL = '/offline';
/**
 * The attribute the worker adds to the <html> tag of a page it answers from a cache because
 * the network failed (offline-mark.ts). @joystyk/ui's tokens.css reads it to keep ad slots
 * collapsed from the first paint.
 */
export const OFFLINE_ATTRIBUTE = 'data-offline';
/** The web app manifest. */
export const WEB_MANIFEST_URL = '/manifest.webmanifest';
/**
 * Inside each pinned cache, the pin's own record (game name, version, asset list URL) lives
 * at this path. No request ever asks for it, so routing never serves it.
 */
export const PIN_RECORD_PATH = '/.joystyk-pin.json';

/** Messages between the page and the worker. */
export const MESSAGES = {
  /** Page → waiting worker: the player accepted the update. */
  skipWaiting: 'SKIP_WAITING',
  /** Page → worker: read the flag file now. */
  checkControl: 'CHECK_CONTROL',
  /** Page → worker, with a MessagePort: which release are you? */
  release: 'GET_RELEASE',
  /** Worker → pages: the kill switch fired; the worker unregistered and cleared its caches. */
  disabled: 'PWA_DISABLED',
} as const;
