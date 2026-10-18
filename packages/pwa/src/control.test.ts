import { describe, expect, it } from 'vitest';
import {
  canonicalReleaseTime,
  capMinimumRelease,
  mustUpdate,
  parseControl,
  parseReleaseRecord,
  releaseTimeMs,
  type Control,
} from './control.ts';

const flags = (minimumRelease?: string): Control =>
  minimumRelease === undefined
    ? { schemaVersion: 1, serviceWorker: 'enabled' }
    : { schemaVersion: 1, serviceWorker: 'enabled', minimumRelease };

describe('release times', () => {
  it('read RFC 3339 date-times in UTC or with an offset, as git prints them', () => {
    expect(releaseTimeMs('2026-10-09T14:03:12Z')).toBe(Date.UTC(2026, 9, 9, 14, 3, 12));
    expect(releaseTimeMs('2026-10-09T16:03:12+02:00')).toBe(Date.UTC(2026, 9, 9, 14, 3, 12));
    expect(releaseTimeMs('2026-10-09T14:03:12.250Z')).toBe(Date.UTC(2026, 9, 9, 14, 3, 12, 250));
  });

  it('refuse anything vaguer or malformed', () => {
    for (const value of [
      '2026-10-09',
      '2026-10-09T14:03Z',
      '2026-10-09 14:03:12Z',
      '2026-10-09T14:03:12',
      '2026-13-40T99:99:99Z',
      'next week',
      '',
      1_760_000_000_000,
      null,
    ]) {
      expect(releaseTimeMs(value), String(value)).toBeNull();
    }
  });

  it('have one canonical form: UTC, whole seconds', () => {
    expect(canonicalReleaseTime('2026-10-09T16:03:12+02:00')).toBe('2026-10-09T14:03:12Z');
    expect(canonicalReleaseTime('2026-10-09T14:03:12.999Z')).toBe('2026-10-09T14:03:12Z');
    expect(canonicalReleaseTime('yesterday')).toBeNull();
  });
});

describe('parseControl', () => {
  it('takes an optional minimum release, kept as written', () => {
    expect(parseControl({ schemaVersion: 1, serviceWorker: 'enabled' })).toEqual(flags());
    expect(
      parseControl({ schemaVersion: 1, serviceWorker: 'enabled', minimumRelease: '2026-10-09T14:03:12Z' }),
    ).toEqual(flags('2026-10-09T14:03:12Z'));
    expect(
      parseControl({ schemaVersion: 1, serviceWorker: 'disabled', minimumRelease: '2026-10-09T16:03:12+02:00' }),
    ).toEqual({
      schemaVersion: 1,
      serviceWorker: 'disabled',
      minimumRelease: '2026-10-09T16:03:12+02:00',
    });
  });

  it('drops unknown keys and refuses a minimum that is not a date-time', () => {
    expect(parseControl({ ...flags(), note: 'hello' })).toEqual(flags());
    for (const minimumRelease of ['0123abcd4567', '2026-10-09', 20261009, null]) {
      expect(
        parseControl({ schemaVersion: 1, serviceWorker: 'enabled', minimumRelease }),
        String(minimumRelease),
      ).toBeNull();
    }
  });
});

describe('mustUpdate', () => {
  const own = '2026-10-09T12:00:00Z';

  it('forces a release older than the minimum, and only that', () => {
    expect(mustUpdate(flags('2026-10-09T12:00:01Z'), own)).toBe(true);
    expect(mustUpdate(flags('2026-10-09T14:00:01+02:00'), own)).toBe(true);
    expect(mustUpdate(flags('2026-10-09T12:00:00Z'), own)).toBe(false);
    expect(mustUpdate(flags('2026-10-09T13:00:00+02:00'), own)).toBe(false);
    expect(mustUpdate(flags('2025-01-01T00:00:00Z'), own)).toBe(false);
  });

  it('forces nothing without a minimum, without a flag file (offline), or without a readable release time', () => {
    expect(mustUpdate(flags(), own)).toBe(false);
    expect(mustUpdate(null, own)).toBe(false);
    expect(mustUpdate(flags('2999-01-01T00:00:00Z'), '')).toBe(false);
    expect(mustUpdate(flags('2999-01-01T00:00:00Z'), 'test-a')).toBe(false);
  });
});

describe('capMinimumRelease', () => {
  const own = '2026-10-09T12:00:00Z';

  it('brings a minimum later than the running release down to it', () => {
    expect(capMinimumRelease(flags('2999-01-01T00:00:00Z'), own)).toEqual(flags(own));
    expect(mustUpdate(capMinimumRelease(flags('2999-01-01T00:00:00Z'), own), own)).toBe(false);
  });

  it('returns the flags unchanged otherwise', () => {
    for (const control of [flags(), flags('2026-10-01T00:00:00Z'), flags(own)]) {
      expect(capMinimumRelease(control, own)).toBe(control);
    }
    expect(capMinimumRelease(flags('2999-01-01T00:00:00Z'), 'unknown')).toEqual(flags('2999-01-01T00:00:00Z'));
  });
});

describe('parseReleaseRecord', () => {
  it('reads what the build writes beside sw.js, and refuses a damaged record', () => {
    expect(parseReleaseRecord({ release: 'r1', releaseTime: '2026-10-09T12:00:00Z', extra: 1 })).toEqual({
      release: 'r1',
      releaseTime: '2026-10-09T12:00:00Z',
    });
    expect(parseReleaseRecord({ release: '', releaseTime: '2026-10-09T12:00:00Z' })).toBeNull();
    expect(parseReleaseRecord({ release: 'r1', releaseTime: 'today' })).toBeNull();
    expect(parseReleaseRecord('r1')).toBeNull();
  });
});
