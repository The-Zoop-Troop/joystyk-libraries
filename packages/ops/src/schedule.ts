// Scheduled backups inside each service's own process (D-62, the same rule as D-56 for the
// content service): no host cron, no cron daemon and no cron library. A backup runs every
// BACKUP_INTERVAL_MINUTES at fixed UTC times anchored on BACKUP_AT, so the default (1440 and
// 03:17) is one backup a night at 03:17 UTC, and 60 gives one at 17 minutes past every hour.
// Each wait is computed afresh from the wall clock, so the schedule never drifts, and UTC has no
// daylight saving to skip or repeat an hour. Nothing runs at startup: a container that restarts
// in a loop must not fill its volume with copies.
import { dirname, join } from 'node:path';
import * as z from 'zod';
import { backupDatabase, DEFAULT_KEEP, type BackupResult, type Keep } from './backup.ts';

export interface BackupSchedule {
  /** Minutes between backups; divides a day. */
  readonly intervalMinutes: number;
  /** Minutes past each interval boundary, in UTC. */
  readonly offsetMinutes: number;
}

/** The first scheduled instant strictly after `now`. */
export const nextBackupAt = (now: number, schedule: BackupSchedule): number => {
  const period = schedule.intervalMinutes * 60_000;
  const offset = schedule.offsetMinutes * 60_000;
  return (Math.floor((now - offset) / period) + 1) * period + offset;
};

export interface BackupSettings {
  /** Null when BACKUP_INTERVAL_MINUTES is 0: only on-demand backups (deploy/backup.sh). */
  readonly schedule: BackupSchedule | null;
  readonly keep: Keep;
}

export interface MetricsSettings {
  readonly host: string;
  readonly port: number;
}

export interface OpsSettings {
  readonly backup: BackupSettings;
  /** Null when METRICS_PORT is unset: no metrics listener. */
  readonly metrics: MetricsSettings | null;
}

const blankToUndefined = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional());
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const OpsEnv = z.object({
  /** Minutes between scheduled backups; must divide 1440. 0 turns the schedule off. */
  BACKUP_INTERVAL_MINUTES: optional(
    int(0, 1440).refine((m) => m === 0 || 1440 % m === 0, 'must be 0 (off) or divide 1440 (a day), e.g. 60, 360, 1440'),
  ).default(1440),
  /** The UTC time the schedule is anchored on, HH:MM. */
  BACKUP_AT: optional(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a UTC time such as 03:17')).default(
    '03:17',
  ),
  /** The newest backups kept per database. */
  BACKUP_KEEP: optional(int(1, 10_000)).default(DEFAULT_KEEP.newest),
  /** Also keep the newest backup of each of this many most recent UTC days. */
  BACKUP_KEEP_DAILY: optional(int(0, 10_000)).default(DEFAULT_KEEP.daily),
  /** The internal metrics port. Unset: no metrics listener. */
  METRICS_PORT: optional(int(1, 65_535)),
  METRICS_HOST: optional(z.string()).default('0.0.0.0'),
});

/** Reads the backup and metrics settings from the environment, or lists every problem. */
export const parseOpsEnv = (
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; settings: OpsSettings } | { ok: false; issues: string[] } => {
  const parsed = OpsEnv.safeParse(env);
  if (!parsed.success)
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    };
  const e = parsed.data;
  const [hours, minutes] = e.BACKUP_AT.split(':').map(Number);
  const anchor = (hours ?? 0) * 60 + (minutes ?? 0);
  return {
    ok: true,
    settings: {
      backup: {
        schedule:
          e.BACKUP_INTERVAL_MINUTES === 0
            ? null
            : { intervalMinutes: e.BACKUP_INTERVAL_MINUTES, offsetMinutes: anchor % e.BACKUP_INTERVAL_MINUTES },
        keep: { newest: e.BACKUP_KEEP, daily: e.BACKUP_KEEP_DAILY },
      },
      metrics: e.METRICS_PORT === undefined ? null : { host: e.METRICS_HOST, port: e.METRICS_PORT },
    },
  };
};

export const describeSchedule = (schedule: BackupSchedule | null): string => {
  if (schedule === null) return 'off';
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return schedule.intervalMinutes === 1440
    ? `daily at ${hhmm(schedule.offsetMinutes)} UTC`
    : `every ${String(schedule.intervalMinutes)} min at +${String(schedule.offsetMinutes)} min (UTC)`;
};

export interface Timers {
  now(): number;
  /** Calls `fire` after `ms`; the returned function cancels it. */
  after(ms: number, fire: () => void): () => void;
}

export const systemTimers: Timers = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const handle = setTimeout(fire, Math.max(0, ms));
    // The service's own server keeps the process alive; a pending backup must not.
    handle.unref();
    return () => clearTimeout(handle);
  },
};

export interface Scheduler {
  /** The next scheduled run (epoch ms), or null once stopped. */
  next(): number | null;
  /** Cancels the timer and waits for a run in progress. */
  stop(): Promise<void>;
}

/** Runs `run` on the schedule until stopped. `run` must not throw; it reports its own outcome. */
export const startSchedule = (
  schedule: BackupSchedule,
  run: () => Promise<void>,
  timers: Timers = systemTimers,
): Scheduler => {
  let stopped = false;
  let nextAt: number | null = null;
  let cancel: (() => void) | null = null;
  let running: Promise<void> | null = null;

  const arm = (): void => {
    if (stopped) return;
    const at = nextBackupAt(timers.now(), schedule);
    nextAt = at;
    const wake = (): void => {
      if (stopped) return;
      // Timers can fire early; wait out the rest rather than running before the scheduled time.
      if (timers.now() < at) {
        cancel = timers.after(at - timers.now(), wake);
        return;
      }
      running = run().finally(() => {
        running = null;
        arm();
      });
    };
    cancel = timers.after(at - timers.now(), wake);
  };
  arm();

  return {
    next: () => (stopped ? null : nextAt),
    stop: async () => {
      stopped = true;
      nextAt = null;
      cancel?.();
      await running;
    },
  };
};

export interface ScheduledDatabase {
  /** The live database file. */
  readonly file: string;
  /** Where its copies go; default `backups/` beside it. */
  readonly dir?: string;
  /** Skip, rather than fail, while the database doesn't exist yet. */
  readonly ifExists?: boolean;
}

export type BackupReport =
  BackupResult | { readonly event: 'backup_failed'; readonly database: string; readonly error: string };

export interface ScheduleBackupsOptions {
  readonly settings: BackupSettings;
  readonly databases: readonly ScheduledDatabase[];
  /** One call per database per run: the service writes it as a log line in its own format. */
  readonly report: (report: BackupReport) => void;
  readonly timers?: Timers;
}

/** Backs up each database on the schedule. Returns null when the schedule is off. */
export const scheduleBackups = (options: ScheduleBackupsOptions): Scheduler | null => {
  const { schedule, keep } = options.settings;
  if (schedule === null) return null;
  return startSchedule(
    schedule,
    async () => {
      for (const db of options.databases) {
        try {
          options.report(
            await backupDatabase(db.file, db.dir ?? join(dirname(db.file), 'backups'), {
              keep,
              ifExists: db.ifExists === true,
            }),
          );
        } catch (error) {
          options.report({
            event: 'backup_failed',
            database: db.file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    options.timers,
  );
};
