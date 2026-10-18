import type { GameError, Json } from '@joystyk/contracts';

/** Why a daily puzzle couldn't be loaded. */
export type DailyErrorCode =
  /** The network is unreachable and nothing is cached for that date. */
  | 'Offline'
  /** The game's index doesn't list that date (not out yet, or no daily content at all). */
  | 'NotPublished'
  /** The server sent something that isn't a valid puzzle for that date. */
  | 'Invalid'
  /** Anything else, such as a server error. */
  | 'Failed';

/** An expected daily failure, worded for players. Shaped like `GameError`. */
export type DailyError = GameError & { readonly code: DailyErrorCode };

/** Player-facing wording for each failure (content-pipeline.md, "Prefetching for offline play"). */
export const DAILY_MESSAGES = {
  Offline: "This puzzle needs a connection. It will download next time you're online.",
  NotPublished: "This puzzle isn't out yet.",
  Invalid: "This puzzle couldn't be opened. Please try again later.",
  Failed: 'Something went wrong while loading the puzzle. Please try again later.',
} as const satisfies Record<DailyErrorCode, string>;

export const dailyError = (code: DailyErrorCode, detail?: Json): DailyError =>
  detail === undefined ? { code, message: DAILY_MESSAGES[code] } : { code, message: DAILY_MESSAGES[code], detail };
