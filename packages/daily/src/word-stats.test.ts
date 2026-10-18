import { expect, it } from 'vitest';
import type { DailyResult } from './schemas.ts';
import { dailyWordStats, dailyWordStatsSchema } from './word-stats.ts';
const result = (day: string, outcome: 'won' | 'lost', guesses: number): DailyResult => ({
  puzzleId: `daily-word:${day}`,
  outcome,
  stats: { guesses },
  variant: null,
  contentHash: 'a'.repeat(64),
  assisted: false,
  summary: '',
  shareRows: [],
  finishedOn: day,
});
it('counts daily first results, all six winning bins, losses and percentages without practice or future inflation', () => {
  const rows = Array.from({ length: 6 }, (_, i) => result(`2026-10-0${i + 1}`, 'won', i + 1));
  const stats = dailyWordStats(
    [
      ...rows,
      result('2026-10-07', 'lost', 6),
      result('2026-10-01', 'lost', 6),
      result('2026-10-12', 'won', 1),
      { ...rows[0]!, puzzleId: 'practice' },
    ],
    '2026-10-11',
  );
  expect(stats).toEqual({ played: 7, won: 6, winPercent: 86, distribution: [1, 1, 1, 1, 1, 1] });
  expect(dailyWordStats([], '2026-10-11').winPercent).toBe(0);
  expect(() => dailyWordStats([], '2026-02-30')).toThrow(RangeError);
  expect(
    dailyWordStatsSchema.safeParse({ played: 1, won: 2, winPercent: 100, distribution: [1, 1, 0, 0, 0, 0] }).success,
  ).toBe(false);
});
