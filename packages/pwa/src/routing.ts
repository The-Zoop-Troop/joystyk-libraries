// Which tier answers a request. Pure, so the service worker's routing decisions are tested
// in Node; sw/sw.ts wires each answer to a Workbox strategy.
import type { RecentKind } from './names.ts';

/** The hashed, immutable files the site serves (apps/site's assets volume). */
export const ASSETS_PREFIX = '/assets/';

const EXTENSION_KINDS: Readonly<Record<string, RecentKind | 'font'>> = {
  js: 'code',
  mjs: 'code',
  css: 'code',
  json: 'code',
  map: 'code',
  png: 'art',
  jpg: 'art',
  jpeg: 'art',
  webp: 'art',
  avif: 'art',
  gif: 'art',
  svg: 'art',
  ktx2: 'art',
  glb: 'art',
  gltf: 'art',
  mp3: 'audio',
  ogg: 'audio',
  opus: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  wasm: 'wasm',
  woff2: 'font',
  woff: 'font',
};

/** The kind of a file by its extension: a Tier 2 kind, `font`, or null for anything else. */
export const fileKind = (pathname: string): RecentKind | 'font' | null => {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1 || dot < pathname.lastIndexOf('/')) return null;
  return EXTENSION_KINDS[pathname.slice(dot + 1).toLowerCase()] ?? null;
};

/** Tier 2 budgets: entries per kind and their age limit. Least recently used goes first. */
export const RECENT_LIMITS: Readonly<
  Record<RecentKind, { readonly maxEntries: number; readonly maxAgeSeconds: number }>
> = {
  code: { maxEntries: 120, maxAgeSeconds: 30 * 24 * 60 * 60 },
  art: { maxEntries: 80, maxAgeSeconds: 30 * 24 * 60 * 60 },
  audio: { maxEntries: 40, maxAgeSeconds: 30 * 24 * 60 * 60 },
  wasm: { maxEntries: 6, maxAgeSeconds: 30 * 24 * 60 * 60 },
};

/** How the worker answers one request. */
export type Route =
  /** Not ours: cross-origin, not a GET, the worker's own files or the flag file. The network answers. */
  | { readonly _tag: 'Network' }
  /** A page. Network first, then a pinned copy, then the precached shell, then the offline page. */
  | { readonly _tag: 'Document' }
  /** Catalog data for client-side navigation. Network first, then a pinned copy. */
  | { readonly _tag: 'Api' }
  /** A hashed file. The precache, then the pinned caches, then this kind's Tier 2 cache. */
  | { readonly _tag: 'Asset'; readonly kind: RecentKind }
  /** A hashed font or another file with no Tier 2 cache: the precache or a pin, else the network. */
  | { readonly _tag: 'Pinned' };

export type RouteInput = {
  readonly method: string;
  /** Explicit revalidation (pin refreshes) must reach the network, bypassing Cache Storage. */
  readonly cache?: RequestCache;
  readonly pinRefresh?: boolean;
  /** `Request.destination`: 'document' for navigations. */
  readonly destination: string;
  /** `Request.mode`: 'navigate' for navigations. */
  readonly mode: string;
  readonly url: URL;
  /** The worker's origin. */
  readonly origin: string;
};

const NEVER_CACHED = new Set(['/sw.js', '/pwa-control.json', '/healthz']);

export const routeFor = (request: RouteInput): Route => {
  const { url } = request;
  if (request.pinRefresh === true || (request.mode !== 'navigate' && request.cache === 'no-cache'))
    return { _tag: 'Network' };
  if (request.method !== 'GET' || url.origin !== request.origin || NEVER_CACHED.has(url.pathname))
    return { _tag: 'Network' };
  // The room server (same host, routed by Traefik) answers live: never from a cache.
  if (url.pathname === '/ws' || url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/'))
    return { _tag: 'Network' };
  // Ads (monetization.md): the slot answer stays fresh by its own short Cache-Control, the click
  // notice and the beacon must reach the server to count, and a creative is only worth
  // showing online (slots collapse offline). The worker keeps none of them.
  if (url.pathname.startsWith('/api/ads/') || url.pathname.startsWith('/ads/')) return { _tag: 'Network' };
  if (request.mode === 'navigate' || request.destination === 'document') return { _tag: 'Document' };
  if (url.pathname === '/api/games' || url.pathname.startsWith('/api/games/')) return { _tag: 'Api' };
  if (url.pathname.startsWith(ASSETS_PREFIX)) {
    const kind = fileKind(url.pathname);
    return kind === null || kind === 'font' ? { _tag: 'Pinned' } : { _tag: 'Asset', kind };
  }
  // Per-game asset lists, the web manifest, the favicon: whatever a pin or the precache holds.
  return { _tag: 'Pinned' };
};

/** Whether a page's updates may be offered now (Rule 2): only at a safe point, never in play. */
export type PromptInput = {
  /** A new worker is installed and waiting, or another tab already switched workers. */
  readonly ready: boolean;
  /** The launcher's last safe-point report; true on pages without a launcher. */
  readonly safe: boolean;
  /** The player chose "Later" for this update. */
  readonly dismissed: boolean;
};

export const shouldOfferUpdate = (input: PromptInput): boolean => input.ready && input.safe && !input.dismissed;
