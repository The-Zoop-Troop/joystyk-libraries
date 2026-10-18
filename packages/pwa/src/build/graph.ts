// Which built files the shell needs and which each game needs, read from Vite's build
// manifest (`.vite/manifest.json`). Pure: the plugin passes the manifest in, and tests pass
// small hand-written ones.
//
// The shell is everything the site's entry reaches, except games: a game's code sits behind a
// dynamic import whose source lies in the game's folder. A game needs the shell plus
// everything its own dynamic entries reach. Static imports are always followed, even into
// another game's chunk, because the bundler may have put shared code there; dynamic imports
// of another game are not.
//
// A file the bundler emits for a module, such as a worker (`new Worker(new URL(…))`), is an
// asset of the chunk holding that module, so it goes wherever that chunk goes. A game's worker
// factory imported statically by the site would make the worker part of the shell: precached
// for every visitor and copied into every game's pin. The build refuses that.
import { isAbsolute, relative, resolve } from 'node:path';

/** One chunk or asset in Vite's build manifest. */
export type ViteManifestChunk = {
  readonly file: string;
  readonly name?: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
};

export type ViteManifest = Readonly<Record<string, ViteManifestChunk>>;

/** A game as the build sees it. */
export type GameSource = {
  readonly id: string;
  /** The folder holding the game's code; a dynamic entry inside it belongs to the game. */
  readonly root: string;
};

const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** The site's entry key: the one chunk marked `isEntry`. */
export const entryKey = (manifest: ViteManifest): string => {
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry === true);
  if (entries.length !== 1)
    throw new Error(
      `[pwa] Expected one entry in the Vite manifest, found ${String(entries.length)}: ${entries.map(([k]) => k).join(', ')}.`,
    );
  return entries[0]?.[0] ?? '';
};

/** Original module IDs by emitted file; merged dynamic entries may have no manifest `src`. */
export type ChunkSources = ReadonlyMap<string, readonly string[]>;

/** Each game's dynamic entries (manifest keys), by game id. `viteRoot` resolves `src`. */
export const gameEntries = (
  manifest: ViteManifest,
  games: readonly GameSource[],
  viteRoot: string,
  sources: ChunkSources = new Map(),
): Map<string, string[]> => {
  const owned = new Map<string, string[]>(games.map((game) => [game.id, []]));
  const dynamicTargets = new Set(Object.values(manifest).flatMap((chunk) => chunk.dynamicImports ?? []));
  for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.isDynamicEntry !== true && !dynamicTargets.has(key)) continue;
    const files = [
      ...(chunk.src === undefined ? [] : [resolve(viteRoot, chunk.src)]),
      ...(sources.get(chunk.file) ?? []),
    ];
    for (const game of games) if (files.some((file) => inside(resolve(game.root), file))) owned.get(game.id)?.push(key);
  }
  return owned;
};

/** Every file (chunks, their CSS and assets) reachable from `start`, as paths relative to outDir. */
export const reachable = (
  manifest: ViteManifest,
  start: readonly string[],
  blocked: ReadonlySet<string>,
): Set<string> => {
  const files = new Set<string>();
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length > 0) {
    const key = queue.shift() ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    const chunk = manifest[key];
    if (chunk === undefined) throw new Error(`[pwa] The Vite manifest refers to "${key}" but has no entry for it.`);
    files.add(chunk.file);
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file);
    queue.push(...(chunk.imports ?? []));
    queue.push(...(chunk.dynamicImports ?? []).filter((next) => !blocked.has(next) || start.includes(next)));
  }
  return files;
};

export type FileSets = {
  /** What every page needs: the entry, hydration, the launcher's lazy pieces. */
  readonly shell: ReadonlySet<string>;
  /** Per game: the files only that game's code reaches (the shell's are listed there). */
  readonly games: ReadonlyMap<string, ReadonlySet<string>>;
};

/**
 * Splits the build into the shell and each game. `unlisted` games' code is kept out of the
 * shell but gets no set. Throws when a listed game has no dynamic entry in the build: a game
 * whose code can't be found can't be pinned completely.
 */
export const fileSets = (
  manifest: ViteManifest,
  games: readonly GameSource[],
  viteRoot: string,
  unlisted: readonly GameSource[] = [],
  sources: ChunkSources = new Map(),
): FileSets => {
  const owned = gameEntries(manifest, games, viteRoot, sources);
  const hidden = gameEntries(manifest, unlisted, viteRoot, sources);
  const allGameEntries = new Set([...owned.values(), ...hidden.values()].flat());
  const shell = reachable(manifest, [entryKey(manifest)], allGameEntries);
  const chunkFiles = new Set(Object.values(manifest).map((chunk) => chunk.file));
  const workers = [...shell].filter((file) => /\.m?js$/.test(file) && !chunkFiles.has(file));
  if (workers.length > 0) {
    throw new Error(
      `[pwa] The shell reaches worker scripts: ${workers.join(', ')}. Every visitor would precache them and every pin would copy them. ` +
        "Name a game's worker from code the game loads lazily (a dynamic import() under the game's folder), as apps/site/src/games.ts does for job workers.",
    );
  }
  const perGame = new Map<string, Set<string>>();
  for (const game of games) {
    const starts = owned.get(game.id) ?? [];
    if (starts.length === 0) {
      throw new Error(
        `[pwa] Game "${game.id}" has no lazily loaded code under ${game.root}. Its entry should load its module with a dynamic import().`,
      );
    }
    const own = reachable(manifest, starts, allGameEntries);
    perGame.set(game.id, new Set([...own].filter((file) => !shell.has(file))));
  }
  return { shell, games: perGame };
};
