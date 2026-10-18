import { ok, type Json } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import {
  createMemoryBackend,
  defineRecordKind,
  openStorage,
  type MemoryBackend,
  type RecordKind,
  type StorageNotice,
} from './index.ts';

// A record kind whose shape changed twice: v1 { n }, v2 { count }, v3 { count, label }.
type Counter = { readonly count: number; readonly label: string };
const COUNTER: RecordKind<Counter> = defineRecordKind<Counter>({
  store: 'identity',
  version: 3,
  schema: z.object({ count: z.int(), label: z.string() }),
  migrations: [
    { from: 1, to: 2, migrate: (old) => ok({ count: (old as { n: number }).n }) },
    { from: 2, to: 3, migrate: (old) => ok({ ...(old as { [key: string]: Json }), label: 'none' }) },
  ],
  label: 'counter',
});

const setup = (kind: RecordKind<Counter> = COUNTER) => {
  const backend = createMemoryBackend();
  const notices: StorageNotice[] = [];
  let clock = 1_000;
  const storage = openStorage({ backend, onNotice: (n) => notices.push(n), now: () => (clock += 1) });
  return { backend, notices, store: storage.records(kind) };
};

const raw = (backend: MemoryBackend, key: string) => backend.peek('identity', key);

describe('record stores', () => {
  it('writes a versioned record and reads it back decoded', async () => {
    const { backend, store } = setup();
    expect(await store.set('a', { count: 2, label: 'x' })).toEqual(ok(undefined));
    expect(raw(backend, 'a')).toEqual({ version: 3, writtenAt: 1_001, value: { count: 2, label: 'x' } });
    expect(await store.get('a')).toEqual(ok({ count: 2, label: 'x' }));
  });

  it('reads an absent key as null without a notice', async () => {
    const { notices, store } = setup();
    expect(await store.get('missing')).toEqual(ok(null));
    expect(notices).toEqual([]);
  });

  it('migrates an old record on read and stores the upgraded shape', async () => {
    const { backend, notices, store } = setup();
    backend.poke('identity', 'old', { version: 1, writtenAt: 5, value: { n: 7 } });
    expect(await store.get('old')).toEqual(ok({ count: 7, label: 'none' }));
    expect(raw(backend, 'old')).toMatchObject({ version: 3, value: { count: 7, label: 'none' } });
    expect(notices).toEqual([]);
  });

  it.each([
    ['not a record at all', 'hello'],
    ['a record without a version', { writtenAt: 1, value: { count: 1, label: 'x' } }],
    ['a value that fails the schema', { version: 3, writtenAt: 1, value: { count: 'many', label: 'x' } }],
    ['a value that is not JSON', { version: 3, writtenAt: 1, value: { count: Number.NaN, label: 'x' } }],
    ['a missing migration step', { version: 0, writtenAt: 1, value: {} }],
  ])('discards %s with a notice, never trusting it', async (_, value) => {
    const { backend, notices, store } = setup();
    backend.poke('identity', 'bad', value);
    expect(await store.get('bad')).toEqual(ok(null));
    expect(raw(backend, 'bad')).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'RecordDiscarded', store: 'identity', key: 'bad' });
    expect(notices[0]?.issues.length).toBeGreaterThan(0);
  });

  it('archives instead of discarding when the kind asks for it', async () => {
    const { backend, notices, store } = setup({ ...COUNTER, onInvalid: 'archive' });
    backend.poke('identity', 'bad', { version: 3, writtenAt: 1, value: { count: 'many' } });
    expect(await store.get('bad')).toEqual(ok(null));
    expect(raw(backend, 'bad')).toBeUndefined();
    expect(notices[0]?.code).toBe('RecordArchived');
    const archived = await backend.keys('archive', 'identity/bad@');
    expect(archived.ok && archived.value).toHaveLength(1);
  });

  it('keeps a record written by a newer build, and says so', async () => {
    const { backend, notices, store } = setup();
    const future = { version: 4, writtenAt: 1, value: { count: 1, label: 'x', extra: true } };
    backend.poke('identity', 'new', future);
    expect(await store.get('new')).toEqual(ok(null));
    expect(raw(backend, 'new')).toEqual(future);
    expect(notices[0]?.code).toBe('RecordFromFuture');
  });

  it('refuses to write a value its schema rejects', async () => {
    const { backend, store } = setup();
    const result = await store.set('a', { count: 1.5, label: 'x' });
    expect(result.ok || result.error.code).toBe('InvalidValue');
    expect(raw(backend, 'a')).toBeUndefined();
  });

  it('writes only when absent, and hands back what the key holds (gp-d4v)', async () => {
    const { backend, store } = setup();
    expect(await store.setIfAbsent('a', { count: 1, label: 'first' })).toEqual(ok({ count: 1, label: 'first' }));
    expect(await store.setIfAbsent('a', { count: 2, label: 'second' })).toEqual(ok({ count: 1, label: 'first' }));
    expect(raw(backend, 'a')).toMatchObject({ value: { count: 1, label: 'first' } });
    // Two writers at once, as two tabs would race: one wins and both see its value.
    const [x, y] = await Promise.all([
      store.setIfAbsent('b', { count: 3, label: 'x' }),
      store.setIfAbsent('b', { count: 4, label: 'y' }),
    ]);
    expect(y).toEqual(x);
  });

  it('replaces a corrupt record when writing only if absent, and refuses an invalid value', async () => {
    const { backend, notices, store } = setup();
    backend.poke('identity', 'a', { version: 3, writtenAt: 1, value: { count: 'many' } });
    expect(await store.setIfAbsent('a', { count: 5, label: 'fresh' })).toEqual(ok({ count: 5, label: 'fresh' }));
    expect(notices[0]?.code).toBe('RecordDiscarded');
    expect(raw(backend, 'a')).toMatchObject({ value: { count: 5, label: 'fresh' } });
    const refused = await store.setIfAbsent('c', { count: 1.5, label: 'x' });
    expect(refused.ok || refused.error.code).toBe('InvalidValue');
    expect(raw(backend, 'c')).toBeUndefined();
  });

  it('lists keys by prefix, in order', async () => {
    const { store } = setup();
    for (const key of ['p/2', 'q/1', 'p/1']) await store.set(key, { count: 1, label: key });
    expect(await store.keys('p/')).toEqual(ok(['p/1', 'p/2']));
    expect(await store.keys()).toEqual(ok(['p/1', 'p/2', 'q/1']));
  });

  it('runs async Standard Schema validators', async () => {
    const asyncKind = defineRecordKind<number>({
      store: 'identity',
      version: 1,
      label: 'number',
      schema: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: async (value) =>
            typeof value === 'number' ? { value } : { issues: [{ message: 'not a number' }] },
        },
      },
    });
    const backend = createMemoryBackend();
    const store = openStorage({ backend }).records(asyncKind);
    expect(await store.set('n', 3)).toEqual(ok(undefined));
    expect(await store.get('n')).toEqual(ok(3));
  });
});

describe('quota handling', () => {
  it('clears the archive and retries once when storage is full', async () => {
    const backend = createMemoryBackend({ quota: 350 });
    const notices: StorageNotice[] = [];
    const store = openStorage({ backend, onNotice: (n) => notices.push(n), now: () => 1 }).records(COUNTER);
    await backend.put('archive', 'junk', 'x'.repeat(300));
    expect(await store.set('a', { count: 1, label: 'fits once the archive is gone' })).toEqual(ok(undefined));
    expect(backend.peek('archive', 'junk')).toBeUndefined();
    expect(notices).toEqual([]);
  });

  it('reports QuotaExceeded with a notice when even that is not enough', async () => {
    const backend = createMemoryBackend({ quota: 60 });
    const notices: StorageNotice[] = [];
    const store = openStorage({ backend, onNotice: (n) => notices.push(n), now: () => 1 }).records(COUNTER);
    const result = await store.set('a', { count: 1, label: 'far too long for a sixty-unit quota' });
    expect(result.ok || result.error.code).toBe('QuotaExceeded');
    expect(notices).toMatchObject([{ code: 'QuotaExceeded', store: 'identity', key: 'a' }]);
  });
});
