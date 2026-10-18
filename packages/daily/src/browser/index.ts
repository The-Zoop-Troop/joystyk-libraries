// @joystyk/daily/browser: the browser-only parts. Today's UTC date from the device clock and
// the next release in local time, the content client with its offline cache and prefetch, the
// results store, and the day watcher. The service worker and the cache tiers belong to the
// PWA; it calls `prefetch` at safe points.

export {
  nextReleaseLocal,
  timeUntilNextDay,
  today,
  watchDay,
  type ClockOptions,
  type DayWatcher,
  type NextRelease,
} from './clock.ts';
export {
  CACHED_PUZZLE_RECORD,
  cachePrefix,
  createDailyClient,
  type CachedPuzzle,
  type DailyClient,
  type DailyClientOptions,
  type DailyPuzzle,
  type FetchLike,
  type PrefetchReport,
} from './content.ts';
export { DAILY_MESSAGES, dailyError, type DailyError, type DailyErrorCode } from './errors.ts';
export { contentHashOf } from './hash.ts';
export { createDailyResults, DAILY_RESULT_RECORD, type DailyResults, type Recorded } from './results.ts';
