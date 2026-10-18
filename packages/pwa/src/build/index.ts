// @joystyk/pwa/build: the build step, for Node. `joystykPwa` is the Vite plugin the site's
// client build runs; the rest is exported for tests and tools.
export {
  contentHash,
  gameAssetManifest,
  injectManifest,
  INJECTION_POINT,
  offlinePage,
  precacheEntries,
  webManifest,
  type BuildGame,
  type IconFiles,
  type PrecacheEntry,
  type PrecacheSource,
} from './documents.ts';
export {
  entryKey,
  fileSets,
  gameEntries,
  reachable,
  type FileSets,
  type GameSource,
  type ViteManifest,
  type ViteManifestChunk,
} from './graph.ts';
export { BRAND_BACKGROUND, crc32, encodePng, iconPng, iconShapes, iconSvg, rasterize } from './icons.ts';
export { joystykPwa, type PwaPluginOptions, type SiteBuildInput } from './plugin.ts';
