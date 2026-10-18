import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from './store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dbPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-store-'));
  dirs.push(dir);
  return join(dir, 'content.db');
};

describe('the content store', () => {
  it('rolls back the withdrawal and its event if inserting a staff correction fails', () => {
    const path = dbPath();
    const store = openStore(path);
    const previous = store.createItem({
      gameId: 'g',
      puzzleId: 'g:2026-10-08',
      date: '2026-10-08',
      inputs: {},
      seed: 's',
      answer: 'apple',
      now: 0,
    });
    store.updateItem(previous.id, { status: 'published', config: { word: 'apple' } }, 1, { kind: 'published' });
    const before = store.events(previous.id);
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER refuse_correction BEFORE INSERT ON items WHEN NEW.source = 'staff' BEGIN SELECT RAISE(ABORT, 'write refused'); END",
    );
    raw.close();
    try {
      expect(() =>
        store.replaceItem({
          expectedId: previous.id,
          actor: 'staff',
          note: 'Correction',
          now: 2,
          source: 'staff',
          status: 'published',
          config: { word: 'pear' },
          answer: 'pear',
          hash: '0123456789ab',
          size: 10,
        }),
      ).toThrow('write refused');
      expect(store.current(previous.puzzleId)).toMatchObject({
        id: previous.id,
        status: 'published',
        config: { word: 'apple' },
      });
      expect(store.history(previous.puzzleId)).toHaveLength(1);
      expect(store.events(previous.id)).toEqual(before);
    } finally {
      store.close();
    }
  });
  it('keeps one current item per puzzle and an event log of what happened to it', () => {
    const store = openStore(':memory:');
    const item = store.createItem({
      gameId: 'g',
      puzzleId: 'g:2026-10-08',
      date: '2026-10-08',
      inputs: { word: 'a' },
      seed: 's',
      answer: 'a',
      now: 0,
    });
    expect(item.status).toBe('scheduled');
    expect(() =>
      store.createItem({
        gameId: 'g',
        puzzleId: 'g:2026-10-08',
        date: '2026-10-08',
        inputs: {},
        seed: 's',
        answer: null,
        now: 0,
      }),
    ).toThrow();
    store.updateItem(item.id, { status: 'validated', config: { x: 1 } }, 1, { kind: 'validated' });
    expect(store.current('g:2026-10-08')?.config).toEqual({ x: 1 });
    const withdrawn = store.withdraw('g:2026-10-08', 'unsafe', 'staff@example.invalid', 2);
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'unsafe',
      withdrawnBy: 'staff@example.invalid',
    });
    expect(store.current('g:2026-10-08')).toBeNull();
    expect(store.events(item.id).map((e) => e.kind)).toEqual(['scheduled', 'validated', 'withdrawn']);
    // A withdrawn answer still counts as used; a new item may take the slot.
    expect(store.usedAnswers('g', '2026-01-01', '2026-12-31')).toEqual([
      { date: '2026-10-08', answer: 'a', status: 'withdrawn' },
    ]);
    store.createItem({
      gameId: 'g',
      puzzleId: 'g:2026-10-08',
      date: '2026-10-08',
      inputs: {},
      seed: 's',
      answer: 'b',
      now: 3,
    });
    expect(store.history('g:2026-10-08')).toHaveLength(2);
    store.close();
  });

  it('lets one run hold the lock at a time, until it releases it or the lock expires', () => {
    const path = dbPath();
    const scheduler = openStore(path);
    const manual = openStore(path); // a second process: the admin's `content run`
    expect(scheduler.tryLock('run', 'serve', 1000, 60_000)).toBe(true);
    expect(manual.tryLock('run', 'manual', 2000, 60_000)).toBe(false);
    expect(manual.lockHolder('run', 2000)).toMatchObject({ owner: 'serve' });
    expect(scheduler.tryLock('run', 'serve', 3000, 60_000)).toBe(true); // refresh
    scheduler.releaseLock('run', 'serve');
    expect(manual.tryLock('run', 'manual', 4000, 60_000)).toBe(true);
    // A crashed holder's lock expires.
    expect(scheduler.tryLock('run', 'serve', 4000 + 60_001, 60_000)).toBe(true);
    scheduler.close();
    manual.close();
  });

  it('records runs', () => {
    const store = openStore(':memory:');
    const id = store.startRun('schedule', 0);
    store.finishRun(id, 'ok', { slots: [] }, 10);
    expect(store.recentRuns(5)).toEqual([
      {
        id,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(10).toISOString(),
        trigger: 'schedule',
        status: 'ok',
        summary: { slots: [] },
      },
    ]);
    store.close();
  });

  it('refuses a database from a newer build', () => {
    const path = dbPath();
    openStore(path).close();
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => openStore(path)).toThrow(/newer than this build/);
  });
});
