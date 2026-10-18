import * as z from 'zod/mini';
import { isIsoDate } from '@joystyk/kit';
import { parsePuzzleId } from './ids.ts';
import type { DailyResult } from './schemas.ts';

const count = z.int().check(z.minimum(0));
export const dailyWordStatsSchema = z
  .object({
    played: count,
    won: count,
    winPercent: z.int().check(z.minimum(0), z.maximum(100)),
    distribution: z.array(count).check(z.length(6)),
  })
  .check(
    z.refine(
      (s) =>
        s.won <= s.played &&
        s.distribution.reduce((a, b) => a + b, 0) <= s.won &&
        s.winPercent === (s.played === 0 ? 0 : Math.round((s.won * 100) / s.played)),
      'Inconsistent Daily Word statistics.',
    ),
  );
export type DailyWordStats = z.infer<typeof dailyWordStatsSchema>;

/** Daily-only statistics from immutable first results; practice and future clock-skew
 * records do not inflate them. Older records can use their spoiler-free row count. */
export const dailyWordStats = (results: Iterable<DailyResult>, today: string): DailyWordStats => {
  if (!isIsoDate(today)) throw new RangeError('Expected a real statistics date.');
  const seen = new Set<string>();
  const distribution = [0, 0, 0, 0, 0, 0];
  let played = 0,
    won = 0;
  for (const result of results) {
    const ref = parsePuzzleId(result.puzzleId);
    if (
      ref?.gameId !== 'daily-word' ||
      ref.date > today ||
      seen.has(result.puzzleId) ||
      !['won', 'lost'].includes(result.outcome)
    )
      continue;
    seen.add(result.puzzleId);
    played += 1;
    if (result.outcome !== 'won') continue;
    won += 1;
    const n = result.stats['guesses'] ?? result.shareRows.length;
    if (Number.isInteger(n) && n >= 1 && n <= 6) distribution[n - 1]! += 1;
  }
  return { played, won, winPercent: played === 0 ? 0 : Math.round((won * 100) / played), distribution };
};
