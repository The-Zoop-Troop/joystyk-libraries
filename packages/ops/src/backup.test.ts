import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, backupName, backupsToPrune, stampOf } from './backup.ts';

describe('backup names', () => {
  it('stamps a UTC time that sorts as text', () => {
    expect(stampOf(new Date('2026-10-08T03:15:09.123Z'))).toBe('20261008T031509Z');
    expect(backupName('/data/rooms.sqlite', new Date('2026-10-08T03:15:09Z'))).toBe('rooms-20261008T031509Z.sqlite');
    expect(backupName('/data/site.db', new Date('2026-10-08T03:15:09Z'))).toBe('site-20261008T031509Z.sqlite');
  });
});

describe('backupsToPrune', () => {
  const copiesFor = (day: string, hours: number[]) =>
    hours.map((h) => `rooms-${day}T${String(h).padStart(2, '0')}0000Z.sqlite`);

  it('keeps the newest copies and the newest copy of each recent day', () => {
    const names = [
      ...copiesFor('20261006', [1, 2]),
      ...copiesFor('20261007', [1, 2]),
      ...copiesFor('20261008', [1, 2, 3]),
    ];
    expect(backupsToPrune(names, 'rooms', { newest: 2, daily: 2 }).sort()).toEqual([
      ...copiesFor('20261006', [1, 2]),
      ...copiesFor('20261007', [1]),
      ...copiesFor('20261008', [1]),
    ]);
  });

  it('keeps exactly N nightly copies when only the newest count', () => {
    const names = ['01', '02', '03', '04', '05'].map((d) => `site-202610${d}T031700Z.sqlite`);
    expect(backupsToPrune(names, 'site', { newest: 3, daily: 0 }).sort()).toEqual([
      'site-20261001T031700Z.sqlite',
      'site-20261002T031700Z.sqlite',
    ]);
  });

  it('leaves other files alone: another database, a hand-made copy, a partial copy, a foreign name', () => {
    const names = [
      'site-20261008T010000Z.sqlite',
      'rooms-before-restore.sqlite',
      'rooms-20261008T000000Z.sqlite.partial',
      'notes.txt',
      ...copiesFor('20261008', [1, 2]),
    ];
    expect(backupsToPrune(names, 'rooms', { newest: 1, daily: 0 })).toEqual(copiesFor('20261008', [1]));
  });
});

describe('backupDatabase', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'joystyk-ops-backup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const liveDatabase = (file: string): DatabaseSync => {
    const live = new DatabaseSync(file);
    live.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2), (3);');
    return live;
  };

  it('copies a live WAL database consistently, checks it and leaves no partial file', async () => {
    const source = join(dir, 'rooms.sqlite');
    const live = liveDatabase(source);
    try {
      const result = await backupDatabase(source, join(dir, 'backups'), {
        now: () => new Date('2026-10-09T03:17:00Z'),
      });
      expect(result).toMatchObject({
        event: 'backup_written',
        pruned: 0,
        file: join(dir, 'backups', 'rooms-20261009T031700Z.sqlite'),
      });
      if (result.event !== 'backup_written') throw new Error('expected a backup');
      expect(result.bytes).toBeGreaterThan(0);
      const copy = new DatabaseSync(result.file, { readOnly: true });
      expect(copy.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
      expect(copy.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
      copy.close();
    } finally {
      live.close();
    }
    expect(await readdir(join(dir, 'backups'))).toEqual(['rooms-20261009T031700Z.sqlite']);
  });

  it('never overwrites a backup', async () => {
    const source = join(dir, 'rooms.sqlite');
    const live = liveDatabase(source);
    const now = () => new Date('2026-10-09T03:17:00Z');
    try {
      await backupDatabase(source, join(dir, 'backups'), { now });
      await expect(backupDatabase(source, join(dir, 'backups'), { now })).rejects.toThrow(/never overwritten/);
    } finally {
      live.close();
    }
  });

  it('prunes old copies after writing, and removes stale partial files', async () => {
    const source = join(dir, 'site.db');
    const live = liveDatabase(source);
    const backups = join(dir, 'backups');
    try {
      for (const day of ['05', '06', '07'])
        await backupDatabase(source, backups, {
          keep: { newest: 2, daily: 0 },
          now: () => new Date(`2026-10-${day}T03:17:00Z`),
        });
      const stale = join(backups, 'site-20261001T031700Z.sqlite.partial');
      await writeFile(stale, 'cut short');
      await utimes(stale, new Date('2026-10-01T03:17:00Z'), new Date('2026-10-01T03:17:00Z'));
      const result = await backupDatabase(source, backups, {
        keep: { newest: 2, daily: 0 },
        now: () => new Date('2026-10-08T03:17:00Z'),
      });
      expect(result).toMatchObject({ event: 'backup_written', pruned: 1 });
    } finally {
      live.close();
    }
    expect((await readdir(backups)).sort()).toEqual(['site-20261007T031700Z.sqlite', 'site-20261008T031700Z.sqlite']);
  });

  it('skips a missing database only when asked to', async () => {
    const missing = join(dir, 'content.db');
    await expect(backupDatabase(missing, join(dir, 'backups'), { ifExists: true })).resolves.toMatchObject({
      event: 'backup_skipped',
      reason: 'no database',
    });
    await expect(backupDatabase(missing, join(dir, 'backups'))).rejects.toThrow(/does not exist/);
  });

  it('refuses a retention that would delete every copy', async () => {
    await expect(backupDatabase(join(dir, 'x.sqlite'), dir, { keep: { newest: 0, daily: 3 } })).rejects.toThrow(
      /at least 1/,
    );
  });
});
