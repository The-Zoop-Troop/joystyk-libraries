import { describe, expect, it } from 'vitest';
import {
  addDays,
  canStart,
  countdownText,
  isReleased,
  latestListedDate,
  localTimeText,
  nextRelease,
  prefetchDates,
  releaseInstant,
  utcDate,
} from './index.ts';

const utc = (iso: string): number => Date.parse(iso);
const HOUR = 3_600_000;
/** Intl separates the time from AM/PM with a narrow no-break space in recent ICU data. */
const plain = (text: string): string => text.replace(/\s/gu, ' ');

describe('release', () => {
  it('releases date D at 00:00 UTC on D, for everyone at once', () => {
    expect(releaseInstant('2026-10-08')).toBe(utc('2026-10-08T00:00:00Z'));
    expect(isReleased('2026-10-08', utc('2026-10-07T23:59:59.999Z'))).toBe(false);
    expect(isReleased('2026-10-08', utc('2026-10-08T00:00:00Z'))).toBe(true);
    expect(isReleased('2026-10-08', utc('2030-01-01T00:00:00Z'))).toBe(true);
  });

  it('finds the next release from any instant in a day', () => {
    expect(nextRelease(utc('2026-10-08T00:00:00Z'))).toBe(utc('2026-10-09T00:00:00Z'));
    expect(nextRelease(utc('2026-10-08T23:59:59.999Z'))).toBe(utc('2026-10-09T00:00:00Z'));
    expect(nextRelease(utc('2028-02-28T12:00:00Z'))).toBe(utc('2028-02-29T00:00:00Z'));
    expect(nextRelease(utc('2026-12-31T18:00:00Z'))).toBe(utc('2027-01-01T00:00:00Z'));
  });

  it('lists tomorrow in the index, and keeps it locked until it begins', () => {
    const instant = utc('2026-10-08T15:00:00Z');
    expect(latestListedDate(instant)).toBe('2026-10-09');
    expect(isReleased(latestListedDate(instant), instant)).toBe(false);
    expect(canStart(latestListedDate(instant), utcDate(instant))).toBe(false);
  });

  it('has exactly one released, startable date at every quarter hour of three days', () => {
    const start = utc('2028-02-28T00:00:00Z'); // across a leap day
    for (let step = 0; step < 3 * 24 * 4; step += 1) {
      const instant = start + step * 15 * 60_000;
      const today = utcDate(instant);
      expect(isReleased(today, instant)).toBe(true);
      expect(isReleased(addDays(today, 1), instant)).toBe(false);
      expect(nextRelease(instant)).toBe(releaseInstant(addDays(today, 1)));
      expect(nextRelease(instant) - instant).toBeGreaterThan(0);
      expect(nextRelease(instant) - instant).toBeLessThanOrEqual(24 * HOUR);
    }
  });
});

describe('starting and prefetching', () => {
  it('starts only today; a past puzzle unstarted is gone and a future one is not out yet', () => {
    expect(canStart('2026-10-08', '2026-10-08')).toBe(true);
    expect(canStart('2026-10-07', '2026-10-08')).toBe(false);
    expect(canStart('2026-10-09', '2026-10-08')).toBe(false);
  });

  it('holds today and the next day, never more', () => {
    expect(prefetchDates('2026-10-08')).toEqual(['2026-10-08', '2026-10-09']);
    expect(prefetchDates('2028-02-28')).toEqual(['2028-02-28', '2028-02-29']);
    expect(prefetchDates('2026-12-31')).toEqual(['2026-12-31', '2027-01-01']);
    expect(() => prefetchDates('2026-02-30')).toThrow(RangeError);
  });
});

describe('local release times', () => {
  const release = utc('2026-07-02T00:00:00Z');

  it('shows the one release instant in each player’s own time', () => {
    expect(plain(localTimeText(release, { locale: 'en-US', timeZone: 'America/New_York' }))).toBe('8:00 PM');
    expect(plain(localTimeText(release, { locale: 'en-US', timeZone: 'America/Los_Angeles' }))).toBe('5:00 PM');
    expect(plain(localTimeText(release, { locale: 'en-AU', timeZone: 'Australia/Sydney' }))).toMatch(/^10:00\sam$/i);
    expect(plain(localTimeText(release, { locale: 'en-GB', timeZone: 'Europe/London' }))).toBe('1:00');
    expect(plain(localTimeText(release, { locale: 'en-IN', timeZone: 'Asia/Kolkata' }))).toMatch(/^5:30\sam$/i);
  });

  it('follows daylight saving in the local time, while the UTC release stays put', () => {
    const winter = utc('2026-01-15T00:00:00Z');
    expect(plain(localTimeText(winter, { locale: 'en-US', timeZone: 'America/New_York' }))).toBe('7:00 PM');
  });

  it('counts down in plain words: whole hours from an hour up, minutes below it', () => {
    expect(countdownText(6 * HOUR + 12 * 60_000, 'en')).toBe('in 6 hours');
    expect(countdownText(HOUR, 'en')).toBe('in 1 hour');
    expect(countdownText(59 * 60_000 + 1, 'en')).toBe('in 1 hour');
    expect(countdownText(45 * 60_000, 'en')).toBe('in 45 minutes');
    expect(countdownText(1, 'en')).toBe('in 1 minute');
    expect(countdownText(24 * HOUR, 'en')).toBe('in 24 hours');
  });

  it('refuses times that are not real', () => {
    expect(() => localTimeText(Number.NaN)).toThrow(RangeError);
    expect(() => countdownText(Number.NaN)).toThrow(RangeError);
  });
});
