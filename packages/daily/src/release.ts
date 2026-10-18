// When a daily puzzle is out. There is one puzzle per UTC day (D-46): puzzle D is out from
// 00:00 UTC on D until 00:00 UTC on D + 1, for everyone at once. The server lists D + 1 in a
// game's index a day early, so installed and pinned clients can prefetch it, and the client
// keeps it locked until its day begins (content-pipeline.md, "Which day is today").

import { addDays, daysBetween, startOfDay, utcDate } from './dates.ts';

/** The instant puzzle `date` comes out: 00:00 UTC on `date`. */
export const releaseInstant = (date: string): number => startOfDay(date);

/** True once puzzle `date` is out, so it may be started. */
export const isReleased = (date: string, instant: number): boolean => instant >= releaseInstant(date);

/** The instant the next puzzle after `instant` comes out: the start of the next UTC day. */
export const nextRelease = (instant: number): number => releaseInstant(addDays(utcDate(instant), 1));

/**
 * The newest date a game's index lists at `instant`: tomorrow's UTC date, so that installed
 * and pinned clients can prefetch it. It stays locked until `isReleased`.
 */
export const latestListedDate = (instant: number): string => addDays(utcDate(instant), 1);

/**
 * True when a player may start the puzzle for `date`, given today's UTC date. Only today's
 * puzzle can be started: an unstarted past puzzle is gone in v1, and a prefetched future one
 * is locked until its day begins. A puzzle already started is always kept, whatever the date
 * becomes, and its result counts for its own date (see `creditDate`).
 */
export const canStart = (date: string, today: string): boolean => daysBetween(today, date) === 0;

/**
 * The dates an installed or pinned client holds when today's UTC date is `today`: today and
 * the next day, never more (D-46).
 */
export const prefetchDates = (today: string): readonly string[] => [today, addDays(today, 1)];
