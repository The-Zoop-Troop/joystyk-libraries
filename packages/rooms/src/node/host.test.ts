// The adapter's dispatch loop against a real SQLite file: restart and resume, a failing
// store, two writers and jobs that survive a restart.
import type { JobOutcome } from '@joystyk/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { nim, peek, pinOf, policy, seeds, testRng, type NimState, type PeekState } from '../__tests__/fixtures.ts';
import { FakeClock, FakeConnection, tempDir } from '../__tests__/node-helpers.ts';
import type { RoomCommand, RoomRecord } from '../types.ts';
import { RoomHost } from './host.ts';
import { inlineJobPool, type JobPool, type PoolOutcome } from './jobs.ts';
import { createEngineRegistry } from './registry.ts';
import { openSqliteStore, type RoomStore } from './store.ts';
import { hashToken, memoryLogger } from './support.ts';

const registry = createEngineRegistry(
  [
    { pin: pinOf('nim'), engine: nim, policy: policy({ decisionMs: 20_000, absent: 'wait' }) },
    { pin: pinOf('peek'), engine: peek, policy: policy({ absent: 'wait' }) },
  ],
  testRng,
);

const temps: { remove: () => void }[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) t.remove();
});

/** A store whose writes can be made to fail. */
const flaky = (store: RoomStore): RoomStore & { failing: boolean } => {
  const wrapper = Object.create(store) as RoomStore & { failing: boolean };
  wrapper.failing = false;
  wrapper.save = (record, inputs, expected) => {
    if (wrapper.failing) throw new Error('disk full');
    return store.save(record, inputs, expected);
  };
  return wrapper;
};

const setup = async (game: 'nim' | 'peek', pool: JobPool = inlineJobPool(() => ({ ok: false, reason: 'failed' }))) => {
  const t = tempDir();
  temps.push(t);
  const file = t.file('rooms.sqlite');
  const clock = new FakeClock();
  const log = memoryLogger();
  const store = flaky(await openSqliteStore(file));
  const current = registry.current(game)!;
  const created = current.core.create(
    {
      code: 'ROOMAA',
      policy: current.policy,
      config: game === 'nim' ? { heap: 12 } : { hand: 2 },
      seeds: seeds(9),
      creator: { name: 'Ana', tokenHash: hashToken('ana-token') },
    },
    clock.now(),
  );
  if (!created.ok) throw new Error(created.error.message);
  store.insert(created.value);
  const makeHost = (s: RoomStore, p: JobPool = pool) =>
    new RoomHost({
      store: s,
      registry,
      clock,
      pool: p,
      log,
      maxRooms: 10,
      outgoingBufferBytes: 1 << 20,
      persistRetryMs: 5_000,
      aiTimeoutMs: 1_000,
      draining: () => false,
    });
  return { file, clock, log, store, host: makeHost(store), makeHost };
};

let ids = 0;
const join = (host: RoomHost, conn: FakeConnection, name: string, token: string | null, fresh = `${name}-fresh`) => {
  const loaded = host.load('ROOMAA');
  if ('problem' in loaded) throw new Error(loaded.problem);
  loaded.live.conns.set(conn.id, conn);
  conn.pendingToken = fresh;
  host.dispatch('ROOMAA', {
    type: 'join',
    conn: conn.id,
    name,
    protocol: 1,
    presentedTokenHash: token === null ? null : hashToken(token),
    freshTokenHash: hashToken(fresh),
    watch: false,
  });
  conn.pendingToken = null;
};
const control = (
  host: RoomHost,
  conn: FakeConnection,
  control: Extract<RoomCommand, { type: 'control' }>['control'],
) => {
  ids += 1;
  host.dispatch('ROOMAA', {
    type: 'control',
    conn: conn.id,
    id: `control-${ids}`,
    expectedRevision: host.rooms.get('ROOMAA')!.room.record.revision,
    control,
    seeds: seeds(ids),
  });
};
const record = (host: RoomHost): RoomRecord => host.rooms.get('ROOMAA')!.room.record;

const startTwo = (host: RoomHost) => {
  const ana = new FakeConnection('ana');
  const ben = new FakeConnection('ben');
  join(host, ana, 'Ana', 'ana-token');
  join(host, ben, 'Ben', null, 'ben-token');
  control(host, ana, { kind: 'ready', ready: true });
  control(host, ben, { kind: 'ready', ready: true });
  control(host, ana, { kind: 'start' });
  return { ana, ben };
};

