// The PWA build step, as a Vite plugin for the site's client build. After Vite writes the
// client, it adds, from the built output:
//
//   assets/icon-*.svg|png, assets/offline-*.js|css   hashed, immutable (Rule 1)
//   manifest.webmanifest, offline.html                served no-cache
//   games/<id>/manifest.json                          every file each game needs (Rule 1)
//   sw.js                                             one classic script, precache list injected
//   sw-remove.js                                      the emergency self-removing worker (Rule 5)
//   pwa-control.json                                  the default flag file
//   release.json                                      the release ID and time, for the server
//
// The worker is bundled from Workbox modules with Vite itself, so the build needs no other
// bundler. Precache revisions hash the rendered output (the blog's lesson): the site renders
// its shell pages at build time exactly as the server will, and the build fails if any
// precache entry is missing.
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Logger, type Plugin, type ResolvedConfig } from 'vite';
import * as z from 'zod/mini';
import { canonicalReleaseTime, DEFAULT_CONTROL, RELEASE_RECORD_FILE, type ReleaseRecord } from '../control.ts';
import { OFFLINE_URL, WEB_MANIFEST_URL } from '../names.ts';
import {
  contentHash,
  gameAssetManifest,
  injectManifest,
  offlinePage,
  precacheEntries,
  webManifest,
  type BuildGame,
  type PrecacheSource,
} from './documents.ts';
import { fileSets, type GameSource } from './graph.ts';
import { iconPng, iconSvg } from './icons.ts';

/** What the site supplies at build time, once the client build is on disk. */
export type SiteBuildInput = {
  /** The games this build lists: each gets an asset manifest. */
  readonly games: readonly BuildGame[];
  /**
   * Games whose code is in the bundle but which this build doesn't list, such as test games
   * outside test builds. Their code is kept out of the shell and gets no asset manifest.
   */
  readonly unlisted?: readonly GameSource[];
  /** Answers a request exactly as the production server will; used to hash the shell pages. */
  readonly render: (path: string) => Promise<Response>;
  /** Server-rendered paths to precache, such as '/' and '/favicon.svg'. */
  readonly shellPages: readonly string[];
};

export type PwaPluginOptions = {
  /** The release ID baked into the worker (git SHA + date). */
  readonly release: string;
  /**
   * When the release's code was committed, as an RFC 3339 date-time. Releases are ordered by
   * it: the flag file's minimum release is one (control.ts).
   */
  readonly releaseTime: string;
  /** Loads the site's half, given the output directory. Called after the client is written. */
  readonly site: (context: { readonly outDir: string }) => Promise<SiteBuildInput>;
};

const SOURCE = fileURLToPath(new URL('..', import.meta.url));

// Workspace builds use TypeScript; installed tarballs carry the same modules as JS.
const script = (folder: string, name: string): string => {
  const source = join(SOURCE, folder, `${name}.ts`);
  return existsSync(source) ? source : join(SOURCE, folder, `${name}.js`);
};

/** Bundles one browser or worker script into a single minified classic script. */
const bundleScript = async (entry: string, define: Record<string, string> = {}): Promise<string> => {
  const result = await build({
    configFile: false,
    root: SOURCE,
    logLevel: 'warn',
    publicDir: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), ...define },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: false,
      lib: { entry, formats: ['iife'], name: 'joystykPwa', fileName: () => 'bundle.js' },
    },
  });
  for (const output of Array.isArray(result) ? result : [result]) {
    if (!('output' in output)) continue;
    for (const item of output.output) if (item.type === 'chunk' && item.isEntry) return item.code;
  }
  throw new Error(`[pwa] Bundling ${entry} produced no script.`);
};

const write = async (file: string, content: string | Uint8Array): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
};

const manifestSchema = z.record(
  z.string(),
  z.object({
    file: z.string(),
    name: z.optional(z.string()),
    src: z.optional(z.string()),
    isEntry: z.optional(z.boolean()),
    isDynamicEntry: z.optional(z.boolean()),
    imports: z.optional(z.array(z.string())),
    dynamicImports: z.optional(z.array(z.string())),
    css: z.optional(z.array(z.string())),
    assets: z.optional(z.array(z.string())),
  }),
);

