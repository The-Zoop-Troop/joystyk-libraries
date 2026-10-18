// Today from the device clock, the next release in the player's own time, and a watcher that
// notices when the puzzle date changes. The date is the UTC date (D-46); only the times shown
// to the player are local.

import { untilNextDay, utcDate } from '../dates.ts';
import { countdownText, localTimeText, type LocalTimeOptions } from '../local-time.ts';
import { nextRelease } from '../release.ts';

export type ClockOptions = {
  /** Epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
};

/** Today's puzzle date, `yyyy-mm-dd`: the UTC date of the device clock. */
export const today = (options: ClockOptions = {}): string => utcDate((options.now ?? Date.now)());

/** Milliseconds until the next puzzle comes out, at the start of the next UTC day. */
export const timeUntilNextDay = (options: ClockOptions = {}): number => untilNextDay((options.now ?? Date.now)());

/** The next release, ready to show: "New puzzle at 8:00 PM (in 6 hours)". */
export type NextRelease = {
  /** The date of the next puzzle, `yyyy-mm-dd`. */
  readonly date: string;
  /** When it comes out, in epoch milliseconds. */
  readonly instant: number;
  /** Milliseconds from now until then. */
  readonly inMs: number;
  /** The release time in the player's zone, such as "8:00 PM". */
  readonly time: string;
  /** A plain countdown, such as "in 6 hours". */
  readonly countdown: string;
};

/**
 * When the next puzzle comes out, in the device's time zone and locale unless `timeZone` or
 * `locale` says otherwise. Call it again at safe points to refresh the countdown; it sets no
 * timers of its own.
 */
export const nextReleaseLocal = (options: ClockOptions & LocalTimeOptions = {}): NextRelease => {
  const now = (options.now ?? Date.now)();
  const instant = nextRelease(now);
  const inMs = instant - now;
  return {
    date: utcDate(instant),
    instant,
    inMs,
    time: localTimeText(instant, options),
    countdown: countdownText(inMs, options.locale),
  };
};

export type DayWatcher = {
  /** Compares the date with the last one seen, and reports a change. Call it at safe points. */
  check(): void;
  /** Stops listening. Idempotent. */
  stop(): void;
};

/**
 * Tells the frame when the puzzle date changes: on `visibilitychange` (a tab brought back
 * after the release) and whenever the frame calls `check` at a safe point. It never
 * interrupts a game; the frame decides when to offer the new day.
 */
export const watchDay = (
  onChange: (date: string, previous: string) => void,
  options: ClockOptions & { readonly target?: Pick<Document, 'addEventListener' | 'removeEventListener'> } = {},
): DayWatcher => {
  const target = options.target ?? document;
  let seen = today(options);
  let stopped = false;
  const check = (): void => {
    if (stopped) return;
    const date = today(options);
    if (date === seen) return;
    const previous = seen;
    seen = date;
    onChange(date, previous);
  };
  target.addEventListener('visibilitychange', check);
  return {
    check,
    stop: () => {
      if (stopped) return;
      stopped = true;
      target.removeEventListener('visibilitychange', check);
    },
  };
};
