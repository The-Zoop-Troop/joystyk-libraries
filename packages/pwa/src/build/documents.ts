// The build's own documents, as pure functions of the hashed file names: the web app
// manifest, the offline page, a game's asset manifest and the precache list.
import { createHash } from 'node:crypto';
import { ASSET_MANIFEST_VERSION, type AssetFile, type GameAssetManifest } from '../asset-manifest.ts';
import { fileKind } from '../routing.ts';
import { BRAND_BACKGROUND } from './icons.ts';

/** A short content hash for a file name or a precache revision (base64url, like Vite's). */
export const contentHash = (content: string | Uint8Array, length = 8): string =>
  createHash('sha256').update(content).digest('base64url').replace(/[-_]/g, 'x').slice(0, length);

export type IconFiles = {
  readonly svg: string;
  readonly png192: string;
  readonly png512: string;
  readonly maskable512: string;
};

/** manifest.webmanifest: what an installed Joystyk looks like. */
export const webManifest = (icons: IconFiles) => ({
  id: '/',
  name: 'Joystyk',
  short_name: 'Joystyk',
  description:
    'Free games for your browser, for every age. Solo, against the computer, or pass the device to a friend.',
  lang: 'en',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: BRAND_BACKGROUND,
  theme_color: BRAND_BACKGROUND,
  categories: ['games', 'entertainment'],
  icons: [
    { src: icons.svg, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: icons.png192, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: icons.png512, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: icons.maskable512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The offline page. Static: its script fills in the list of games this device can play. */
export const offlinePage = (files: {
  readonly css: string;
  readonly js: string;
  readonly icon: string;
}): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>You're offline | Joystyk</title>
<meta name="robots" content="noindex">
<meta name="theme-color" content="${BRAND_BACKGROUND}">
<link rel="icon" href="${escapeAttr(files.icon)}" type="image/svg+xml">
<link rel="stylesheet" href="${escapeAttr(files.css)}">
<script defer src="${escapeAttr(files.js)}"></script>
</head>
<body>
<main>
<p class="kicker">Joystyk</p>
<h1>You're offline</h1>
<p id="where" class="lede">This page needs an internet connection.</p>
<section aria-labelledby="ready-heading">
<h2 id="ready-heading">Games you can play offline</h2>
<ul id="games" hidden></ul>
<p id="none">No games are saved on this device yet. Next time you're online, open a game's page and choose “Make available offline”.</p>
</section>
<p class="actions"><button type="button" id="retry">Try again</button> <a href="/">See all games</a></p>
</main>
</body>
</html>
`;

/** A game as the site describes it to the build. */
export type BuildGame = {
  readonly id: string;
  readonly name: string;
  /** `manifest.versions.build`. */
  readonly version: string;
  readonly rulesVersion: number;
  readonly saveVersion: number;
  /** The folder holding the game's code (its entry's folder). */
  readonly root: string;
  /** The game manifest's `assets`: where this asset manifest is served. */
  readonly assets: string;
  /** The game's page, e.g. /games/nim. */
  readonly page: string;
  /** Catalog data the page loads on client-side navigation, e.g. /api/games/nim. */
  readonly data: readonly string[];
};

/** `games/<id>/manifest.json`: the game's files plus the shell's, sizes from `sizeOf`. */
export const gameAssetManifest = (
  game: BuildGame,
  release: string,
  shell: ReadonlySet<string>,
  own: ReadonlySet<string>,
  sizeOf: (file: string) => number,
): GameAssetManifest => {
  const describe = (file: string, scope: 'shell' | 'game'): AssetFile => {
    const url = `/${file}`;
    const kind = fileKind(url) ?? 'code';
    return { url, size: sizeOf(file), kind, scope };
  };
  const files = [
    ...[...shell].sort().map((file) => describe(file, 'shell')),
    ...[...own].sort().map((file) => describe(file, 'game')),
  ];
  return {
    schemaVersion: ASSET_MANIFEST_VERSION,
    id: game.id,
    name: game.name,
    version: game.version,
    rulesVersion: game.rulesVersion,
    saveVersion: game.saveVersion,
    release,
    page: game.page,
    documents: [game.page, ...game.data],
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
};

/** One Workbox precache entry. `revision: null` for a URL whose name already holds a hash. */
export type PrecacheEntry = { readonly url: string; readonly revision: string | null };

/** Where a precache entry's bytes come from at build time, so each can be checked. */
export type PrecacheSource =
  | { readonly url: string; readonly hashed: true; readonly file: string }
  | { readonly url: string; readonly hashed: false; readonly body: Uint8Array | string };

/**
 * The precache list. A hashed file must exist on disk (`exists`); an unhashed entry gets a
 * revision from its rendered bytes. Throws listing every missing entry, because one bad entry
 * fails the worker's install for every visitor.
 */
export const precacheEntries = (
  sources: readonly PrecacheSource[],
  exists: (file: string) => boolean,
): PrecacheEntry[] => {
  const missing = sources.filter((source) => (source.hashed ? !exists(source.file) : source.body.length === 0));
  if (missing.length > 0) {
    throw new Error(
      `[pwa] Precache entries missing from the build: ${missing.map((s) => s.url).join(', ')}. ` +
        'Each one would fail the service worker install for every visitor; fix the build before deploying.',
    );
  }
  const seen = new Set<string>();
  const entries: PrecacheEntry[] = [];
  for (const source of sources) {
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    entries.push({ url: source.url, revision: source.hashed ? null : contentHash(source.body, 16) });
  }
  return entries.sort((a, b) => a.url.localeCompare(b.url));
};

export const INJECTION_POINT = 'self.__WB_MANIFEST';

/** Puts the precache list into the bundled worker, or throws when the injection point is gone. */
export const injectManifest = (code: string, entries: readonly PrecacheEntry[]): string => {
  const at = code.indexOf(INJECTION_POINT);
  if (at === -1 || code.indexOf(INJECTION_POINT, at + 1) !== -1) {
    throw new Error(
      `[pwa] Expected "${INJECTION_POINT}" exactly once in the bundled service worker; sw.ts must call precache(${INJECTION_POINT}).`,
    );
  }
  return code.replace(INJECTION_POINT, JSON.stringify(entries));
};
