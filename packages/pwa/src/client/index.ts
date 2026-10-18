// @joystyk/pwa/client: the page's side. `registerPwa` registers the worker and runs the
// update flow and forced security updates; the pin functions make games available offline;
// `definePwaElements` registers <jy-offline-toggle>, <jy-update-toast> and
// <jy-security-update>. Browser only.
export { definePwaElements, OfflineToggle, SecurityUpdate, UpdateToast } from './elements.ts';
export { browserCachePorts, pinnedGames, pinStatus, unpinGame, type CachePorts } from './pinned.ts';
export {
  browserPinPorts,
  PIN_MESSAGES,
  pinGame,
  refreshPinnedGames,
  type Pinned,
  type PinError,
  type PinErrorCode,
  type PinPorts,
} from './pins.ts';
export { readControl } from './control.ts';
export {
  securityNotice,
  watchForcedUpdates,
  type ForcedUpdateOptions,
  type ForcedUpdates,
  type SecurityNotice,
} from './forced.ts';
export {
  dailyToPrefetch,
  disablePwa,
  registerPwa,
  toastPrompt,
  type DailyPrefetcher,
  type PwaController,
  type PwaOptions,
  type UpdatePrompt,
} from './register.ts';

export { watchOfflineAvailability, PIN_CHANGED, type AvailabilityPorts } from './availability.ts';
