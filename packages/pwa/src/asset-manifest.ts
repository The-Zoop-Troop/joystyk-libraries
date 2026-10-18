// A game's asset manifest, `games/<id>/manifest.json` (offline-and-updates.md, Rule 1): every
// file the game's page needs to play, with sizes and the versions that built it. The build
// writes it; pinning reads it from the network, so it is decoded through Standard Schema
// before use (D-18). A game is either completely available offline or not offered.
import { err, isGameId, ok, type Result } from '@joystyk/contracts';
import * as z from 'zod/mini';
import { RECENT_KINDS } from './names.ts';
import { ASSETS_PREFIX } from './routing.ts';

export const ASSET_MANIFEST_VERSION = 1;

export const FILE_KINDS = [...RECENT_KINDS, 'font'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const path = z
  .string()
  .check(
    z.refine(
      (value) => value.startsWith('/') && !value.startsWith('//'),
      'Expected a same-origin path such as /assets/x.js',
    ),
  );
const assetPath = z
  .string()
  .check(
    z.refine(
      (value) => value.startsWith(ASSETS_PREFIX) && !value.includes('..'),
      `Expected a path under ${ASSETS_PREFIX}`,
    ),
  );
const size = z.int().check(z.nonnegative());

export const AssetFileSchema = z.object({
  url: assetPath,
  size,
  kind: z.enum(FILE_KINDS),
  /** `shell`: the page and launcher code every game shares. `game`: this game's own code and assets. */
  scope: z.enum(['shell', 'game']),
});
export type AssetFile = z.infer<typeof AssetFileSchema>;

export const GameAssetManifestSchema = z.object({
  schemaVersion: z.literal(ASSET_MANIFEST_VERSION),
  id: z.string().check(z.refine(isGameId, 'Expected a kebab-case game id')),
  name: z.string().check(z.minLength(1)),
  /** The game build, semver (`manifest.versions.build`). Pinned caches are named by it. */
  version: z.string().check(z.regex(/^[0-9A-Za-z.+-]+$/)),
  rulesVersion: z.int(),
  saveVersion: z.int(),
  /** The platform release that built these files. */
  release: z.string().check(z.minLength(1)),
  /** The game's page. */
  page: path,
  /** Server-rendered pages and catalog data a pin keeps; always fetched fresh when pinning. */
  documents: z.array(path),
  files: z.array(AssetFileSchema),
  /** The sum of `files[].size`. */
  totalBytes: size,
});
export type GameAssetManifest = z.infer<typeof GameAssetManifestSchema>;

/** Decodes an asset manifest, or lists what is wrong with it. */
export const parseAssetManifest = (value: unknown): Result<GameAssetManifest, readonly string[]> => {
  const parsed = GameAssetManifestSchema.safeParse(value);
  if (!parsed.success)
    return err(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`));
  const total = parsed.data.files.reduce((sum, file) => sum + file.size, 0);
  if (total !== parsed.data.totalBytes)
    return err([`totalBytes: ${String(parsed.data.totalBytes)} is not the sum of the file sizes (${String(total)})`]);
  return ok(parsed.data);
};

/** What pinning a manifest into the caches must do. */
export type PinPlan = {
  /** The cache this build lives in: `game:<id>:<version>`. */
  readonly target: string;
  /** Hashed files the target cache lacks. */
  readonly fetch: readonly string[];
  /** Pages and data, fetched fresh every time, after the files. */
  readonly documents: readonly string[];
  /** Paths in the target cache the manifest no longer lists; deleted last. */
  readonly remove: readonly string[];
  /** The same game's caches for other builds; deleted after the switch. */
  readonly dropCaches: readonly string[];
};

/**
 * Plans a pin or a refresh. `existing` lists this game's pinned caches with the paths each
 * holds. Hashed files never change, so one already cached is kept; pages always refresh.
 */
export const planPin = (
  manifest: GameAssetManifest,
  assetsUrl: string,
  target: string,
  existing: readonly { readonly cacheName: string; readonly paths: readonly string[] }[],
  recordPath: string,
): PinPlan => {
  const held = new Set(existing.find((cache) => cache.cacheName === target)?.paths ?? []);
  const files = [...new Set(manifest.files.map((file) => file.url))];
  const documents = [...new Set([...manifest.documents, assetsUrl])];
  const keep = new Set([...files, ...documents, recordPath]);
  return {
    target,
    fetch: files.filter((url) => !held.has(url)),
    documents,
    remove: [...held].filter((url) => !keep.has(url)).sort(),
    dropCaches: existing.map((cache) => cache.cacheName).filter((name) => name !== target),
  };
};

/** The hashed files a page's HTML refers to (`src` and `href`), to check a pin is complete. */
export const referencedAssets = (html: string): string[] => {
  const found = new Set<string>();
  for (const match of html.matchAll(/\s(?:src|href)=["']?(\/assets\/[^"'\s>]+)/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
};

/** "312 KB", for the offline control. */
export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
