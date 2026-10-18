import { createRng } from '@joystyk/kit';
import { describe, expect, it } from 'vitest';
import { addDays, creditDate, dayNumber, NO_STREAKS, streaks, type DailyOutcome, type DailyResult } from './index.ts';

type Played = Pick<DailyResult, 'puzzleId' | 'outcome'>;

const played = (date: string, outcome: DailyOutcome = 'completed', game = 'daily-word'): Played => ({
  puzzleId: `${game}:${date}`,
  outcome,
});

describe('streaks', () => {
  it('is all zeros with no results', () => {
    expect(streaks([], '2026-10-08')).toEqual(NO_STREAKS);
  });

  it('counts consecutive dates ending today', () => {
    const results = ['2026-10-06', '2026-10-07', '2026-10-08'].map((date) => played(date));
    expect(streaks(results, '2026-10-08')).toMatchObject({ current: 3, best: 3, lastDay: '2026-10-08' });
  });

  it("leaves the streak standing while today isn't played yet", () => {
    const results = ['2026-10-06', '2026-10-07'].map((date) => played(date));
    expect(streaks(results, '2026-10-08')).toMatchObject({ current: 2, best: 2 });
  });

  it('resets the current streak after a missed date and keeps the best', () => {
    const results = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06'].map((date) => played(date));
    expect(streaks(results, '2026-10-08')).toMatchObject({ current: 0, best: 3, lastDay: '2026-10-06' });
    expect(streaks(results, '2026-10-07')).toMatchObject({ current: 1, best: 3 });
  });

  it("credits a puzzle finished after midnight to the puzzle's own date", () => {
    const late: DailyResult = {
      puzzleId: 'daily-word:2026-10-07',
      variant: null,
      contentHash: '0123456789ab',
      outcome: 'won',
      assisted: false,
      summary: '4/6',
      stats: {},
      shareRows: [],
      finishedOn: '2026-10-08',
    };
    expect(creditDate(late)).toBe('2026-10-07');
    // It's now the 8th: yesterday's late finish keeps the streak alive, and today is still open.
    expect(streaks([played('2026-10-06'), late], '2026-10-08')).toMatchObject({ current: 2, lastDay: '2026-10-07' });
    expect(streaks([played('2026-10-06'), late, played('2026-10-08')], '2026-10-08')).toMatchObject({ current: 3 });
  });

  it('counts a date once, whichever variants were finished', () => {
    const results = [played('2026-10-07'), { ...played('2026-10-07') }, played('2026-10-08')];
    expect(streaks(results, '2026-10-08')).toMatchObject({ current: 2, best: 2 });
  });

  it('counts losses and help toward the streak but ends the win streak on a loss', () => {
    const results = [
      played('2026-10-03', 'won'),
      played('2026-10-04', 'won'),
      played('2026-10-05', 'won'),
      played('2026-10-06', 'lost'),
      played('2026-10-07', 'won'),
      played('2026-10-08', 'won'),
    ];
    expect(streaks(results, '2026-10-08')).toEqual({
      current: 6,
      best: 6,
      winCurrent: 2,
      winBest: 3,
      lastDay: '2026-10-08',
    });
  });

  it('ends the win streak at once when today is lost, and keeps it while today is open', () => {
    const won = [played('2026-10-06', 'won'), played('2026-10-07', 'won')];
    expect(streaks(won, '2026-10-08')).toMatchObject({ winCurrent: 2 });
    expect(streaks([...won, played('2026-10-08', 'lost')], '2026-10-08')).toMatchObject({
      current: 3,
      winCurrent: 0,
      winBest: 2,
    });
    expect(streaks([played('2026-10-06', 'won'), played('2026-10-07', 'lost')], '2026-10-08')).toMatchObject({
      current: 2,
      winCurrent: 0,
      winBest: 1,
    });
  });

  it('keeps the win streak at zero for games that only complete', () => {
    const results = ['2026-10-07', '2026-10-08'].map((date) => played(date, 'completed', 'crossword'));
    expect(streaks(results, '2026-10-08')).toEqual({
      current: 2,
      best: 2,
      winCurrent: 0,
      winBest: 0,
      lastDay: '2026-10-08',
    });
  });

  it('runs across leap days', () => {
    expect(
      streaks(
        ['2028-02-28', '2028-02-29', '2028-03-01'].map((d) => played(d)),
        '2028-03-01',
      ).current,
    ).toBe(3);
    expect(
      streaks(
        ['2027-02-27', '2027-02-28', '2027-03-01'].map((d) => played(d)),
        '2027-03-01',
      ).current,
    ).toBe(3);
    expect(
      streaks(
        ['2028-02-28', '2028-03-01'].map((d) => played(d)),
        '2028-03-01',
      ).current,
    ).toBe(1);
  });

  it('treats a skipped date as missed, and a repeated one as one date', () => {
    // A device clock moved a day ahead and back skips a date; the streak ends there.
    const skipped = ['2026-10-05', '2026-10-06', '2026-10-08'].map((d) => played(d));
    expect(streaks(skipped, '2026-10-08')).toMatchObject({ current: 1, best: 2 });
    // Two results for one date (two variants) count once.
    const repeated = [played('2026-10-07'), played('2026-10-08'), played('2026-10-08')];
    expect(streaks(repeated, '2026-10-08')).toMatchObject({ current: 2, best: 2 });
  });

  it('counts dates after today toward best only (a clock that was set ahead)', () => {
    const results = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map((d) => played(d));
    expect(streaks(results, '2026-10-08')).toMatchObject({ current: 2, best: 4, lastDay: '2026-10-10' });
  });

  it('ignores results without a daily puzzle id and refuses a bad today', () => {
    expect(streaks([{ puzzleId: 'nonsense', outcome: 'won' }], '2026-10-08')).toEqual(NO_STREAKS);
    expect(() => streaks([], '2026-02-30')).toThrow(RangeError);
  });

  it('matches a day-by-day count on random histories', () => {
    const rng = createRng('daily-streaks');
    const today = '2026-10-08';
    for (let trial = 0; trial < 300; trial += 1) {
      const results: Played[] = [];
      const finished = new Set<number>();
      const won = new Set<number>();
      for (let back = 0; back < 40; back += 1) {
        if (rng.next() < 0.3) continue;
        const date = addDays(today, -back);
        const outcome: DailyOutcome = rng.next() < 0.7 ? 'won' : 'lost';
        results.push(played(date, outcome));
        finished.add(dayNumber(date));
        if (outcome === 'won') won.add(dayNumber(date));
      }
      const t = dayNumber(today);
      const runBack = (days: Set<number>, from: number): number => {
        let n = 0;
        while (days.has(from - n)) n += 1;
        return n;
      };
      const expectedCurrent = finished.has(t) ? runBack(finished, t) : runBack(finished, t - 1);
      const expectedWin = finished.has(t) ? runBack(won, t) : runBack(won, t - 1);
      let best = 0;
      let winBest = 0;
      for (let day = t - 40; day <= t; day += 1) {
        best = Math.max(best, runBack(finished, day));
        winBest = Math.max(winBest, runBack(won, day));
      }
      const got = streaks(rng.shuffle(results), today);
      expect(got).toMatchObject({ current: expectedCurrent, best, winCurrent: expectedWin, winBest });
      expect(got.best).toBeGreaterThanOrEqual(got.current);
      expect(got.winBest).toBeGreaterThanOrEqual(got.winCurrent);
      expect(got.current).toBeGreaterThanOrEqual(got.winCurrent);
    }
  });
});