describe('the room host', () => {
  it('reveals a newly issued token in the welcome, and only then', async () => {
    const { host } = await setup('nim');
    const { ana, ben } = startTwo(host);
    expect(ana.of('welcome')[0]?.token).toBeUndefined();
    expect(ben.of('welcome')[0]?.token).toBe('ben-token');
    expect(JSON.stringify(ben.received)).not.toContain(hashToken('ben-token'));
  });

  it('resumes after a restart: seats come back by token, the clock gets a grace, a retry finds its receipt', async () => {
    const { host, clock, file, makeHost, store } = await setup('nim');
    const { ana, ben } = startTwo(host);
    const state = record(host).match!.state as NimState;
    const mover = state.turn === 0 ? ana : ben;
    const rev = record(host).revision;
    host.dispatch('ROOMAA', {
      type: 'act',
      conn: mover.id,
      id: 'before-restart',
      expectedRevision: rev,
      command: { take: 2 },
    });
    const after = record(host);
    store.close();

    clock.advance(60_000);
    const reopened = await openSqliteStore(file);
    const second = makeHost(reopened);
    const ana2 = new FakeConnection('ana2');
    const ben2 = new FakeConnection('ben2');
    join(second, ana2, 'Ana', 'ana-token');
    join(second, ben2, 'Ben', 'ben-token');
    expect(ana2.of('welcome')[0]?.seat).toBe(0);
    expect(ben2.of('welcome')[0]?.seat).toBe(1);
    expect(record(second).revision).toBe(after.revision);
    expect(record(second).match!.clocks[0]!.at).toBeGreaterThanOrEqual(clock.now() + 15_000);
    const retry = mover === ana ? ana2 : ben2;
    second.dispatch('ROOMAA', {
      type: 'act',
      conn: retry.id,
      id: 'before-restart',
      expectedRevision: rev,
      command: { take: 2 },
    });
    expect(retry.of('receipt').at(-1)?.result).toEqual({ status: 'accepted', revision: after.revision });
    reopened.close();
  });

  it('keeps the old state and broadcasts nothing when a write fails, then recovers', async () => {
    const { host, store, clock, log } = await setup('nim');
    const { ana, ben } = startTwo(host);
    const before = record(host);
    const state = before.match!.state as NimState;
    const [mover, other] = state.turn === 0 ? [ana, ben] : [ben, ana];
    const seen = other.received.length;
    store.failing = true;
    host.dispatch('ROOMAA', {
      type: 'act',
      conn: mover.id,
      id: 'during-outage',
      expectedRevision: before.revision,
      command: { take: 1 },
    });
    expect(record(host)).toBe(before);
    expect(other.received.length).toBe(seen);
    expect(mover.of('receipt').at(-1)?.result).toMatchObject({ status: 'rejected', code: 'storage-unavailable' });
    expect(log.lines.map((l) => l.event)).toContain('persist_failed');
    store.failing = false;
    clock.advance(5_000);
    host.dispatch('ROOMAA', {
      type: 'act',
      conn: mover.id,
      id: 'during-outage',
      expectedRevision: before.revision,
      command: { take: 1 },
    });
    expect(mover.of('receipt').at(-1)?.result).toEqual({ status: 'accepted', revision: before.revision + 1 });
    expect(other.of('update').at(-1)?.revision).toBe(before.revision + 1);
    store.close();
  });

  it('unloads its copy when another writer saved first', async () => {
    const { host, file, makeHost, store, log } = await setup('nim');
    const { ana } = startTwo(host);
    const other = await openSqliteStore(file);
    const second = makeHost(other);
    const intruder = new FakeConnection('intruder');
    join(second, intruder, 'Ana', 'ana-token');
    control(second, intruder, { kind: 'resign' });
    control(host, ana, { kind: 'resign' });
    expect(host.rooms.has('ROOMAA')).toBe(false);
    expect(log.lines.map((l) => l.event)).toContain('write_conflict');
    expect(ana.closed?.code).toBe(1013);
    other.close();
    store.close();
  });

  it('starts a job after saving its request and re-runs it after a restart', async () => {
    const outcomes: string[] = [];
    let hold = true;
    const pool = inlineJobPool(async (job): Promise<JobOutcome> => {
      expect(job.rulesVersion).toBe(1);
      outcomes.push(job.jobId);
      if (hold) return new Promise(() => {});
      return { ok: true, value: { card: 33 } };
    });
    const { host, file, makeHost, store } = await setup('peek', pool);
    const { ana } = startTwo(host);
    expect((record(host).match!.state as PeekState).turn).toBe(0);
    host.dispatch('ROOMAA', {
      type: 'act',
      conn: ana.id,
      id: 'draw-a-card',
      expectedRevision: record(host).revision,
      command: { draw: true },
    });
    await expect.poll(() => outcomes).toEqual(['draw-0']);
    store.close();

    hold = false;
    const reopened = await openSqliteStore(file);
    expect(reopened.withPendingJobs()).toEqual(['ROOMAA']);
    const second = makeHost(reopened, pool);
    const loaded = second.load('ROOMAA');
    expect('live' in loaded).toBe(true);
    await expect.poll(() => outcomes).toEqual(['draw-0', 'draw-0']);
    await expect.poll(() => (record(second).match!.state as PeekState).hands[0]).toContain(33);
    reopened.close();
  });

  it.each([1, 2])('loads a rules-%i room and routes its heavy AI by that pin', async (version) => {
    const t = tempDir();
    temps.push(t);
    const roomPolicy = policy({ start: 'immediate' });
    const heavyRegistry = createEngineRegistry(
      [1, 2].map((rulesVersion) => ({
        pin: pinOf('nim', rulesVersion),
        engine: { ...nim, rulesVersion },
        policy: roomPolicy,
        heavyAi: true,
      })),
      testRng,
    );
    const asked: string[] = [];
    const pool = inlineJobPool((job): JobOutcome => {
      expect(job.rulesVersion).toBe(version);
      asked.push(job.kind);
      const view = (job.payload as { view: NimState }).view;
      return { ok: true, value: { take: Math.min(3, view.heap) } };
    });
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    const clock = new FakeClock();
    const core = heavyRegistry.core('nim', version)!;
    const created = core.create(
      {
        code: 'ROOMAA',
        policy: roomPolicy,
        config: { heap: 12 },
        seeds: seeds(9),
        creator: { name: 'Ana', tokenHash: hashToken('ana-token') },
      },
      clock.now(),
    );
    if (!created.ok) throw new Error(created.error.message);
    store.insert(created.value);
    const host = new RoomHost({
      store,
      registry: heavyRegistry,
      clock,
      pool,
      log: memoryLogger(),
      maxRooms: 10,
      outgoingBufferBytes: 1 << 20,
      persistRetryMs: 5_000,
      aiTimeoutMs: 1_000,
      draining: () => false,
    });
    const ana = new FakeConnection('ana');
    join(host, ana, 'Ana', 'ana-token');
    if ((record(host).match!.state as NimState).turn === 0) {
      host.dispatch('ROOMAA', {
        type: 'act',
        conn: ana.id,
        id: 'first-move-x',
        expectedRevision: record(host).revision,
        command: { take: 1 },
      });
    }
    await expect.poll(() => asked).toEqual(['ai']);
    expect(record(host).match?.game.rulesVersion).toBe(version);
    await expect.poll(() => (record(host).match!.state as NimState).turn).toBe(0);
    store.close();
  });

  it('asks a heavy AI again after a busy pool or a lost job, and the seat never plays the timeout move', async () => {
    const t = tempDir();
    temps.push(t);
    const roomPolicy = policy({ start: 'immediate' });
    const heavyRegistry = createEngineRegistry(
      [{ pin: pinOf('nim'), engine: nim, policy: roomPolicy, heavyAi: true }],
      testRng,
    );
    const answers: PoolOutcome[] = [
      { ok: false, reason: 'busy' },
      { ok: false, reason: 'lost' },
      { ok: true, value: { take: 3 } },
    ];
    let asked = 0;
    const pool = inlineJobPool((): PoolOutcome => answers[asked++] ?? { ok: false, reason: 'failed' });
    const store = await openSqliteStore(t.file('rooms.sqlite'));
    const clock = new FakeClock();
    const created = heavyRegistry.current('nim')!.core.create(
      {
        code: 'ROOMAA',
        policy: roomPolicy,
        config: { heap: 12 },
        seeds: seeds(9),
        creator: { name: 'Ana', tokenHash: hashToken('ana-token') },
      },
      clock.now(),
    );
    if (!created.ok) throw new Error(created.error.message);
    store.insert(created.value);
    const host = new RoomHost({
      store,
      registry: heavyRegistry,
      clock,
      pool,
      log: memoryLogger(),
      maxRooms: 10,
      outgoingBufferBytes: 1 << 20,
      persistRetryMs: 5_000,
      aiTimeoutMs: 1_000,
      draining: () => false,
    });
    join(host, new FakeConnection('ana'), 'Ana', 'ana-token');
    if ((record(host).match!.state as NimState).turn === 0) {
      host.dispatch('ROOMAA', {
        type: 'act',
        conn: 'ana',
        id: 'first-move-x',
        expectedRevision: record(host).revision,
        command: { take: 1 },
      });
    }
    const heap = (record(host).match!.state as NimState).heap;
    await expect.poll(() => asked).toBe(1);
    clock.advance(1_000);
    await expect.poll(() => asked).toBe(2);
    expect((record(host).match!.state as NimState).heap).toBe(heap);
    clock.advance(2_000);
    await expect.poll(() => (record(host).match!.state as NimState).heap).toBe(heap - 3);
    expect(asked).toBe(3);
    store.close();
  });

  it('closes a room whose engine this build no longer carries', async () => {
    const { log, file, store } = await setup('nim');
    store.close();
    const lonely = createEngineRegistry([{ pin: pinOf('peek'), engine: peek, policy: policy() }], testRng);
    const reopened = await openSqliteStore(file);
    const bare = new RoomHost({
      store: reopened,
      registry: lonely,
      clock: new FakeClock(),
      pool: inlineJobPool(() => ({ ok: false, reason: 'failed' })),
      log,
      maxRooms: 10,
      outgoingBufferBytes: 1 << 20,
      persistRetryMs: 5_000,
      aiTimeoutMs: 1_000,
      draining: () => false,
    });
    expect(bare.load('ROOMAA')).toEqual({ problem: 'engine-missing' });
    expect(log.lines.map((l) => l.event)).toContain('engine_missing');
    reopened.close();
  });
});

