// Today from the device clock, and the next release in local time, in real Chromium.
import { describe, expect, it } from 'vitest';
import { nextReleaseLocal, timeUntilNextDay, today, watchDay } from './index.ts';

const HOUR = 3_600_000;
const plain = (text: string): string => text.replace(/\s/gu, ' ');

describe('today', () => {
  it("is the UTC date of the device clock, whatever the device's zone", () => {
    const now = new Date();
    expect(today({ now: () => now.getTime() })).toBe(now.toISOString().slice(0, 10));
    expect(today({ now: () => Date.parse('2026-10-08T23:59:59Z') })).toBe('2026-10-08');
    expect(today({ now: () => Date.parse('2026-10-09T00:00:00Z') })).toBe('2026-10-09');
  });

  it('counts the time until the next UTC day', () => {
    expect(timeUntilNextDay({ now: () => Date.parse('2026-10-08T18:00:00Z') })).toBe(6 * HOUR);
    const left = timeUntilNextDay();
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(24 * HOUR);
  });
});

describe('nextReleaseLocal', () => {
  it('gives the next release as a local time and a plain countdown', () => {
    const next = nextReleaseLocal({
      now: () => Date.parse('2026-07-01T18:00:00Z'),
      locale: 'en-US',
      timeZone: 'America/New_York',
    });
    expect(next).toMatchObject({ date: '2026-07-02', instant: Date.parse('2026-07-02T00:00:00Z'), inMs: 6 * HOUR });
    expect(plain(next.time)).toBe('8:00 PM');
    expect(next.countdown).toBe('in 6 hours');
  });

  it("uses the device's zone and locale by default", () => {
    const now = Date.parse('2026-10-08T23:15:00Z');
    const next = nextReleaseLocal({ now: () => now });
    expect(next.date).toBe('2026-10-09');
    expect(next.time).toBe(
      new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(next.instant),
    );
    expect(next.inMs).toBe(45 * 60_000);
  });
});

describe('watchDay', () => {
  it('reports a date change on visibilitychange and at safe points, and stops cleanly', () => {
    const target = new EventTarget();
    let instant = Date.parse('2026-10-08T23:00:00Z');
    const changes: [string, string][] = [];
    const watcher = watchDay((date, previous) => changes.push([date, previous]), { now: () => instant, target });

    target.dispatchEvent(new Event('visibilitychange'));
    expect(changes).toEqual([]);

    instant = Date.parse('2026-10-09T07:00:00Z');
    target.dispatchEvent(new Event('visibilitychange'));
    expect(changes).toEqual([['2026-10-09', '2026-10-08']]);

    instant = Date.parse('2026-10-10T07:00:00Z');
    watcher.check();
    expect(changes).toEqual([
      ['2026-10-09', '2026-10-08'],
      ['2026-10-10', '2026-10-09'],
    ]);

    watcher.stop();
    watcher.stop();
    instant = Date.parse('2026-10-11T07:00:00Z');
    target.dispatchEvent(new Event('visibilitychange'));
    watcher.check();
    expect(changes).toHaveLength(2);
  });
});
