// Which day it is, and calendar arithmetic on "yyyy-mm-dd" strings. A daily puzzle's day is
// the UTC day (D-46): the same date everywhere at once. Nothing here reads a clock: the caller
// passes the instant in epoch milliseconds (content-pipeline.md, "Which day is today").

import { addDays, dateOfDay, dayNumber, isIsoDate } from '@joystyk/kit';

export { addDays, dayNumber, isIsoDate };

export const DAY_MS = 86_400_000;

const checkInstant = (instant: number): void => {
  if (!Number.isFinite(instant)) throw new RangeError(`Expected an instant in epoch milliseconds, got ${instant}.`);
};

/** The UTC calendar date at `instant`: the date of the daily puzzle that is out then. */
export const utcDate = (instant: number): string => {
  checkInstant(instant);
  return dateOfDay(Math.floor(instant / DAY_MS));
};

/** Whole days from `from` to `to`: `daysBetween('2028-02-28', '2028-03-01')` is 2. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** The instant (epoch milliseconds) at which `date` begins: 00:00 UTC. */
export const startOfDay = (date: string): number => dayNumber(date) * DAY_MS;

/**
 * Milliseconds from `instant` until the next UTC day begins, when the next puzzle comes out.
 * Show it as plain information ("in 6 hours"), never as a countdown meant to pressure
 * (audience-and-age.md).
 */
export const untilNextDay = (instant: number): number => startOfDay(addDays(utcDate(instant), 1)) - instant;

/**
 * The puzzle number of `date` in a series that began on `firstDate` (number 1), for share text
 * such as "Daily Word #412". Zero or negative for dates before the series began.
 */
export const puzzleNumber = (date: string, firstDate: string): number => daysBetween(firstDate, date) + 1;
