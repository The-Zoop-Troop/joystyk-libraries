// Online backup of a live SQLite database (room-server.md section 6.6; Greed's
// scripts/backup.ts). Safe while the service writes: node:sqlite's backup() copies a consistent
// snapshot page by page. The copy is written under a `.partial` name, checked with
// PRAGMA integrity_check, then linked into place, so a backup cut short (a container stopping)
// never leaves a file that looks complete, and an existing file is never overwritten. Old copies
// are pruned: the newest `keep.newest`, plus the newest copy of each of the last `keep.daily`
// UTC days.
//
// This file imports only Node built-ins: every image copies it next to
// scripts/sqlite-backup.ts, the command deploy/backup.sh runs, without the rest of the package.
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export interface Keep {
  /** The newest copies to keep, whatever their age. At least 1. */
  readonly newest: number;
  /** Also keep the newest copy of each of this many most recent UTC days. */
  readonly daily: number;
}

export const DEFAULT_KEEP: Keep = { newest: 14, daily: 14 };

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const PARTIAL = '.partial';
/** A `.partial` file older than this belongs to a backup that was cut short. */
const STALE_PARTIAL_MS = 60 * 60_000;

/** 2026-10-08T03:15:00.123Z → 20261008T031500Z: sortable, and safe in a file name. */
export const stampOf = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');

/** The prefix a database's backups share: `rooms` for /data/rooms.sqlite. */
export const backupPrefix = (database: string): string => basename(database, extname(database));

export const backupName = (database: string, date: Date): string => `${backupPrefix(database)}-${stampOf(date)}.sqlite`;

/**
 * The backups to delete among `names` (file names in the backup folder). Only names this
 * module writes for `prefix` count; anything else in the folder is left alone.
 */
export function backupsToPrune(names: readonly string[], prefix: string, keep: Keep): string[] {
  const ours = names
    .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.sqlite'))
    .map((name) => ({ name, stamp: name.slice(prefix.length + 1, -'.sqlite'.length) }))
    .filter((b) => STAMP.test(b.stamp))
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  const kept = new Set(ours.slice(0, Math.max(0, keep.newest)).map((b) => b.name));
  const days = new Set<string>();
  for (const b of ours) {
    const day = b.stamp.slice(0, 8);
    if (days.has(day)) continue;
    if (days.size >= Math.max(0, keep.daily)) break;
    days.add(day);
    kept.add(b.name);
  }
  return ours.filter((b) => !kept.has(b.name)).map((b) => b.name);
}

export type BackupResult =
  | {
      readonly event: 'backup_written';
      readonly file: string;
      readonly bytes: number;
      readonly pruned: number;
      readonly ms: number;
    }
  | { readonly event: 'backup_skipped'; readonly reason: 'no database'; readonly database: string };

export interface BackupOptions {
  readonly keep?: Keep;
  /** A missing database is skipped instead of failing (the content service's, before its first run). */
  readonly ifExists?: boolean;
  readonly now?: () => Date;
}

/** Copies `source` into `dir`, checks the copy and prunes old ones. Throws when the backup fails. */
export async function backupDatabase(source: string, dir: string, options: BackupOptions = {}): Promise<BackupResult> {
  const keep = options.keep ?? DEFAULT_KEEP;
  const now = options.now ?? (() => new Date());
  if (!Number.isInteger(keep.newest) || !Number.isInteger(keep.daily) || keep.newest < 1 || keep.daily < 0) {
    throw new Error('keep.newest must be an integer of at least 1, and keep.daily at least 0');
  }
  if (!existsSync(source)) {
    if (options.ifExists === true) return { event: 'backup_skipped', reason: 'no database', database: resolve(source) };
    throw new Error(`the database ${source} does not exist`);
  }
  const started = performance.now();
  const prefix = backupPrefix(source);
  mkdirSync(dir, { recursive: true });
  removeStalePartials(dir, prefix, now().getTime());
  const target = join(dir, backupName(source, now()));
  const partial = `${target}${PARTIAL}`;
  if (existsSync(target)) throw new Error(`${target} exists; backups are never overwritten`);

  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, partial);
    } finally {
      db.close();
    }
    // The copy inherits WAL mode; switch it to a rollback journal so it stays one self-contained file.
    const copy = new DatabaseSync(partial);
    try {
      copy.exec('PRAGMA journal_mode = DELETE');
      const row = copy.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
      if (row?.integrity_check !== 'ok')
        throw new Error(`the backup failed its integrity check: ${JSON.stringify(row)}`);
    } finally {
      copy.close();
    }
    // A hard link fails if the target appeared meanwhile, where a rename would replace it.
    linkSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }

  const pruned = backupsToPrune(readdirSync(dir), prefix, keep);
  for (const name of pruned) rmSync(join(dir, name), { force: true });
  return {
    event: 'backup_written',
    file: resolve(target),
    bytes: statSync(target).size,
    pruned: pruned.length,
    ms: Math.round(performance.now() - started),
  };
}

/** Deletes `.partial` files this module left behind when a process stopped mid-backup. */
function removeStalePartials(dir: string, prefix: string, now: number): void {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${prefix}-`) || !name.endsWith(`.sqlite${PARTIAL}`)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_PARTIAL_MS) rmSync(path, { force: true });
    } catch {
      // Gone already.
    }
  }
}
