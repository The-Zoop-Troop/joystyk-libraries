import { describe, expect, it } from 'vitest';
import { isPwaCache, parsePinnedCacheName, pinnedCacheName, recentCacheName } from './names.ts';
import { fileKind, routeFor, shouldOfferUpdate, type RouteInput } from './routing.ts';

const ORIGIN = 'https://joystyk.test';

const request = (path: string, overrides: Partial<RouteInput> = {}): RouteInput => ({
  method: 'GET',
  destination: '',
  mode: 'cors',
  url: new URL(path, ORIGIN),
  origin: ORIGIN,
  ...overrides,
});

describe('cache names', () => {
  it('name pinned caches by game and version, and read them back', () => {
    expect(pinnedCacheName('nim', '0.1.0')).toBe('game:nim:0.1.0');
    expect(parsePinnedCacheName('game:shift-23:1.4.0-beta.2')).toEqual({ id: 'shift-23', version: '1.4.0-beta.2' });
    expect(parsePinnedCacheName('recent:code:v1')).toBeNull();
    expect(parsePinnedCacheName('game:Bad_Id:1.0.0')).toBeNull();
    expect(parsePinnedCacheName('game:nim:')).toBeNull();
    expect(() => pinnedCacheName('Nim', '1.0.0')).toThrow(RangeError);
    expect(() => pinnedCacheName('nim', '1.0.0 beta')).toThrow(RangeError);
  });

  it('recognize every cache the PWA owns, and nothing else', () => {
    for (const name of [
      'joystyk-shell-v1-https://joystyk.test/',
      recentCacheName('audio'),
      'game:nim:0.1.0',
      'workbox-precache-v2-x',
    ]) {
      expect(isPwaCache(name), name).toBe(true);
    }
    expect(isPwaCache('my-other-cache')).toBe(false);
  });
});

describe('fileKind', () => {
  it('sorts files into the Tier 2 kinds by extension', () => {
    expect(fileKind('/assets/stage-abc12345.js')).toBe('code');
    expect(fileKind('/assets/board-abc12345.CSS')).toBe('code');
    expect(fileKind('/assets/felt-abc12345.webp')).toBe('art');
    expect(fileKind('/assets/roll-abc12345.ogg')).toBe('audio');
    expect(fileKind('/assets/rapier-abc12345.wasm')).toBe('wasm');
    expect(fileKind('/assets/inter-abc12345.woff2')).toBe('font');
    expect(fileKind('/assets/notes-abc12345.txt')).toBeNull();
    expect(fileKind('/assets.dir/README')).toBeNull();
  });
});

describe('routeFor', () => {
  it('sends pages network-first with offline fallbacks', () => {
    expect(routeFor(request('/games/nim', { mode: 'navigate', destination: 'document' }))).toEqual({
      _tag: 'Document',
    });
    expect(routeFor(request('/', { mode: 'navigate' }))).toEqual({ _tag: 'Document' });
  });

  it('sends catalog data network-first with the pinned copy as fallback', () => {
    expect(routeFor(request('/api/games/nim'))).toEqual({ _tag: 'Api' });
    expect(routeFor(request('/api/games'))).toEqual({ _tag: 'Api' });
  });

  it('serves hashed files from the precache, the pins, then their kind’s Tier 2 cache', () => {
    expect(routeFor(request('/assets/module-abc12345.js', { destination: 'script' }))).toEqual({
      _tag: 'Asset',
      kind: 'code',
    });
    expect(routeFor(request('/assets/hit-abc12345.mp3', { destination: 'audio' }))).toEqual({
      _tag: 'Asset',
      kind: 'audio',
    });
    expect(routeFor(request('/assets/inter-abc12345.woff2', { destination: 'font' }))).toEqual({ _tag: 'Pinned' });
    expect(routeFor(request('/games/nim/manifest.json'))).toEqual({ _tag: 'Pinned' });
  });

  it('leaves the worker, the flag file, other methods and other origins to the network', () => {
    expect(routeFor(request('/sw.js'))).toEqual({ _tag: 'Network' });
    expect(routeFor(request('/pwa-control.json'))).toEqual({ _tag: 'Network' });
    expect(routeFor(request('/healthz'))).toEqual({ _tag: 'Network' });
    // The room server's answers are live; Traefik routes them to another service.
    expect(routeFor(request('/api/rooms/K7M2QX'))).toEqual({ _tag: 'Network' });
    expect(routeFor(request('/ws'))).toEqual({ _tag: 'Network' });
    // Ads stay fresh and countable: the slot answer, the click notice (a navigation), the
    // beacon and the creative images are never kept by the worker.
    expect(routeFor(request('/api/ads/slot?slot=game-page&page=game&game=nim'))).toEqual({ _tag: 'Network' });
    expect(routeFor(request('/ads/click/3?slot=game-page', { mode: 'navigate', destination: 'document' }))).toEqual({
      _tag: 'Network',
    });
    expect(routeFor(request('/api/ads/impression?creative=3&slot=game-page', { method: 'POST' }))).toEqual({
      _tag: 'Network',
    });
    expect(routeFor(request(`/ads/creative/${'a'.repeat(64)}.webp`, { destination: 'image' }))).toEqual({
      _tag: 'Network',
    });
    expect(routeFor(request('/api/games', { method: 'POST' }))).toEqual({ _tag: 'Network' });
    expect(routeFor(request('https://ads.example/slot.js'))).toEqual({ _tag: 'Network' });
    expect(routeFor(request('https://ads.example/', { mode: 'navigate' }))).toEqual({ _tag: 'Network' });
  });
});

describe('shouldOfferUpdate (Rule 2)', () => {
  it('offers an update only when one is ready, the page is at a safe point, and the player did not say later', () => {
    for (const ready of [true, false]) {
      for (const safe of [true, false]) {
        for (const dismissed of [true, false]) {
          expect(shouldOfferUpdate({ ready, safe, dismissed }), JSON.stringify({ ready, safe, dismissed })).toBe(
            ready && safe && !dismissed,
          );
        }
      }
    }
  });
});

it('lets explicit pin revalidation bypass cached manifests and page fetches', () => {
  for (const path of ['/games/nim/manifest.json', '/games/nim', '/api/games/nim'])
    expect(routeFor(request(path, { cache: 'no-cache' }))).toEqual({ _tag: 'Network' });
});
