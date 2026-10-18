// @joystyk/daily: everything about days, results and sharing, so no game writes it again
// (content-pipeline.md, "What the daily package must offer"). This entry point is pure: no
// clock, storage, network or DOM, so it runs in tests and on the server. The content client,
// results store and day watcher live in '@joystyk/daily/browser'.

export {
  addDays,
  DAY_MS,
  dayNumber,
  daysBetween,
  isIsoDate,
  puzzleNumber,
  startOfDay,
  untilNextDay,
  utcDate,
} from './dates.ts';
export { canStart, isReleased, latestListedDate, nextRelease, prefetchDates, releaseInstant } from './release.ts';
export { countdownText, localTimeText, type LocalTimeOptions } from './local-time.ts';
export { isPuzzleId, parsePuzzleId, puzzleId, type PuzzleRef } from './ids.ts';
export { NO_STREAKS, streaks, type Streaks } from './streaks.ts';
export {
  formatClock,
  gridRows,
  shareText,
  type ShareForm,
  type ShareInput,
  type ShareLegendEntry,
  type ShareRow,
} from './share.ts';
export {
  canonicalJson,
  CONTENT_HASH,
  creditDate,
  DAILY_SCHEMA_VERSION,
  dailyEnvelope,
  dailyFile,
  dailyIndex,
  dailyResult,
  decode,
  json,
  VARIANT,
  type DailyEnvelope,
  type DailyFile,
  type DailyIndex,
  type DailyIndexEntry,
  type DailyOutcome,
  type DailyResult,
  type EnvelopeExpectations,
  type Issue,
} from './schemas.ts';

export { dailyWordStats, dailyWordStatsSchema, type DailyWordStats } from './word-stats.ts';
