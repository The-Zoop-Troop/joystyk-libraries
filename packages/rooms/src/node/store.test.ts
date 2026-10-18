import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { coreFor, nim, peek, policy, seeds } from '../__tests__/fixtures.ts';
import { tempDir } from '../__tests__/node-helpers.ts';
import type { RoomRecord } from '../types.ts';
import { openSqliteStore, SCHEMA_VERSION } from './store.ts';
import { memoryLogger } from './support.ts';

const temps: { remove: () => void }[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) t.remove();
});

const fresh = () => {
  const t = tempDir();
  temps.push(t);
  return t;
};

const record = (code = 'ABCDEF', core = coreFor(nim, 'nim')): RoomRecord => {
  const created = core.create(
    { code, policy: policy(), config: { heap: 5 }, seeds: seeds(1), creator: { name: 'ana', tokenHash: 'h' } },
    1_000,
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
};

describe('the SQLite room store', () => {
  it('creates the schema and round-trips a record', async () => {
    const t = fresh();
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    const r = record();
    store.insert(r);
    expect(store.exists('ABCDEF')).toBe(true);
    expect(store.load('ABCDEF')).toEqual(r);
    expect(store.load('ZZZZZZ')).toBeNull();
    store.close();
    const db = new DatabaseSync(t.file('rooms.sqlite'));
    expect(db.prepare('PRAGMA user_version').get()?.['user_version']).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('saves only over the expected write count, with the inputs in the same transaction', async () => {
    const t = fresh();
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    const r = record();
    store.insert(r);
    const next = { ...r, writes: 1, revision: 1 };
    const input = { match: 1, revision: 1, at: 5, input: { kind: 'resign' as const, seat: 0 } };
    expect(store.save(next, [input], 0)).toBe('saved');
    expect(store.save({ ...next, writes: 2 }, [{ ...input, revision: 2 }], 0)).toBe('conflict');
    expect(store.load('ABCDEF')?.writes).toBe(1);
    expect(store.inputs('ABCDEF', 1)).toEqual([input]);
    store.close();
  });

  it('refuses a database from a newer build', async () => {
    const t = fresh();
    const db = new DatabaseSync(t.file('rooms.sqlite'));
    db.exec('PRAGMA user_version = 99');
    db.close();
    await expect(openSqliteStore(t.file('rooms.sqlite'))).rejects.toThrow(/newer than this build/);
  });

  it('quarantines a row that fails to decode and treats it as missing', async () => {
    const t = fresh();
    const log = memoryLogger();
    const store = await openSqliteStore(t.file('rooms.sqlite'), { log });
    store.insert(record());
    store.close();
    const db = new DatabaseSync(t.file('rooms.sqlite'));
    db.prepare("UPDATE rooms SET record = json_set(record, '$.seats', 'nonsense')").run();
    db.close();
    const reopened = await openSqliteStore(t.file('rooms.sqlite'), { log });
    expect(reopened.load('ABCDEF')).toBeNull();
    expect(reopened.exists('ABCDEF')).toBe(false);
    expect(log.lines.map((l) => l.event)).toContain('room_corrupt');
    reopened.close();
    const check = new DatabaseSync(t.file('rooms.sqlite'));
    expect(check.prepare('SELECT COUNT(*) AS n FROM room_archive').get()?.['n']).toBe(1);
    check.close();
  });

  it('throws on a record format newer than this build', async () => {
    const t = fresh();
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    store.insert({ ...record(), format: 2 } as unknown as RoomRecord);
    expect(() => store.load('ABCDEF')).toThrow(/newer/);
    store.close();
  });

  it('lists live versions and rooms with pending jobs, prunes expired rows and bumps epochs', async () => {
    const t = fresh();
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    store.insert(record('AAAAAA'));
    const withJob = record('BBBBBB', coreFor(peek, 'peek'));
    store.insert(withJob);
    const match = {
      number: 1,
      game: withJob.game,
      config: {},
      seats: [],
      seed: seeds(1).engine,
      state: {},
      rng: seeds(1).engine,
      aiRng: seeds(1).ai,
      decisionRevision: [],
      clocks: [],
      jobs: [{ request: { id: 'draw-0', kind: 'draw', payload: {} }, revision: 1 }],
      presentation: null,
      log: [],
      outcome: null,
      startedAt: 0,
    };
    store.save({ ...withJob, writes: 1, phase: 'playing', match }, [], 0);
    expect(store.withPendingJobs()).toEqual(['BBBBBB']);
    expect(store.liveVersions()).toEqual(
      expect.arrayContaining([
        { gameId: 'nim', rulesVersion: 1, rooms: 1 },
        { gameId: 'peek', rulesVersion: 1, rooms: 1 },
      ]),
    );
    expect(store.bumpEpochs()).toBe(2);
    expect(store.load('AAAAAA')?.epoch).toBe(1);
    expect(store.prune(1_000 + 86_400_000 + 1)).toBe(2);
    expect(store.exists('AAAAAA')).toBe(false);
    expect(store.ping()).toBe(true);
    store.close();
  });

  it('writes a checked backup and never overwrites one', async () => {
    const t = fresh();
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    store.insert(record());
    await store.backup(t.file('backup.sqlite'));
    await expect(store.backup(t.file('backup.sqlite'))).rejects.toThrow(/overwrite/);
    store.close();
    const copy = await openSqliteStore(t.file('backup.sqlite'));
    expect(copy.exists('ABCDEF')).toBe(true);
    copy.close();
  });
});

it('opens the room connection with FULL synchronous durability before saving', async () => {
  const t = fresh();
  const original = DatabaseSync.prototype.exec;
  const statements: string[] = [];
  DatabaseSync.prototype.exec = function (sql: string) {
    statements.push(sql);
    return original.call(this, sql);
  };
  try {
    const store = await openSqliteStore(t.file('durable.sqlite'));
    store.insert(record());
    store.close();
    expect(statements.some((sql) => /PRAGMA synchronous = FULL/.test(sql))).toBe(true);
  } finally {
    DatabaseSync.prototype.exec = original;
  }
});
