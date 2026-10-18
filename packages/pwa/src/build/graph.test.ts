// The shell/game split against a manifest shaped like the site's real build, including the
// bundler's habit of putting shared code into one game's chunk.
import { describe, expect, it } from 'vitest';
import { entryKey, fileSets, reachable, type ViteManifest } from './graph.ts';

const ROOT = '/repo/apps/site';

const MANIFEST: ViteManifest = {
  'src/entry-client.ts': {
    file: 'assets/entry-client-E.js',
    src: 'src/entry-client.ts',
    isEntry: true,
    imports: ['_render-R.js'],
    css: ['assets/entry-client-E.css'],
    dynamicImports: [
      '../../packages/launcher/src/browser/stage.ts',
      '../../games/nim/src/ui/module.ts',
      '../../packages/launcher/src/fixture/index.ts',
    ],
  },
  '_render-R.js': { file: 'assets/render-R.js' },
  '../../packages/launcher/src/browser/stage.ts': {
    file: 'assets/stage-S.js',
    src: '../../packages/launcher/src/browser/stage.ts',
    isDynamicEntry: true,
    imports: ['src/entry-client.ts'],
  },
  '../../games/nim/src/ui/module.ts': {
    file: 'assets/module-N.js',
    src: '../../games/nim/src/ui/module.ts',
    isDynamicEntry: true,
    imports: ['_render-R.js', 'src/entry-client.ts'],
    assets: ['assets/stones-N.webp'],
  },
  '../../packages/launcher/src/fixture/index.ts': {
    file: 'assets/fixture-F.js',
    src: '../../packages/launcher/src/fixture/index.ts',
    isDynamicEntry: true,
    imports: ['src/entry-client.ts'],
    dynamicImports: ['../../packages/launcher/src/fixture/module.ts'],
  },
  '../../packages/launcher/src/fixture/module.ts': {
    file: 'assets/module-T.js',
    src: '../../packages/launcher/src/fixture/module.ts',
    isDynamicEntry: true,
    // Shared code landed in Nim's chunk: a static import, so Tally needs it too.
    imports: ['src/entry-client.ts', '../../games/nim/src/ui/module.ts'],
  },
};

const GAMES = [
  { id: 'nim', root: '/repo/games/nim/src' },
  { id: 'test-tally', root: '/repo/packages/launcher/src/fixture' },
];