it('retries a heavy AI answer after persistence fails without asking or applying it twice', async () => {
  const t = tempDir();
  temps.push(t);
  const roomPolicy = policy({ start: 'immediate' });
  const heavyRegistry = createEngineRegistry(
    [{ pin: pinOf('nim'), engine: nim, policy: roomPolicy, heavyAi: true }],
    testRng,
  );
  const store = flaky(await openSqliteStore(t.file('rooms.sqlite')));
  const clock = new FakeClock();
  let answer: ((outcome: PoolOutcome) => void) | undefined;
  let asked = 0;
  const pool = inlineJobPool(() => {
    asked++;
    return new Promise<PoolOutcome>((resolve) => {
      answer = resolve;
    });
  });
  const created = heavyRegistry.current('nim')!.core.create(
    {
      code: 'ROOMAA',
      policy: roomPolicy,
      config: { heap: 12 },
      seeds: seeds(9),
      creator: { name: 'Ana', tokenHash: hashToken('ana-token') },
    },
    clock.now(),
  );
  if (!created.ok) throw Error(created.error.message);
  store.insert(created.value);
  const host = new RoomHost({
    store,
    registry: heavyRegistry,
    clock,
    pool,
    log: memoryLogger(),
    maxRooms: 10,
    outgoingBufferBytes: 1 << 20,
    persistRetryMs: 5_000,
    aiTimeoutMs: 30_000,
    draining: () => false,
  });
  join(host, new FakeConnection('ana'), 'Ana', 'ana-token');
  if ((record(host).match!.state as NimState).turn === 0)
    host.dispatch('ROOMAA', {
      type: 'act',
      conn: 'ana',
      id: 'first-move-x',
      expectedRevision: record(host).revision,
      command: { take: 1 },
    });
  await expect.poll(() => asked).toBe(1);
  const heap = (record(host).match!.state as NimState).heap;
  store.failing = true;
  answer!({ ok: true, value: { take: 3 } });
  await expect.poll(() => host.rooms.get('ROOMAA')!.timer).not.toBeNull();
  await Promise.resolve();
  await Promise.resolve();
  store.failing = false;
  clock.advance(5_000);
  expect((record(host).match!.state as NimState).heap).toBe(heap - 3);
  expect(asked).toBe(1);
  host.unload('ROOMAA', 'drain');
  store.close();
});

it('retries resume persistence so pending jobs and disconnect grace are restarted', async () => {
  const pool = inlineJobPool(() => new Promise<PoolOutcome>(() => {}));
  const { host, makeHost, store, clock } = await setup('peek', pool);
  const { ana } = startTwo(host);
  host.dispatch('ROOMAA', {
    type: 'act',
    conn: ana.id,
    id: 'pending-draw',
    expectedRevision: record(host).revision,
    command: { draw: true },
  });
  await Promise.resolve();
  host.unload('ROOMAA', 'drain');
  let starts = 0;
  const second = makeHost(
    store,
    inlineJobPool(() => {
      starts++;
      return new Promise<PoolOutcome>(() => {});
    }),
  );
  store.failing = true;
  second.load('ROOMAA');
  expect(starts).toBe(0);
  store.failing = false;
  clock.advance(5_000);
  await expect.poll(() => starts).toBe(1);
  const live = second.rooms.get('ROOMAA')!.room;
  expect(live.jobStartedAt.size).toBe(1);
  second.unload('ROOMAA', 'drain');
  store.close();
});
