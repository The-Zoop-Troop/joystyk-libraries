// Pinning against real Cache Storage in Chromium, with a fake server.
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameAssetManifest } from '../asset-manifest.ts';
import { pinnedGames, pinStatus, unpinGame } from './pinned.ts';
import { pinGame, refreshPinnedGames, type PinPorts } from './pins.ts';

const ASSETS = '/games/nim/manifest.json';

type Site = { files: Record<string, string>; manifest: GameAssetManifest; page: string; offline?: boolean };

const manifestFor = (version: string, files: Record<string, string>): GameAssetManifest => {
  const list = Object.entries(files).map(([url, body]) => ({
    url,
    size: body.length,
    kind: 'code' as const,
    scope: 'game' as const,
  }));
  return {
    schemaVersion: 1,
    id: 'nim',
    name: 'Nim',
    version,
    rulesVersion: 1,
    saveVersion: 1,
    release: `release-${version}`,
    page: '/games/nim',
    documents: ['/games/nim', '/api/games/nim'],
    files: list,
    totalBytes: list.reduce((sum, file) => sum + file.size, 0),
  };
};

const pageFor = (entry: string) => `<!doctype html><script type="module" src="${entry}"></script><h1>Nim</h1>`;

function ports(site: Site, log: { persisted: number; fetched: string[] }): PinPorts {
  return {
    caches,
    origin: location.origin,
    persist: async () => {
      log.persisted += 1;
      return 'persisted';
    },
    fetch: async (url) => {
      if (site.offline === true) throw new TypeError('Failed to fetch');
      log.fetched.push(url);
      if (url === ASSETS) return Response.json(site.manifest);
      if (url === '/games/nim') return new Response(site.page, { headers: { 'content-type': 'text/html' } });
      if (url === '/api/games/nim') return Response.json({ id: 'nim' });
      const body = site.files[url];
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body);
    },
  };
}

const pathsIn = async (name: string) =>
  (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname).sort();

beforeEach(async () => {
  for (const name of await caches.keys()) await caches.delete(name);
});

describe('pinGame', () => {
  it('caches every file, the page, its data and its record, and asks for persistence on the first pin only', async () => {
    const files = { '/assets/entry-A.js': 'entry a', '/assets/module-N.js': 'nim' };
    const site: Site = { files, manifest: manifestFor('0.1.0', files), page: pageFor('/assets/entry-A.js') };
    const log = { persisted: 0, fetched: [] as string[] };
    const result = await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, log));
    expect(result).toMatchObject({
      ok: true,
      value: { record: { id: 'nim', version: '0.1.0', totalBytes: 10 }, persisted: 'persisted' },
    });
    expect(await caches.keys()).toEqual(['game:nim:0.1.0']);
    expect(await pathsIn('game:nim:0.1.0')).toEqual([
      '/.joystyk-pin.json',
      '/api/games/nim',
      '/assets/entry-A.js',
      '/assets/module-N.js',
      '/games/nim',
      '/games/nim/manifest.json',
    ]);
    expect(await (await caches.match('/games/nim'))?.text()).toBe(site.page);
    expect((await pinnedGames()).map((r) => r.name)).toEqual(['Nim']);
    expect(await pinStatus('nim')).toMatchObject({ assets: ASSETS, page: '/games/nim' });

    // Pinning again (a refresh) never asks again.
    await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, log));
    expect(log.persisted).toBe(1);
  });

  it('refreshes a pin in place: new files in, stale files out, unchanged files not downloaded again', async () => {
    const before = { '/assets/entry-A.js': 'entry a', '/assets/module-N.js': 'nim' };
    const site: Site = { files: before, manifest: manifestFor('0.1.0', before), page: pageFor('/assets/entry-A.js') };
    await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }));

    const after = { '/assets/entry-B.js': 'entry b', '/assets/module-N.js': 'nim' };
    Object.assign(site, { files: after, manifest: manifestFor('0.1.0', after), page: pageFor('/assets/entry-B.js') });
    const log = { persisted: 0, fetched: [] as string[] };
    expect(await refreshPinnedGames(ports(site, log))).toEqual({ refreshed: ['nim'], failed: [] });
    expect(log.fetched).not.toContain('/assets/module-N.js');
    const paths = await pathsIn('game:nim:0.1.0');
    expect(paths).toContain('/assets/entry-B.js');
    expect(paths).not.toContain('/assets/entry-A.js');
  });

  it('moves a new game version into its own cache and removes the old build after', async () => {
    const files = { '/assets/entry-A.js': 'entry a', '/assets/module-N.js': 'nim' };
    const site: Site = { files, manifest: manifestFor('0.1.0', files), page: pageFor('/assets/entry-A.js') };
    await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }));
    const next = { '/assets/entry-A.js': 'entry a', '/assets/module-M.js': 'nim 2' };
    Object.assign(site, { files: next, manifest: manifestFor('0.2.0', next) });
    const result = await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }));
    expect(result.ok).toBe(true);
    expect(await caches.keys()).toEqual(['game:nim:0.2.0']);
    expect((await pinStatus('nim'))?.version).toBe('0.2.0');
  });

  it('refuses a page that names files the manifest lacks, keeping nothing', async () => {
    const files = { '/assets/entry-A.js': 'entry a' };
    const site: Site = { files, manifest: manifestFor('0.1.0', files), page: pageFor('/assets/entry-NEW.js') };
    const result = await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }));
    expect(result).toMatchObject({ ok: false, error: { code: 'Incomplete' } });
    expect(await caches.keys()).toEqual([]);
  });

  it('says so plainly when offline, when a file is missing, or when the manifest is bad', async () => {
    const files = { '/assets/entry-A.js': 'entry a' };
    const site: Site = {
      files,
      manifest: manifestFor('0.1.0', files),
      page: pageFor('/assets/entry-A.js'),
      offline: true,
    };
    const offline = await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }));
    expect(offline).toMatchObject({
      ok: false,
      error: { code: 'Offline', message: "You're offline. Connect to the internet, then try again." },
    });

    site.offline = false;
    site.manifest = manifestFor('0.1.0', { '/assets/gone-G.js': 'x' });
    expect(await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }))).toMatchObject({
      ok: false,
      error: { code: 'Incomplete' },
    });

    site.manifest = { ...manifestFor('0.1.0', files), id: 'greed' };
    expect(await pinGame({ gameId: 'nim', assets: ASSETS }, ports(site, { persisted: 0, fetched: [] }))).toMatchObject({
      ok: false,
      error: { code: 'Invalid' },
    });
    expect(await caches.keys()).toEqual([]);
  });
});

describe('unpinGame', () => {
  it('removes every build of the game and nothing else', async () => {
    await (await caches.open('game:nim:0.1.0')).put('/x', new Response('x'));
    await (await caches.open('game:nim:0.2.0')).put('/x', new Response('x'));
    await (await caches.open('game:nim-two:1.0.0')).put('/x', new Response('x'));
    await unpinGame('nim');
    expect(await caches.keys()).toEqual(['game:nim-two:1.0.0']);
    // A cache without a valid record isn't listed as a pin.
    expect(await pinnedGames()).toEqual([]);
  });
});
