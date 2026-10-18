import { describe, expect, it } from 'vitest';
import { addDays, dailyId, dailyRng, dailySeed, dateOfDay, dayNumber, isIsoDate } from './daily.ts';
import { SEEDS } from './known-answers.test-util.ts';
import { forAll } from './properties.test-util.ts';
import { seedFromParts, seedState } from './rng.ts';

describe('dates', () => {
  it('accepts real "yyyy-mm-dd" dates only', () => {
    expect(['2026-10-08', '2024-02-29', '2000-02-29', '0000-01-01', '9999-12-31'].every(isIsoDate)).toBe(true);
    expect(
      [
        '2026-02-29',
        '1900-02-29',
        '2026-13-01',
        '2026-00-10',
        '2026-04-31',
        '2026-1-08',
        '26-10-08',
        '2026-10-08T00:00',
        20261008,
      ].some(isIsoDate),
    ).toBe(false);
  });

  it('numbers days from 1970-01-01', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1969-12-31')).toBe(-1);
    expect(dayNumber('2000-03-01')).toBe(11017);
    expect(dateOfDay(0)).toBe('1970-01-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('agrees with Date.UTC and round-trips across four centuries', () => {
    // Tests may use Date; the kit itself never does.
    forAll(
      'day-number',
      2000,
      (rng) => rng.int(-719162, 2932897), // 0001-01-01 … 9999-12-31
      (day) => {
        const date = dateOfDay(day);
        expect(isIsoDate(date)).toBe(true);
        expect(dayNumber(date)).toBe(day);
        expect(new Date(day * 86400000).toISOString().slice(0, 10)).toBe(date);
      },
    );
  });

  it('rejects days outside four-digit years', () => {
    expect(() => dateOfDay(-719529)).toThrow(RangeError);
    expect(() => dateOfDay(1.5)).toThrow(RangeError);
  });
});

describe('daily seeds', () => {
  it('builds the daily id <game>:<yyyy-mm-dd>', () => {
    expect(dailyId('sudoku', '2026-10-08')).toBe('sudoku:2026-10-08');
    expect(() => dailyId('Sudoku', '2026-10-08')).toThrow(RangeError);
    expect(() => dailyId('sudoku', '2026-02-30')).toThrow(RangeError);
  });

  it('seeds from the daily id, matching the known answer', () => {
    expect(dailySeed('klondike', '2026-10-08')).toEqual({ algorithm: 'sfc32', words: SEEDS[1]!.words });
    expect(dailySeed('klondike', '2026-10-08')).toEqual(seedState('klondike:2026-10-08'));
    expect(dailySeed('klondike', '2026-10-08')).toEqual(seedFromParts(['klondike', '2026-10-08']));
  });

  it('gives each game and day its own stream', () => {
    const states = new Set<string>();
    for (const game of ['sudoku', 'nonogram', 'minesweeper']) {
      for (let day = 0; day < 365; day += 1) states.add(JSON.stringify(dailySeed(game, addDays('2026-01-01', day))));
    }
    expect(states.size).toBe(3 * 365);
    expect(dailyRng('sudoku', '2026-10-08').next()).toBe(dailyRng('sudoku', '2026-10-08').next());
  });
});
