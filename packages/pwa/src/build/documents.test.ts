import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest } from '../asset-manifest.ts';
import {
  gameAssetManifest,
  injectManifest,
  offlinePage,
  precacheEntries,
  webManifest,
  type BuildGame,
} from './documents.ts';
import { crc32, encodePng, iconPng, iconSvg, rasterize, iconShapes } from './icons.ts';

const NIM: BuildGame = {
  id: 'nim',
  name: 'Nim',
  version: '0.1.0',
  rulesVersion: 1,
  saveVersion: 1,
  root: '/repo/games/nim/src',
  assets: '/games/nim/manifest.json',
  page: '/games/nim',
  data: ['/api/games/nim'],
};

describe('gameAssetManifest', () => {
  it('lists the shell and the game’s files with sizes, kinds and versions, and decodes', () => {
    const sizes: Record<string, number> = {
      'assets/entry-E.js': 100,
      'assets/stage-S.js': 30,
      'assets/module-N.js': 20,
      'assets/stones-N.webp': 7,
    };
    const manifest = gameAssetManifest(
      NIM,
      'r1',
      new Set(['assets/stage-S.js', 'assets/entry-E.js']),
      new Set(['assets/stones-N.webp', 'assets/module-N.js']),
      (file) => sizes[file] ?? 0,
    );
    expect(manifest).toMatchObject({
      id: 'nim',
      version: '0.1.0',
      rulesVersion: 1,
      saveVersion: 1,
      release: 'r1',
      page: '/games/nim',
      documents: ['/games/nim', '/api/games/nim'],
      totalBytes: 157,
    });
    expect(manifest.files).toEqual([
      { url: '/assets/entry-E.js', size: 100, kind: 'code', scope: 'shell' },
      { url: '/assets/stage-S.js', size: 30, kind: 'code', scope: 'shell' },
      { url: '/assets/module-N.js', size: 20, kind: 'code', scope: 'game' },
      { url: '/assets/stones-N.webp', size: 7, kind: 'art', scope: 'game' },
    ]);
    expect(parseAssetManifest(JSON.parse(JSON.stringify(manifest))).ok).toBe(true);
  });
});

describe('precacheEntries', () => {
  it('gives hashed files no revision and rendered pages a hash of their bytes', () => {
    const entries = precacheEntries(
      [
        { url: '/', hashed: false, body: '<h1>Games</h1>' },
        { url: '/assets/entry-E.js', hashed: true, file: 'assets/entry-E.js' },
        { url: '/assets/entry-E.js', hashed: true, file: 'assets/entry-E.js' },
      ],
      () => true,
    );
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.url === '/assets/entry-E.js')?.revision).toBeNull();
    const before = entries.find((e) => e.url === '/')?.revision;
    const after = precacheEntries([{ url: '/', hashed: false, body: '<h1>Games!</h1>' }], () => true)[0]?.revision;
    expect(before).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(after).not.toBe(before);
  });

  it('fails the build when any entry is missing, naming each one', () => {
    expect(() =>
      precacheEntries(
        [
          { url: '/assets/gone-G.js', hashed: true, file: 'assets/gone-G.js' },
          { url: '/offline', hashed: false, body: '' },
          { url: '/assets/here-H.js', hashed: true, file: 'assets/here-H.js' },
        ],
        (file) => file === 'assets/here-H.js',
      ),
    ).toThrow(/\/assets\/gone-G\.js, \/offline/);
  });
});

describe('injectManifest', () => {
  it('replaces the injection point exactly once', () => {
    expect(injectManifest('precache(self.__WB_MANIFEST);', [{ url: '/', revision: 'x' }])).toBe(
      'precache([{"url":"/","revision":"x"}]);',
    );
    expect(() => injectManifest('precache([]);', [])).toThrow(/exactly once/);
    expect(() => injectManifest('a(self.__WB_MANIFEST);b(self.__WB_MANIFEST)', [])).toThrow(/exactly once/);
  });
});

describe('the web app manifest and the offline page', () => {
  it('describe an installable Joystyk with any and maskable icons', () => {
    const manifest = webManifest({
      svg: '/assets/icon-A.svg',
      png192: '/assets/icon-192-B.png',
      png512: '/assets/icon-512-C.png',
      maskable512: '/assets/icon-maskable-512-D.png',
    });
    expect(manifest).toMatchObject({
      name: 'Joystyk',
      short_name: 'Joystyk',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      theme_color: '#1b1530',
    });
    expect(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
      'any any',
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
  });

  it('give the offline page its hashed script and stylesheet and nothing inline', () => {
    const html = offlinePage({ css: '/assets/offline-A.css', js: '/assets/offline-B.js', icon: '/assets/icon-C.svg' });
    expect(html).toContain('<link rel="stylesheet" href="/assets/offline-A.css">');
    expect(html).toContain('<script defer src="/assets/offline-B.js"></script>');
    expect(html).not.toMatch(/<style|<script>|style="/);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });
});

describe('the icons', () => {
  it('compute the PNG CRC correctly', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('encode a valid RGBA PNG of the requested size', () => {
    const png = iconPng(48);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(48);
    expect(png.readUInt32BE(20)).toBe(48);
    const idat = png.indexOf('IDAT');
    const length = png.readUInt32BE(idat - 4);
    expect(inflateSync(png.subarray(idat + 4, idat + 4 + length))).toHaveLength((48 * 4 + 1) * 48);
    expect(encodePng(new Uint8Array(4), 1, 1).subarray(-8, -4).toString('ascii')).toBe('IEND');
  });

  it('round the tile’s corners, but fill a maskable icon to the edge', () => {
    const at = (pixels: Uint8Array, size: number, x: number, y: number) => [
      ...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
    ];
    const plain = rasterize(iconShapes(false), 64);
    expect(at(plain, 64, 0, 0)[3]).toBe(0);
    expect(at(plain, 64, 32, 2)).toEqual([0x1b, 0x15, 0x30, 255]);
    const maskable = rasterize(iconShapes(true), 64);
    expect(at(maskable, 64, 0, 0)).toEqual([0x1b, 0x15, 0x30, 255]);
    // The ball top: the joystick's pink.
    expect(at(plain, 64, 36, 18)).toEqual([0xff, 0x4f, 0xa8, 255]);
  });

  it('draw the same shapes as SVG', () => {
    const svg = iconSvg();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 32 32">/);
    expect(svg.match(/<(rect|circle) /g)).toHaveLength(iconShapes(false).length);
  });
});
