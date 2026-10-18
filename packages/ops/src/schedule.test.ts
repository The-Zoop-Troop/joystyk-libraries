import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeSchedule,
  nextBackupAt,
  parseOpsEnv,
  scheduleBackups,
  startSchedule,
  type BackupReport,
  type Timers,
} from './schedule.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('parseOpsEnv', () => {
  it('defaults to one backup a night at 03:17 UTC, keeping 14 and 14, and no metrics listener', () => {
    const parsed = parseOpsEnv({});
    expect(parsed).toEqual({
      ok: true,
      settings: {
        backup: { schedule: { intervalMinutes: 1440, offsetMinutes: 197 }, keep: { newest: 14, daily: 14 } },
        metrics: null,
      },
    });
    if (parsed.ok) expect(describeSchedule(parsed.settings.backup.schedule)).toBe('daily at 03:17 UTC');
  });

  it('treats blank values as unset, as Compose passes them', () => {
    expect(parseOpsEnv({ BACKUP_INTERVAL_MINUTES: '', BACKUP_AT: ' ', METRICS_PORT: '' })).toEqual(parseOpsEnv({}));
  });

  it('anchors an interval on BACKUP_AT and turns the schedule off with 0', () => {
    const hourly = parseOpsEnv({
      BACKUP_INTERVAL_MINUTES: '60',
      BACKUP_AT: '02:45',
      BACKUP_KEEP: '48',
      METRICS_PORT: '9464',
    });
    expect(hourly.ok && hourly.settings).toEqual({
      backup: { schedule: { intervalMinutes: 60, offsetMinutes: 45 }, keep: { newest: 48, daily: 14 } },
      metrics: { host: '0.0.0.0', port: 9464 },
    });
    if (hourly.ok) expect(describeSchedule(hourly.settings.backup.schedule)).toBe('every 60 min at +45 min (UTC)');
    const off = parseOpsEnv({ BACKUP_INTERVAL_MINUTES: '0' });
    expect(off.ok && off.settings.backup.schedule).toBeNull();
  });

  it('lists every problem at once', () => {
    const parsed = parseOpsEnv({
      BACKUP_INTERVAL_MINUTES: '7',
      BACKUP_AT: '3:17',
      BACKUP_KEEP: '0',
      METRICS_PORT: 'http',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.issues.map((issue) => issue.split(':')[0])).toEqual([
        'BACKUP_INTERVAL_MINUTES',
        'BACKUP_AT',
        'BACKUP_KEEP',
        'METRICS_PORT',
      ]);
  });
});

describe('nextBackupAt', () => {
  it('gives the next anchored time, strictly after now', () => {
    const nightly = { intervalMinutes: 1440, offsetMinutes: 197 };
    expect(iso(nextBackupAt(at('2026-10-09T00:00:00Z'), nightly))).toBe('2026-10-09T03:17:00.000Z');
    expect(iso(nextBackupAt(at('2026-10-09T03:17:00Z'), nightly))).toBe('2026-10-10T03:17:00.000Z');
    expect(iso(nextBackupAt(at('2026-10-09T23:59:59Z'), { intervalMinutes: 60, offsetMinutes: 17 }))).toBe(
      '2026-10-10T00:17:00.000Z',
    );
  });
});

/** Timers driven by hand: `advance` moves the clock and fires what is due, in order. */
const manualTimers = (start: number) => {
  let now = start;
  let pending: { at: number; fire: () => void }[] = [];
  const timers: Timers = {
    now: () => now,
    after: (ms, fire) => {
      const entry = { at: now + ms, fire };
      pending.push(entry);
      return () => {
        pending = pending.filter((p) => p !== entry);
      };
    },
  };
  const advance = async (to: number) => {
    for (;;) {
      const due = pending.filter((p) => p.at <= to).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      pending = pending.filter((p) => p !== due);
      now = due.at;
      due.fire();
      // Let a run's promise settle and re-arm.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
    now = to;
  };
  return { timers, advance, pending: () => pending.length };
};

describe('startSchedule', () => {
  it('runs at each scheduled time, never at start, and stops', async () => {
    const clock = manualTimers(at('2026-10-09T12:00:00Z'));
    const runs: string[] = [];
    const scheduler = startSchedule(
      { intervalMinutes: 1440, offsetMinutes: 197 },
      async () => void runs.push(iso(clock.timers.now())),
      clock.timers,
    );
    expect(runs).toEqual([]);
    expect(iso(scheduler.next() ?? 0)).toBe('2026-10-10T03:17:00.000Z');
    await clock.advance(at('2026-10-12T00:00:00Z'));
    expect(runs).toEqual(['2026-10-10T03:17:00.000Z', '2026-10-11T03:17:00.000Z']);
    await scheduler.stop();
    expect(scheduler.next()).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it('waits out a timer that fires early instead of running ahead of time', async () => {
    let now = at('2026-10-09T03:00:00Z');
    const fires: (() => void)[] = [];
    const timers: Timers = { now: () => now, after: (_ms, fire) => (fires.push(fire), () => undefined) };
    const runs: number[] = [];
    startSchedule({ intervalMinutes: 1440, offsetMinutes: 197 }, async () => void runs.push(now), timers);
    now = at('2026-10-09T03:16:59Z');
    fires.shift()?.();
    expect(runs).toEqual([]);
    now = at('2026-10-09T03:17:00Z');
    fires.shift()?.();
    expect(runs).toEqual([at('2026-10-09T03:17:00Z')]);
  });
});

describe('scheduleBackups', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'joystyk-ops-schedule-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is off when the schedule is', () => {
    expect(
      scheduleBackups({
        settings: { schedule: null, keep: { newest: 1, daily: 0 } },
        databases: [],
        report: () => undefined,
      }),
    ).toBeNull();
  });

  it('backs up each database into backups/ beside it, reporting one line each, failures included', async () => {
    const file = join(dir, 'rooms.sqlite');
    const live = new DatabaseSync(file);
    live.exec('CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1);');
    const clock = manualTimers(at('2026-10-09T03:16:00Z'));
    const reports: BackupReport[] = [];
    const scheduler = scheduleBackups({
      settings: { schedule: { intervalMinutes: 1440, offsetMinutes: 197 }, keep: { newest: 2, daily: 0 } },
      databases: [{ file }, { file: join(dir, 'content.db'), ifExists: true }, { file: join(dir, 'missing.db') }],
      report: (report) => void reports.push(report),
      timers: clock.timers,
    });
    try {
      await clock.advance(at('2026-10-09T03:17:00Z'));
      await expect.poll(() => reports.length).toBe(3);
      expect(reports.map((r) => r.event)).toEqual(['backup_written', 'backup_skipped', 'backup_failed']);
      expect(await readdir(join(dir, 'backups'))).toHaveLength(1);
    } finally {
      await scheduler?.stop();
      live.close();
    }
  });
});
