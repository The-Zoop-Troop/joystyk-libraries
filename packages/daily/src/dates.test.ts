import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, puzzleNumber, startOfDay, untilNextDay, utcDate } from './index.ts';

const utc = (iso: string): number => Date.parse(iso);
const HOUR = 3_600_000;

describe('utcDate', () => {
  it('changes date at 00:00 UTC, the same instant everywhere', () => {
    expect(utcDate(utc('2026-10-07T23:59:59.999Z'))).toBe('2026-10-07');
    expect(utcDate(utc('2026-10-08T00:00:00.000Z'))).toBe('2026-10-08');
    // 8:00 PM in New York in summer (UTC−4) and 10:00 AM in Sydney (UTC+10) are both 00:00 UTC.
    expect(utcDate(Date.parse('2026-07-01T20:00:00-04:00'))).toBe('2026-07-02');
    expect(utcDate(Date.parse('2026-07-02T10:00:00+10:00'))).toBe('2026-07-02');
  });

  it("ignores daylight saving: New York's 25-hour day still has one UTC date per UTC day", () => {
    // Fall back: 2026-11-01 02:00 EDT becomes 01:00 EST.
    expect(utcDate(Date.parse('2026-10-31T19:59:59-04:00'))).toBe('2026-10-31');
    expect(utcDate(Date.parse('2026-10-31T20:00:00-04:00'))).toBe('2026-11-01');
    expect(utcDate(Date.parse('2026-11-01T18:59:59-05:00'))).toBe('2026-11-01');
    expect(utcDate(Date.parse('2026-11-01T19:00:00-05:00'))).toBe('2026-11-02');
  });

  it('crosses leap days and years correctly', () => {
    expect(utcDate(utc('2028-02-29T12:00:00Z'))).toBe('2028-02-29');
    expect(utcDate(utc('2028-03-01T00:00:00Z'))).toBe('2028-03-01');
    expect(utcDate(utc('2100-02-28T23:59:59Z'))).toBe('2100-02-28');
    expect(utcDate(utc('2100-03-01T00:00:00Z'))).toBe('2100-03-01');
    expect(utcDate(utc('2000-02-29T00:00:00Z'))).toBe('2000-02-29');
    expect(utcDate(utc('2027-01-01T00:00:00Z'))).toBe('2027-01-01');
  });

  it('works before 1970', () => {
    expect(utcDate(utc('1969-12-31T23:59:59Z'))).toBe('1969-12-31');
    expect(utcDate(utc('1970-01-01T00:00:00Z'))).toBe('1970-01-01');
  });

  it('agrees with Date#toISOString hour by hour through a leap year', () => {
    const start = utc('2028-01-01T00:00:00Z');
    const mismatches: string[] = [];
    for (let hour = 0; hour < 366 * 24; hour += 1) {
      const instant = start + hour * HOUR + 59 * 60_000;
      const expected = new Date(instant).toISOString().slice(0, 10);
      if (utcDate(instant) !== expected) mismatches.push(new Date(instant).toISOString());
    }
    expect(mismatches).toEqual([]);
  });

  it('refuses instants that are not real', () => {
    expect(() => utcDate(Number.NaN)).toThrow(RangeError);
    expect(() => utcDate(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('calendar arithmetic', () => {
  it('counts days across leap days, months and years', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetween('2026-10-08', '2026-10-01')).toBe(-7);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('numbers puzzles from the first date of a series', () => {
    expect(puzzleNumber('2026-10-08', '2026-10-08')).toBe(1);
    expect(puzzleNumber('2027-10-08', '2026-10-08')).toBe(366);
    expect(puzzleNumber('2026-10-07', '2026-10-08')).toBe(0);
  });

  it('finds when a day starts and how long until the next one', () => {
    expect(startOfDay('2026-10-08')).toBe(utc('2026-10-08T00:00:00Z'));
    expect(startOfDay('1969-12-31')).toBe(utc('1969-12-31T00:00:00Z'));
    expect(untilNextDay(utc('2026-10-08T23:00:00Z'))).toBe(HOUR);
    expect(untilNextDay(utc('2026-10-08T18:00:00Z'))).toBe(6 * HOUR);
    expect(untilNextDay(utc('2026-10-08T00:00:00Z'))).toBe(24 * HOUR);
  });

  it('refuses dates that are not real', () => {
    expect(() => daysBetween('2026-02-29', '2026-03-01')).toThrow(RangeError);
    expect(() => startOfDay('2026-13-01')).toThrow(RangeError);
  });
});