describe('fileSets', () => {
  it('keeps games out of the shell, but keeps the launcher’s lazy code in it', () => {
    const sets = fileSets(MANIFEST, GAMES, ROOT);
    expect([...sets.shell].sort()).toEqual([
      'assets/entry-client-E.css',
      'assets/entry-client-E.js',
      'assets/render-R.js',
      'assets/stage-S.js',
    ]);
  });

  it('gives each game its own code and assets, following static imports into another game’s chunk', () => {
    const sets = fileSets(MANIFEST, GAMES, ROOT);
    expect([...(sets.games.get('nim') ?? [])].sort()).toEqual(['assets/module-N.js', 'assets/stones-N.webp']);
    expect([...(sets.games.get('test-tally') ?? [])].sort()).toEqual([
      'assets/fixture-F.js',
      'assets/module-N.js',
      'assets/module-T.js',
      'assets/stones-N.webp',
    ]);
  });

  it('keeps an unlisted game’s code out of the shell without describing it', () => {
    const sets = fileSets(MANIFEST, [GAMES[0] ?? { id: '', root: '' }], ROOT, [GAMES[1] ?? { id: '', root: '' }]);
    expect(sets.shell.has('assets/fixture-F.js')).toBe(false);
    expect([...sets.games.keys()]).toEqual(['nim']);
  });

  it('refuses a game whose code it can’t find, and a manifest with a dangling key', () => {
    expect(() => fileSets(MANIFEST, [...GAMES, { id: 'greed', root: '/repo/games/greed/src' }], ROOT)).toThrow(
      /Game "greed" has no lazily loaded code/,
    );
    expect(() => reachable({ a: { file: 'a.js', imports: ['b'] } }, ['a'], new Set())).toThrow(/refers to "b"/);
  });

  it('gives a game the worker its lazily loaded code names, and the chunks it loads later', () => {
    // Greed as the site wires it: the module lazily loads the dice tray, and the site lazily
    // imports the job worker factory, whose chunk carries the worker file as an asset.
    const greed: ViteManifest = {
      ...MANIFEST,
      'src/entry-client.ts': {
        ...MANIFEST['src/entry-client.ts'],
        file: 'assets/entry-client-E.js',
        dynamicImports: [
          ...(MANIFEST['src/entry-client.ts']?.dynamicImports ?? []),
          '../../games/greed/src/ui/module.ts',
          '../../games/greed/src/jobs/workers.ts',
        ],
      },
      '../../games/greed/src/ui/module.ts': {
        file: 'assets/module-G.js',
        src: '../../games/greed/src/ui/module.ts',
        isDynamicEntry: true,
        imports: ['src/entry-client.ts'],
        dynamicImports: ['../../games/greed/src/render/dice-tray.ts'],
        assets: ['assets/fraunces-G.woff2'],
      },
      '../../games/greed/src/render/dice-tray.ts': {
        file: 'assets/dice-tray-G.js',
        src: '../../games/greed/src/render/dice-tray.ts',
        isDynamicEntry: true,
        imports: ['../../games/greed/src/ui/module.ts'],
      },
      '../../games/greed/src/jobs/workers.ts': {
        file: 'assets/workers-G.js',
        src: '../../games/greed/src/jobs/workers.ts',
        isDynamicEntry: true,
        assets: ['assets/throw.worker-G.js'],
      },
    };
    const games = [...GAMES, { id: 'greed', root: '/repo/games/greed/src' }];
    const sets = fileSets(greed, games, ROOT);
    expect([...(sets.games.get('greed') ?? [])].sort()).toEqual([
      'assets/dice-tray-G.js',
      'assets/fraunces-G.woff2',
      'assets/module-G.js',
      'assets/throw.worker-G.js',
      'assets/workers-G.js',
    ]);
    for (const file of ['assets/throw.worker-G.js', 'assets/dice-tray-G.js']) {
      expect(sets.shell.has(file), file).toBe(false);
      expect(sets.games.get('nim')?.has(file), file).toBe(false);
    }
  });

  it('gives a game the renderer its module loads lazily, and shares a library chunk between the games that import it', () => {
    // Containment and Greed as the real build emits them: Containment's module lazily loads
    // the chamber, Greed's the dice tray, and the bundler puts Three.js in one chunk both
    // renderers import statically.
    const threeD: ViteManifest = {
      ...MANIFEST,
      'src/entry-client.ts': {
        ...MANIFEST['src/entry-client.ts'],
        file: 'assets/entry-client-E.js',
        dynamicImports: [
          ...(MANIFEST['src/entry-client.ts']?.dynamicImports ?? []),
          '../../games/containment/src/ui/module.ts',
          '../../games/greed/src/ui/module.ts',
        ],
      },
      '../../games/containment/src/ui/module.ts': {
        file: 'assets/module-C.js',
        src: '../../games/containment/src/ui/module.ts',
        isDynamicEntry: true,
        imports: ['src/entry-client.ts'],
        dynamicImports: ['../../games/containment/src/render/chamber.ts'],
      },
      '../../games/containment/src/render/chamber.ts': {
        file: 'assets/chamber-C.js',
        src: '../../games/containment/src/render/chamber.ts',
        isDynamicEntry: true,
        imports: ['_three.module-3.js'],
      },
      '../../games/greed/src/ui/module.ts': {
        file: 'assets/module-G.js',
        src: '../../games/greed/src/ui/module.ts',
        isDynamicEntry: true,
        imports: ['src/entry-client.ts'],
        dynamicImports: ['../../games/greed/src/render/dice-tray.ts'],
      },
      '../../games/greed/src/render/dice-tray.ts': {
        file: 'assets/dice-tray-G.js',
        src: '../../games/greed/src/render/dice-tray.ts',
        isDynamicEntry: true,
        imports: ['_three.module-3.js'],
      },
      '_three.module-3.js': { file: 'assets/three.module-3.js' },
    };
    const games = [
      ...GAMES,
      { id: 'containment', root: '/repo/games/containment/src' },
      { id: 'greed', root: '/repo/games/greed/src' },
    ];
    const sets = fileSets(threeD, games, ROOT);
    expect([...(sets.games.get('containment') ?? [])].sort()).toEqual([
      'assets/chamber-C.js',
      'assets/module-C.js',
      'assets/three.module-3.js',
    ]);
    expect([...(sets.games.get('greed') ?? [])].sort()).toEqual([
      'assets/dice-tray-G.js',
      'assets/module-G.js',
      'assets/three.module-3.js',
    ]);
    for (const file of ['assets/chamber-C.js', 'assets/three.module-3.js']) {
      expect(sets.shell.has(file), file).toBe(false);
      expect(sets.games.get('nim')?.has(file), file).toBe(false);
    }
    expect(sets.games.get('greed')?.has('assets/chamber-C.js')).toBe(false);
  });

  it('refuses a worker in the shell, which every visitor would precache and every pin copy', () => {
    // A game's worker factory imported statically by the site: the worker is the entry's asset.
    const eager: ViteManifest = {
      ...MANIFEST,
      'src/entry-client.ts': {
        ...MANIFEST['src/entry-client.ts'],
        file: 'assets/entry-client-E.js',
        assets: ['assets/throw.worker-G.js'],
      },
    };
    expect(() => fileSets(eager, GAMES, ROOT)).toThrow(
      /The shell reaches worker scripts: assets\/throw\.worker-G\.js\./,
    );
  });

  it('assigns merged dynamic entries by their module IDs when Vite omitted source/facade metadata', () => {
    const merged: ViteManifest = {
      ...MANIFEST,
      'src/entry-client.ts': {
        ...MANIFEST['src/entry-client.ts'],
        file: 'assets/entry-client-E.js',
        dynamicImports: [...(MANIFEST['src/entry-client.ts']?.dynamicImports ?? []), '_preparer-P.js'],
      },
      '_preparer-P.js': { file: 'assets/preparer-P.js', imports: ['_render-R.js'], assets: ['assets/puzzles-P.json'] },
    };
    const games = [...GAMES, { id: 'puzzle', root: '/repo/games/puzzle/src' }];
    const sources = new Map([
      ['assets/preparer-P.js', ['/repo/games/puzzle/src/engine/preparer.ts', '/repo/games/puzzle/src/engine/data.ts']],
    ]);
    const sets = fileSets(merged, games, ROOT, [], sources);
    expect(sets.shell.has('assets/preparer-P.js')).toBe(false);
    expect(sets.games.get('nim')?.has('assets/preparer-P.js')).toBe(false);
    expect([...(sets.games.get('puzzle') ?? [])].sort()).toEqual(['assets/preparer-P.js', 'assets/puzzles-P.json']);
    // A static dependency is still required even if its chunk also names another game's code.
    const dependent = {
      ...merged,
      '../../games/nim/src/ui/module.ts': {
        ...merged['../../games/nim/src/ui/module.ts'],
        file: 'assets/module-N.js',
        imports: ['_preparer-P.js'],
      },
    };
    expect(fileSets(dependent, games, ROOT, [], sources).games.get('nim')?.has('assets/preparer-P.js')).toBe(true);
  });

  it('needs exactly one entry', () => {
    expect(entryKey(MANIFEST)).toBe('src/entry-client.ts');
    expect(() => entryKey({ a: { file: 'a.js' } })).toThrow(/Expected one entry/);
  });
});