/** The plugin. Add it to the site's client build only. */
export const joystykPwa = (options: PwaPluginOptions): Plugin => {
  const releaseTime = canonicalReleaseTime(options.releaseTime);
  if (releaseTime === null)
    throw new Error(`[pwa] releaseTime "${options.releaseTime}" isn't a date-time such as 2026-10-09T14:03:12Z.`);
  let config: ResolvedConfig | undefined;
  let logger: Logger | undefined;
  return {
    name: 'joystyk-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
      logger = resolved.logger;
    },
    async writeBundle(output, bundle) {
      if (config === undefined || config.build.ssr !== false) return;
      const outDir = resolve(config.root, output.dir ?? config.build.outDir);
      const manifestPath = join(outDir, '.vite', 'manifest.json');
      if (!existsSync(manifestPath)) throw new Error('[pwa] The client build needs `build.manifest: true`.');
      const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      const sources = new Map(
        Object.values(bundle)
          .filter((item) => item.type === 'chunk')
          .map((chunk) => [chunk.fileName, chunk.moduleIds]),
      );
      const site = await options.site({ outDir });

      // Hashed, immutable files beside Vite's own.
      const hashed = async (name: string, ext: string, content: string | Uint8Array): Promise<string> => {
        const file = `assets/${name}-${contentHash(content)}.${ext}`;
        await write(join(outDir, file), content);
        return file;
      };
      const iconFiles = {
        svg: await hashed('icon', 'svg', iconSvg()),
        png192: await hashed('icon-192', 'png', iconPng(192)),
        png512: await hashed('icon-512', 'png', iconPng(512)),
        maskable512: await hashed('icon-maskable-512', 'png', iconPng(512, true)),
      };
      const offlineCss = await hashed('offline', 'css', await readFile(join(SOURCE, 'offline', 'offline.css')));
      const offlineJs = await hashed('offline', 'js', await bundleScript(script('offline', 'offline')));
      const url = (file: string): string => `/${file}`;

      const manifestJson = `${JSON.stringify(webManifest({ svg: url(iconFiles.svg), png192: url(iconFiles.png192), png512: url(iconFiles.png512), maskable512: url(iconFiles.maskable512) }), null, 2)}\n`;
      await write(join(outDir, 'manifest.webmanifest'), manifestJson);
      const offlineHtml = offlinePage({ css: url(offlineCss), js: url(offlineJs), icon: url(iconFiles.svg) });
      await write(join(outDir, 'offline.html'), offlineHtml);

      // Each game's asset manifest.
      const sets = fileSets(manifest, site.games, config.root, site.unlisted ?? [], sources);
      const sizeOf = (file: string): number => statSync(join(outDir, file)).size;
      for (const game of site.games) {
        const assets = gameAssetManifest(
          game,
          options.release,
          sets.shell,
          sets.games.get(game.id) ?? new Set(),
          sizeOf,
        );
        if (!game.assets.startsWith('/') || game.assets.includes('..'))
          throw new Error(`[pwa] ${game.id}: assets "${game.assets}" must be a site path.`);
        await write(join(outDir, game.assets), `${JSON.stringify(assets, null, 2)}\n`);
      }

      // Tier 1: the shell's code, the icons, the offline page and the rendered shell pages.
      const rendered: PrecacheSource[] = [];
      for (const path of site.shellPages) {
        const response = await site.render(path);
        if (response.status !== 200)
          throw new Error(`[pwa] Precaching ${path}: the server answers ${String(response.status)}, not 200.`);
        rendered.push({ url: path, hashed: false, body: new Uint8Array(await response.arrayBuffer()) });
      }
      const files = [...sets.shell, ...Object.values(iconFiles), offlineCss, offlineJs];
      const entries = precacheEntries(
        [
          ...rendered,
          { url: OFFLINE_URL, hashed: false, body: offlineHtml },
          { url: WEB_MANIFEST_URL, hashed: false, body: manifestJson },
          ...files.map((file): PrecacheSource => ({ url: url(file), hashed: true, file })),
        ],
        (file) => existsSync(join(outDir, file)),
      );

      const worker = injectManifest(
        await bundleScript(script('sw', 'sw'), { __JOYSTYK_RELEASE__: JSON.stringify(options.release) }),
        entries,
      );
      await write(join(outDir, 'sw.js'), worker);
      await write(join(outDir, 'sw-remove.js'), await bundleScript(script('sw', 'remove-sw')));
      await write(join(outDir, 'pwa-control.json'), `${JSON.stringify(DEFAULT_CONTROL, null, 2)}\n`);
      const record: ReleaseRecord = { release: options.release, releaseTime };
      await write(join(outDir, RELEASE_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
      logger?.info(
        `[pwa] sw.js ${(worker.length / 1024).toFixed(1)} kB for release ${options.release} (${releaseTime}):${String(entries.length)} precache entries; asset manifests for ${site.games.map((g) => g.id).join(', ') || 'no games'}.`,
      );
    },
  };
};
