// @joystyk/pwa: what the service worker, the page and the build share. Cache names, routing
// decisions, the asset-manifest and flag-file formats. No DOM, no worker globals, no Node.
// The page's side is '@joystyk/pwa/client'; the build step is '@joystyk/pwa/build'.
export {
  ASSET_MANIFEST_VERSION,
  AssetFileSchema,
  FILE_KINDS,
  formatBytes,
  GameAssetManifestSchema,
  parseAssetManifest,
  planPin,
  referencedAssets,
  type AssetFile,
  type FileKind,
  type GameAssetManifest,
  type PinPlan,
} from './asset-manifest.ts';
export { markOfflineHtml, markOfflineResponse } from './offline-mark.ts';
export { parsePinRecord, PinRecordSchema, type PinRecord } from './pin-record.ts';
export {
  canonicalReleaseTime,
  capMinimumRelease,
  ControlSchema,
  DEFAULT_CONTROL,
  isDisabled,
  mustUpdate,
  parseControl,
  parseReleaseRecord,
  RELEASE_RECORD_FILE,
  ReleaseRecordSchema,
  releaseTimeMs,
  type Control,
  type ReleaseRecord,
} from './control.ts';
export {
  CONTROL_URL,
  isPwaCache,
  MESSAGES,
  OFFLINE_ATTRIBUTE,
  OFFLINE_URL,
  parsePinnedCacheName,
  PIN_RECORD_PATH,
  pinnedCacheName,
  PRECACHE_NAME,
  PRECACHE_PREFIX,
  RECENT_KINDS,
  recentCacheName,
  SW_URL,
  WEB_MANIFEST_URL,
  type RecentKind,
} from './names.ts';
export {
  ASSETS_PREFIX,
  fileKind,
  RECENT_LIMITS,
  routeFor,
  shouldOfferUpdate,
  type PromptInput,
  type Route,
  type RouteInput,
} from './routing.ts';
export { decodeSync, validator } from './validate.ts';
