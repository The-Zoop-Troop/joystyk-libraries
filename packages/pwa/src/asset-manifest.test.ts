import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  parseAssetManifest,
  planPin,
  referencedAssets,
  type GameAssetManifest,
} from './asset-manifest.ts';
import { isDisabled, parseControl } from './control.ts';
import { parsePinRecord } from './pin-record.ts';

const manifest = (overrides: Partial<GameAssetManifest> = {}): GameAssetManifest => {
  const files = overrides.files ?? [
    { url: '/assets/entry-client-aaaa1111.js', size: 100, kind: 'code', scope: 'shell' },
    { url: '/assets/module-bbbb2222.js', size: 40, kind: 'code', scope: 'game' },
  ];
  return {
    schemaVersion: 1,
    id: 'nim',
    name: 'Nim',
    version: '0.1.0',
    rulesVersion: 1,
    saveVersion: 1,
    release: '2026-10-08-abc',
    page: '/games/nim',
    documents: ['/games/nim', '/api/games/nim'],
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    ...overrides,
    files,
  };
};

describe('parseAssetManifest', () => {
  it('accepts what the build writes', () => {
    const value = manifest();
    expect(parseAssetManifest(JSON.parse(JSON.stringify(value)))).toEqual({ ok: true, value });
  });

  it('rejects files outside /assets/, wrong totals and unknown versions', () => {
    const outside = parseAssetManifest({
      ...manifest(),
      files: [{ url: 'https://cdn.example/x.js', size: 1, kind: 'code', scope: 'game' }],
      totalBytes: 1,
    });
    expect(outside.ok).toBe(false);
    const climbing = parseAssetManifest({
      ...manifest(),
      files: [{ url: '/assets/../secret', size: 1, kind: 'code', scope: 'game' }],
      totalBytes: 1,
    });
    expect(climbing.ok).toBe(false);
    const total = parseAssetManifest({ ...manifest(), totalBytes: 1 });
    expect(total.ok || total.error.join()).toMatch(/totalBytes/);
    expect(parseAssetManifest({ ...manifest(), schemaVersion: 2 }).ok).toBe(false);
    expect(parseAssetManifest({ ...manifest(), id: 'Nim' }).ok).toBe(false);
    expect(parseAssetManifest(null).ok).toBe(false);
  });
});

describe('planPin', () => {
  const RECORD = '/.joystyk-pin.json';

  it('fetches every file for a first pin', () => {
    expect(planPin(manifest(), '/games/nim/manifest.json', 'game:nim:0.1.0', [], RECORD)).toEqual({
      target: 'game:nim:0.1.0',
      fetch: ['/assets/entry-client-aaaa1111.js', '/assets/module-bbbb2222.js'],
      documents: ['/games/nim', '/api/games/nim', '/games/nim/manifest.json'],
      remove: [],
      dropCaches: [],
    });
  });

  it('refreshes a pin in place: keeps hashed files it has, adds new ones, drops stale ones last', () => {
    const next = manifest({
      files: [
        { url: '/assets/entry-client-cccc3333.js', size: 120, kind: 'code', scope: 'shell' },
        { url: '/assets/module-bbbb2222.js', size: 40, kind: 'code', scope: 'game' },
      ],
    });
    const held = [
      '/assets/entry-client-aaaa1111.js',
      '/assets/module-bbbb2222.js',
      '/games/nim',
      '/api/games/nim',
      '/games/nim/manifest.json',
      RECORD,
    ];
    expect(
      planPin(
        next,
        '/games/nim/manifest.json',
        'game:nim:0.1.0',
        [{ cacheName: 'game:nim:0.1.0', paths: held }],
        RECORD,
      ),
    ).toMatchObject({
      fetch: ['/assets/entry-client-cccc3333.js'],
      remove: ['/assets/entry-client-aaaa1111.js'],
      dropCaches: [],
    });
  });

  it('moves a new game version to a new cache and drops the old one after', () => {
    const plan = planPin(
      manifest({ version: '0.2.0' }),
      '/games/nim/manifest.json',
      'game:nim:0.2.0',
      [{ cacheName: 'game:nim:0.1.0', paths: ['/assets/module-bbbb2222.js'] }],
      RECORD,
    );
    expect(plan.fetch).toHaveLength(2);
    expect(plan.dropCaches).toEqual(['game:nim:0.1.0']);
  });
});

describe('referencedAssets', () => {
  it('finds the hashed files a page names in src and href', () => {
    const html = `<link rel="modulepreload" href="/assets/render-aaaa1111.js"><script type="module" src="/assets/entry-client-bbbb2222.js"></script>
      <a href="/games/nim">Nim</a><img src=/assets/tile-cccc3333.png alt="">`;
    expect(referencedAssets(html)).toEqual([
      '/assets/entry-client-bbbb2222.js',
      '/assets/render-aaaa1111.js',
      '/assets/tile-cccc3333.png',
    ]);
  });
});

describe('formatBytes', () => {
  it('reads like a file size', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(222_050)).toBe('217 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('the flag file and pin records', () => {
  it('parse the kill switch strictly; anything unreadable is no instruction', () => {
    expect(parseControl({ schemaVersion: 1, serviceWorker: 'disabled' })).toEqual({
      schemaVersion: 1,
      serviceWorker: 'disabled',
    });
    expect(isDisabled(parseControl({ schemaVersion: 1, serviceWorker: 'disabled' }))).toBe(true);
    expect(isDisabled(parseControl({ schemaVersion: 1, serviceWorker: 'enabled' }))).toBe(false);
    expect(parseControl({ schemaVersion: 1, serviceWorker: 'off' })).toBeNull();
    expect(parseControl({ serviceWorker: 'disabled' })).toBeNull();
    expect(parseControl('disabled')).toBeNull();
    expect(isDisabled(null)).toBe(false);
  });

  it('decode a pin record and refuse a damaged one', () => {
    const record = {
      id: 'nim',
      name: 'Nim',
      version: '0.1.0',
      release: 'r1',
      page: '/games/nim',
      assets: '/games/nim/manifest.json',
      totalBytes: 10,
    };
    expect(parsePinRecord({ ...record, extra: true })).toEqual(record);
    expect(parsePinRecord({ ...record, page: 'https://evil.example/' })).toBeNull();
    expect(parsePinRecord({ ...record, totalBytes: -1 })).toBeNull();
    expect(parsePinRecord({ ...record, id: '' })).toBeNull();
  });
});
