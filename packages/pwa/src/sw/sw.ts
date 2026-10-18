// The service worker, built from Workbox modules and bundled into one classic /sw.js by
// '@joystyk/pwa/build', which also injects the precache list and the release ID. The
// decisions live in ../routing.ts (pure and tested in Node); this file wires them to caches.
// The design is offline-and-updates.md; the blog's worker (references/pwa-offline.md) is the
// model, including its waitUntil fix.
//
//   Tier 1  precache: the shell, the launcher, the offline page, icons. Replaced each release.
//   Tier 2  recent: capped stale-while-revalidate caches per kind (code, art, audio, wasm).
//   Tier 3  pinned: `game:<id>:<version>` caches the page fills; never evicted here.
//
// A page answered from a cache because the network failed is marked `data-offline` on its
// <html> tag (../offline-mark.ts).
//
// It never activates itself: a new worker waits until the page, at a safe point, posts
// SKIP_WAITING (Rule 2). A `disabled` flag file unregisters it and clears its caches (Rule 5).
import { setCacheNameDetails } from 'workbox-core';
import type { RouteHandlerCallbackOptions } from 'workbox-core/types.js';
import { ExpirationPlugin } from 'workbox-expiration';
import { cleanupOutdatedCaches, matchPrecache, precache, type PrecacheEntry } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate, type Strategy } from 'workbox-strategies';
import { isDisabled, parseControl } from '../control.ts';
import {
  CONTROL_URL,
  isPwaCache,
  MESSAGES,
  OFFLINE_URL,
  parsePinnedCacheName,
  PRECACHE_NAME,
  PRECACHE_PREFIX,
  RECENT_KINDS,
  recentCacheName,
  type RecentKind,
} from '../names.ts';
import { markOfflineResponse } from '../offline-mark.ts';
import { pinnedGames } from '../client/pinned.ts';
import { withoutPreloadResponse } from '../preloads.ts';
import { RECENT_LIMITS, routeFor, type Route } from '../routing.ts';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };
/** The platform release this worker belongs to; replaced at build time. */
declare const __JOYSTYK_RELEASE__: string;

const RELEASE = __JOYSTYK_RELEASE__;

// --- Tier 1 -------------------------------------------------------------------------------------

