// The streak rules, the same for every daily game (content-pipeline.md, "Results and
// streaks"). Streaks are computed from stored results by this pure function, never kept as
// a counter that could drift. There are no freezes, no grace days and nothing to buy.

import { dayNumber, isIsoDate } from './dates.ts';
import { parsePuzzleId } from './ids.ts';
import type { DailyResult } from './schemas.ts';

/** A game's streaks on one day. */
export type Streaks = {
  /** Consecutive puzzle dates finished, ending today or yesterday; 0 after a missed date. */
  readonly current: number;
  /** The longest run of consecutive dates finished. */
  readonly best: number;
  /** Consecutive puzzle dates won, ending today or yesterday. Only shown by games that can be lost. */
  readonly winCurrent: number;
  /** The longest run of consecutive dates won. */
  readonly winBest: number;
  /** The newest puzzle date finished, or null. */
  readonly lastDay: string | null;
};

export const NO_STREAKS: Streaks = { current: 0, best: 0, winCurrent: 0, winBest: 0, lastDay: null };

const longestRun = (days: ReadonlySet<number>): number => {
  let best = 0;
  for (const day of days) {
    if (days.has(day - 1)) continue; // not the start of a run
    let length = 1;
    while (days.has(day + length)) length += 1;
    best = Math.max(best, length);
  }
  return best;
};

const runEndingAt = (days: ReadonlySet<number>, last: number): number => {
  let length = 0;
  while (days.has(last - length)) length += 1;
  return length;
};

/**
 * One game's streaks on `today`, today's UTC date, from that game's results. Streaks count
 * UTC days (D-46).
 *
 * - A date counts as finished when any variant of its puzzle reached an outcome (won, lost or
 *   completed, with or without help), and as won when any variant was won.
 * - Each result counts for its puzzle's own date, so finishing yesterday's puzzle after the
 *   next release still extends yesterday.
 * - Today not yet played leaves the current streak standing; any missed date before it sets
 *   the current streak to 0. A lost day ends the win streak. Days skipped by a changed clock
 *   count as missed; repeated dates count once.
 * - Results for dates after `today` (a clock that was set ahead) count toward the best
 *   streaks but not the current ones.
 * - Results whose id isn't a daily puzzle id are ignored.
 */
export const streaks = (results: Iterable<Pick<DailyResult, 'puzzleId' | 'outcome'>>, today: string): Streaks => {
  if (!isIsoDate(today)) throw new RangeError(`Expected a "yyyy-mm-dd" date, got ${JSON.stringify(today)}.`);
  const finished = new Set<number>();
  const won = new Set<number>();
  let lastDay: string | null = null;
  for (const result of results) {
    const ref = parsePuzzleId(result.puzzleId);
    if (ref === null) continue;
    const day = dayNumber(ref.date);
    finished.add(day);
    if (result.outcome === 'won') won.add(day);
    if (lastDay === null || ref.date > lastDay) lastDay = ref.date;
  }

  const t = dayNumber(today);
  const anchor = (days: ReadonlySet<number>): number | null => (days.has(t) ? t : days.has(t - 1) ? t - 1 : null);

  const finishedAnchor = anchor(finished);
  // A day finished but not won ends the win streak, even today.
  const winAnchor = finished.has(t) && !won.has(t) ? null : anchor(won);

  return {
    current: finishedAnchor === null ? 0 : runEndingAt(finished, finishedAnchor),
    best: longestRun(finished),
    winCurrent: winAnchor === null ? 0 : runEndingAt(won, winAnchor),
    winBest: longestRun(won),
    lastDay,
  };
};