setCacheNameDetails({ prefix: PRECACHE_PREFIX, precache: PRECACHE_NAME, suffix: 'v1' });
// Injected by the build from the built output. If any entry fails to download, the install
// fails and the previous worker stays in charge; the build checks every entry exists first.
precache(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// --- Tier 2 -------------------------------------------------------------------------------------

const recent = Object.fromEntries(
  RECENT_KINDS.map((kind) => [
    kind,
    new StaleWhileRevalidate({
      cacheName: recentCacheName(kind),
      plugins: [new ExpirationPlugin({ ...RECENT_LIMITS[kind], purgeOnQuotaError: true })],
    }),
  ]),
) as Record<RecentKind, StaleWhileRevalidate>;

/**
 * The blog's fix: a strategy's background work (the revalidating fetch, the cache write and
 * the expiration that follows) is only surfaced through `handleAll()`'s second promise.
 * Without handing it to the fetch event's `waitUntil`, the browser may stop the worker
 * mid-write, and the caps stop holding.
 */
const withExtendedLifetime = (strategy: Strategy, event: ExtendableEvent, request: Request): Promise<Response> => {
  const [response, done] = strategy.handleAll({ event, request });
  event.waitUntil(done);
  return response;
};

// --- Tier 3 -------------------------------------------------------------------------------------

/** A pinned game's copy of `request`, from any `game:<id>:<version>` cache. */
const matchPinned = async (request: Request | string, options?: CacheQueryOptions): Promise<Response | undefined> => {
  for (const name of await caches.keys()) {
    if (parsePinnedCacheName(name) === null) continue;
    const hit = await (await caches.open(name)).match(request, options);
    if (hit !== undefined) return hit;
  }
  return undefined;
};

// --- Routes -------------------------------------------------------------------------------------

/** Wait this long for the network before a page falls back to a cached copy, when one exists. */
const NETWORK_TIMEOUT_MS = 8_000;

const networkFirst = async (
  request: Request,
  fallback: () => Promise<Response | undefined>,
): Promise<Response | undefined> => {
  const network = fetch(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response | undefined>((resolve) => {
    timer = setTimeout(() => void fallback().then(resolve, () => resolve(undefined)), NETWORK_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([network, timeout])) ?? (await network);
  } catch {
    return fallback();
  } finally {
    clearTimeout(timer);
  }
};

const offlineJson = (): Response =>
  new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const handle = async (
  route: Route,
  { event, request, url }: RouteHandlerCallbackOptions & { request: Request },
): Promise<Response> => {
  switch (route._tag) {
    case 'Document': {
      // Pages are never stale: a fresh page names this release's hashed files. Offline, a
      // pinned game's page, the precached shell, or the offline page listing what plays,
      // marked as served offline so its CSS reserves no ad space at first paint.
      const response = await networkFirst(request, async () => {
        const cached =
          (await matchPinned(request, { ignoreSearch: true })) ??
          (await matchPrecache(url.pathname)) ??
          (await matchPrecache(OFFLINE_URL));
        if (cached === undefined) return undefined;
        const pins = await pinnedGames({ caches, origin: self.location.origin }).catch(() => []);
        return markOfflineResponse(
          cached,
          pins.map((pin) => pin.id),
        );
      });
      return response === undefined ? Response.error() : withoutPreloadResponse(response);
    }
    case 'Api':
      return (await networkFirst(request, () => matchPinned(request))) ?? offlineJson();
    case 'Asset':
      return (
        (await matchPrecache(request)) ??
        (await matchPinned(request)) ??
        withExtendedLifetime(recent[route.kind], event, request)
      );
    case 'Pinned':
      return (await matchPrecache(request)) ?? (await matchPinned(request)) ?? fetch(request);
    case 'Network':
      return fetch(request);
  }
};

registerRoute(
  ({ request, url }) =>
    routeFor({
      method: request.method,
      cache: request.cache,
      pinRefresh: request.headers.get('X-Joystyk-Pin-Refresh') === '1',
      destination: request.destination,
      mode: request.mode,
      url,
      origin: self.location.origin,
    })._tag !== 'Network',
  (options) => {
    const request = options.request instanceof Request ? options.request : new Request(options.request);
    const route = routeFor({
      method: request.method,
      cache: request.cache,
      pinRefresh: request.headers.get('X-Joystyk-Pin-Refresh') === '1',
      destination: request.destination,
      mode: request.mode,
      url: options.url,
      origin: self.location.origin,
    });
    return handle(route, { ...options, request });
  },
);

// --- The kill switch (Rule 5) -------------------------------------------------------------------

/** How often page loads may make the worker reread the flag file. */
const CONTROL_INTERVAL_MS = 5 * 60_000;
let lastControlCheck = 0;

/** Unregisters this worker, deletes every PWA cache and tells open pages. Saves are untouched. */
const disable = async (): Promise<void> => {
  await self.registration.unregister();
  const names = (await caches.keys()).filter(isPwaCache);
  await Promise.all(names.map((name) => caches.delete(name)));
  for (const client of await self.clients.matchAll({ includeUncontrolled: true }))
    client.postMessage({ type: MESSAGES.disabled });
};

/** Reads the flag file; true when it disabled the worker. A failed read changes nothing. */
const checkControl = async (force: boolean): Promise<boolean> => {
  const now = Date.now();
  if (!force && now - lastControlCheck < CONTROL_INTERVAL_MS) return false;
  lastControlCheck = now;
  let control = null;
  try {
    const response = await fetch(CONTROL_URL, { cache: 'no-store', credentials: 'omit' });
    if (response.ok) control = parseControl(await response.json());
  } catch {
    return false;
  }
  if (!isDisabled(control)) return false;
  await disable();
  return true;
};

self.addEventListener('install', (event) => {
  // A worker installing while the switch is on must never activate.
  event.waitUntil(
    checkControl(true).then((disabled) => {
      if (disabled) throw new Error('The PWA is disabled by /pwa-control.json.');
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(checkControl(true));
});

// Beside the router's listener: it never answers, only extends navigations to reread the flag.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.waitUntil(checkControl(false));
});

// --- Updates (Rule 2) ---------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (type === MESSAGES.skipWaiting) void self.skipWaiting();
  else if (type === MESSAGES.checkControl) event.waitUntil(checkControl(true));
  else if (type === MESSAGES.release) event.ports[0]?.postMessage({ release: RELEASE });
});
