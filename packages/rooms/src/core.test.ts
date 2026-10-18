import { defineEngine, err, gameError, isJson, ok, type Json } from '@joystyk/contracts';
import { checkDisplayName } from '@joystyk/identity/names';
import { describe, expect, it } from 'vitest';
import {
  Harness,
  coreFor,
  effectsOf,
  hashOf,
  nim,
  pass,
  peek,
  policy,
  seeds,
  type NimState,
  type PassState,
  type PeekState,
} from './__tests__/fixtures.ts';
import { decodeRecord } from './record.ts';
import { ServerMessageSchema } from './protocol/index.ts';

/** A two-player Nim room in which both players joined, readied and started. */
const startedNim = (overrides: Parameters<typeof policy>[0] = {}) => {
  const h = Harness.create(coreFor(nim, 'nim'), policy(overrides), { heap: 10 });
  h.join('c-ana', 'Ana', hashOf('ana'));
  h.join('c-ben', 'Ben');
  h.control('c-ana', { kind: 'ready', ready: true });
  h.control('c-ben', { kind: 'ready', ready: true });
  h.control('c-ana', { kind: 'start' });
  return h;
};

const turnConn = (h: Harness): string => ((h.state as NimState).turn === 0 ? 'c-ana' : 'c-ben');
const otherConn = (h: Harness): string => ((h.state as NimState).turn === 0 ? 'c-ben' : 'c-ana');

describe('joining and seats', () => {
  it('seats the creator by token as host, issues a fresh token to the next player, and lets spectators watch', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy(), { heap: 10 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    expect(h.welcomes.get('c-ana')).toEqual({ seat: 0, issued: false });
    expect(h.record.host).toBe(0);
    h.join('c-ben', 'Ana');
    expect(h.welcomes.get('c-ben')).toEqual({ seat: 1, issued: true });
    expect(h.record.seats[1]?.claim?.name).toBe('Ana 2');
    h.join('c-spec', 'Cy');
    expect(h.welcomes.get('c-spec')).toEqual({ seat: null, issued: false });
    h.join('c-spec2', 'Di');
    h.join('c-spec3', 'Ed');
    expect(h.dropped.get('c-spec3')).toBe('room-full');
    expect(h.messages('c-spec3', 'notice')[0]?.code).toBe('room-full');
  });

  it('keeps a name the identity filter accepts, normalized, and says nothing', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy(), { heap: 10 });
    h.join('c-ben', '  Ada   Byte ');
    expect(h.record.seats[1]?.claim?.name).toBe('Ada Byte');
    expect(h.messages('c-ben', 'notice')).toEqual([]);
  });

  it('replaces a refused name with a generated one and tells the player why', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy(), { heap: 10 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.join('c-ben', 'Big Shit Fan');
    const name = h.record.seats[1]?.claim?.name ?? '';
    expect(checkDisplayName(name)).toEqual(ok(name));
    const notices = h.messages('c-ben', 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.code).toBe('name-replaced');
    expect(notices[0]?.message).toBe(
      `That name isn't allowed. Try another, or roll a random one. You're playing as ${name}.`,
    );
    expect(notices[0]?.message.toLowerCase()).not.toContain('shit');
    expect(ServerMessageSchema.safeParse(notices[0]).success).toBe(true);
    // Welcome first, then the notice, then the snapshot that shows the new name.
    expect(h.inbox.get('c-ben')?.map((m) => m.t)).toEqual(['welcome', 'notice', 'snapshot']);
    expect(h.messages('c-ben', 'snapshot')[0]?.seats[1]?.name).toBe(name);
    expect(h.messages('c-ana', 'update').at(-1)?.seats?.[1]?.name).toBe(name);
    expect(JSON.stringify([...h.inbox.values()]).toLowerCase()).not.toContain('shit');
  });

  it('generates the same replacement for the same room and step, and another for another seat', () => {
    const replaced = (bad: string, before: readonly string[] = []): string => {
      const h = Harness.create(coreFor(nim, 'nim'), policy({ seats: { min: 2, max: 3 } }), { heap: 10 });
      before.forEach((name, i) => h.join(`c-${i}`, name));
      h.join('c-bad', bad);
      return h.record.seats[before.length + 1]?.claim?.name ?? '';
    };
    expect(replaced('x')).toBe(replaced('x'));
    expect(replaced('x')).toBe(replaced('Fox 69'));
    expect(replaced('x', ['Ben'])).not.toBe(replaced('x'));
  });

  it('filters the creator name too', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy(), { heap: 10 }, 'Fox 69');
    const name = h.record.seats[0]?.claim?.name ?? '';
    expect(name).not.toBe('Fox 69');
    expect(checkDisplayName(name)).toEqual(ok(name));
    h.join('c-fox', 'Anything', hashOf('Fox 69'));
    expect(h.record.seats[0]?.claim?.name).toBe(name);
  });

  it('lets the newest tab take the seat and tells the older one it was replaced', () => {
    const h = startedNim();
    h.join('c-ana-2', 'Ana', hashOf('ana'));
    expect(h.messages('c-ana', 'replaced')).toHaveLength(1);
    expect(h.dropped.get('c-ana')).toBe('replaced');
    expect([...h.room.members.keys()]).toEqual(['c-ben', 'c-ana-2']);
    expect(h.messages('c-ana-2', 'snapshot')).toHaveLength(1);
  });

  it('never leaks the token hash in a message', () => {
    const h = startedNim();
    const all = JSON.stringify([...h.inbox.values()]);
    expect(all).not.toContain(hashOf('ana'));
    expect(all).not.toContain(hashOf('Ben'));
  });

  it('refuses everything once the room is closed', () => {
    const h = startedNim();
    h.step({ type: 'close', reason: 'expired' });
    expect(h.record.phase).toBe('closed');
    expect(h.dropped.get('c-ana')).toBe('room-closed');
    const step = h.join('c-late', 'Zed');
    expect(effectsOf(step, 'drop')[0]?.reason).toBe('room-closed');
  });
});

describe('actions, receipts and revisions', () => {
  it('applies a move, persists first, and sends every member an update', () => {
    const h = startedNim();
    const before = h.record.revision;
    const [mover, waiter] = [turnConn(h), otherConn(h)];
    const step = h.act(mover, { take: 2 });
    expect(step.effects[0]?.type).toBe('persist');
    expect(effectsOf(step, 'persist')).toHaveLength(1);
    expect(h.record.revision).toBe(before + 1);
    expect(h.lastReceipt(mover)).toEqual({ status: 'accepted', revision: before + 1 });
    expect(
      effectsOf(step, 'send')
        .filter((e) => e.message.t === 'receipt')
        .flatMap((e) => e.to),
    ).toEqual([mover]);
    expect(h.messages(waiter, 'update').at(-1)?.revision).toBe(before + 1);
    const updates = effectsOf(step, 'send').filter((e) => e.message.t === 'update');
    expect(updates.flatMap((u) => u.to).sort()).toEqual(['c-ana', 'c-ben']);
  });

  it('answers a retried action with its original receipt and no new revision', () => {
    const h = startedNim();
    const conn = turnConn(h);
    const rev = h.record.revision;
    h.act(conn, { take: 1 }, rev, 'retry-me-01');
    const accepted = h.lastReceipt(conn);
    const after = h.record;
    const step = h.act(conn, { take: 1 }, rev, 'retry-me-01');
    expect(effectsOf(step, 'persist')).toHaveLength(0);
    expect(h.record).toBe(after);
    expect(h.lastReceipt(conn)).toEqual(accepted);
  });

  it('refuses a reused action ID with a different payload', () => {
    const h = startedNim();
    const conn = turnConn(h);
    const rev = h.record.revision;
    h.act(conn, { take: 1 }, rev, 'reused-id-01');
    h.act(conn, { take: 2 }, rev, 'reused-id-01');
    expect(h.lastReceipt(conn)).toMatchObject({ status: 'rejected', code: 'action-id-reused' });
  });

  it('keeps receipts across a restart', () => {
    const h = startedNim();
    const conn = turnConn(h);
    const rev = h.record.revision;
    h.act(conn, { take: 1 }, rev, 'survives-01');
    const revision = h.record.revision;
    const r = h.restart();
    r.join(conn, 'Ana', conn === 'c-ana' ? hashOf('ana') : hashOf('Ben'));
    const step = r.act(conn, { take: 1 }, rev, 'survives-01');
    expect(effectsOf(step, 'persist')).toHaveLength(0);
    expect(r.lastReceipt(conn)).toEqual({ status: 'accepted', revision });
  });

  it('rejects a stale action with a snapshot, and an action from the future', () => {
    const h = startedNim();
    const stale = h.record.revision;
    h.act(turnConn(h), { take: 1 });
    const conn = turnConn(h);
    h.act(conn, { take: 1 }, stale);
    expect(h.lastReceipt(conn)).toMatchObject({ status: 'rejected', code: 'stale' });
    expect(h.messages(conn, 'snapshot').length).toBeGreaterThan(1);
    h.act(conn, { take: 1 }, h.record.revision + 5);
    expect(h.lastReceipt(conn)).toMatchObject({ status: 'rejected', code: 'bad-revision' });
  });

  it('rejects out-of-turn moves with the engine code, and spectators', () => {
    const h = startedNim();
    h.act(otherConn(h), { take: 1 });
    expect(h.lastReceipt(otherConn(h))).toMatchObject({ status: 'rejected', code: 'game:NotYourTurn' });
    h.join('c-spec', 'Cy');
    h.act('c-spec', { take: 1 });
    expect(h.lastReceipt('c-spec')).toMatchObject({ status: 'rejected', code: 'spectator' });
  });

  it('leaves the record untouched when it rejects', () => {
    const h = startedNim();
    const record = h.record;
    const step = h.act(otherConn(h), { take: 1 });
    expect(h.record).toBe(record);
    expect(effectsOf(step, 'persist')).toHaveLength(0);
    expect(effectsOf(step, 'log').map((l) => l.event)).toContain('action_rejected');
  });

  it('accepts four simultaneous passes sent at the same revision', () => {
    const h = Harness.create(coreFor(pass, 'pass'), policy({ seats: { min: 4, max: 4 } }), { rounds: 3 });
    h.join('c0', 'A', hashOf('ana'));
    for (const c of ['c1', 'c2', 'c3']) h.join(c, c);
    for (const c of ['c0', 'c1', 'c2', 'c3']) h.control(c, { kind: 'ready', ready: true });
    h.control('c0', { kind: 'start' });
    const rev = h.record.revision;
    for (const c of ['c0', 'c1', 'c2', 'c3']) h.act(c, { pick: 3 }, rev);
    for (const c of ['c0', 'c1', 'c2', 'c3']) expect(h.lastReceipt(c)?.status).toBe('accepted');
    expect((h.state as PassState).round).toBe(2);
  });

  it('accepts an action after a change the seat cannot see', () => {
    const h = Harness.create(coreFor(pass, 'pass'), policy({ seats: { min: 3, max: 3 } }), { rounds: 3 });
    h.join('c0', 'A', hashOf('ana'));
    h.join('c1', 'B');
    h.join('c2', 'C');
    for (const c of ['c0', 'c1', 'c2']) h.control(c, { kind: 'ready', ready: true });
    h.control('c0', { kind: 'start' });
    const rev = h.record.revision;
    h.act('c1', { pick: 1 }, rev);
    h.act('c2', { pick: 2 }, rev);
    expect(h.lastReceipt('c2')?.status).toBe('accepted');
  });

  it('offers resignation off-turn as a room control', () => {
    const h = startedNim();
    h.control(otherConn(h), { kind: 'resign' });
    expect(h.record.phase).toBe('finished');
    expect(h.record.match?.outcome?.result).toBe('won');
  });
});

describe('room controls', () => {
  it('lets only the host start, and only when everyone is ready', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy(), { heap: 5 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.join('c-ben', 'Ben');
    h.control('c-ben', { kind: 'start' });
    expect(h.lastReceipt('c-ben')).toMatchObject({ code: 'not-host' });
    h.control('c-ana', { kind: 'start' });
    expect(h.lastReceipt('c-ana')).toMatchObject({ code: 'not-allowed' });
    h.control('c-ana', { kind: 'ready', ready: true });
    h.control('c-ben', { kind: 'ready', ready: true });
    h.control('c-ana', { kind: 'start' });
    expect(h.record.phase).toBe('playing');
    h.control('c-ana', { kind: 'ready', ready: false });
    expect(h.lastReceipt('c-ana')).toMatchObject({ code: 'wrong-phase' });
  });

  it('fills a lobby seat with the AI, which then plays inside the step', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy(), { heap: 9 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.control('c-ana', { kind: 'fill-with-ai', seat: 1 });
    h.control('c-ana', { kind: 'ready', ready: true });
    h.control('c-ana', { kind: 'start' });
    expect((h.state as NimState).turn).toBe(0);
    h.act('c-ana', { take: 1 });
    // The AI took one at once.
    expect((h.state as NimState).heap).toBe(7);
    const inputs = h.persisted.flatMap((p) => p.inputs);
    expect(inputs.filter((i) => i.input.kind === 'command' && i.input.seat === 1)).toHaveLength(1);
  });

  it('starts a rematch on the newest build, which every member sees in a snapshot', () => {
    const h = startedNim();
    h.control(otherConn(h), { kind: 'resign' });
    const newer = coreFor(nim, 'nim', '1.1.0');
    h.core = newer;
    h.control('c-ana', { kind: 'offer', offer: 'rematch' });
    h.control('c-ben', { kind: 'accept', offer: h.record.offer!.id });
    expect(h.record.match?.number).toBe(2);
    expect(h.record.match?.game.build).toBe('1.1.0');
    expect(h.messages('c-ben', 'snapshot').at(-1)?.game.build).toBe('1.1.0');
  });

  it('compacts the seats when a match starts with a gap', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy({ seats: { min: 2, max: 3 } }), { heap: 5 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.join('c-ben', 'Ben');
    h.join('c-cy', 'Cyd');
    h.control('c-ben', { kind: 'leave-seat' });
    h.control('c-ana', { kind: 'ready', ready: true });
    const readyRev = h.record.revision;
    h.control('c-cy', { kind: 'ready', ready: true }, readyRev, 'cy-ready-01');
    const readyReceipt = h.lastReceipt('c-cy');
    h.control('c-ana', { kind: 'start' });
    expect(h.record.seats.map((s) => s.claim?.name)).toEqual(['ana', 'Cyd']);
    expect(h.room.members.get('c-cy')?.seat).toBe(1);
    expect(h.messages('c-cy', 'snapshot').at(-1)?.seat).toBe(1);
    // The receipt moved with the seat: a retry after the start still finds it.
    h.control('c-cy', { kind: 'ready', ready: true }, readyRev, 'cy-ready-01');
    expect(h.lastReceipt('c-cy')).toEqual(readyReceipt);
  });
});

describe('absence, AI handover and the host', () => {
  it('hands an absent seat to the AI after the grace period and back on rejoin', () => {
    const h = startedNim({ absent: 'ai', graceMs: 30_000 });
    h.step({ type: 'leave', conn: 'c-ben' });
    const left = h.now;
    expect(effectsOf(h.last!, 'alarm')[0]?.at).toBe(left + 30_000);
    h.step({ type: 'timer-fired' }, left + 29_999);
    expect(h.record.seats[1]?.controller).toBe('human');
    h.step({ type: 'timer-fired' }, left + 30_000);
    expect(h.record.seats[1]?.controller).toBe('ai');
    expect(h.record.seats[1]?.claim?.name).toBe('Ben');
    h.join('c-ben-2', 'Ben', hashOf('Ben'));
    expect(h.record.seats[1]?.controller).toBe('human');
  });

  it('expires an absent player’s turns under the timeout policy', () => {
    const h = startedNim({ absent: 'timeout', graceMs: 10_000 });
    const away = otherConn(h);
    h.act(turnConn(h), { take: 1 });
    h.step({ type: 'leave', conn: away });
    const heap = (h.state as NimState).heap;
    h.step({ type: 'timer-fired' }, h.now + 10_000);
    expect((h.state as NimState).heap).toBe(heap - 1);
  });

  it('passes the host to a connected player after the grace period', () => {
    const h = startedNim({ graceMs: 5_000, absent: 'wait' });
    h.step({ type: 'leave', conn: 'c-ana' });
    h.step({ type: 'timer-fired' }, h.now + 5_000);
    expect(h.record.host).toBe(1);
  });

  it('freezes a room with no connected player: no AI moves, no clocks', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy({ start: 'immediate', decisionMs: 10_000 }), { heap: 9 });
    expect(h.record.phase).toBe('playing');
    h.step({ type: 'timer-fired' }, h.now + 1_000_000);
    expect(h.persisted.flatMap((p) => p.inputs)).toHaveLength(0);
    expect(h.record.match?.clocks).toEqual([]);
    h.join('c-ana', 'Ana', hashOf('ana'));
    // Unfrozen: the AI plays until it is the creator's turn, whose clock starts.
    expect((h.state as NimState).turn).toBe(0);
    expect(h.record.match?.clocks).toEqual([
      { seat: 0, at: h.now + 10_000, decisionRevision: h.record.match?.decisionRevision[0] },
    ]);
  });
});

describe('clocks as data', () => {
  const clocked = () => startedNim({ decisionMs: 10_000, absent: 'wait' });

  it('times out a decision at its deadline', () => {
    const h = clocked();
    const clock = h.record.match?.clocks[0];
    expect(clock).toBeDefined();
    const heap = (h.state as NimState).heap;
    h.step({ type: 'timer-fired' }, clock!.at);
    expect((h.state as NimState).heap).toBe(heap - 1);
  });

  it('applies the timeout before a move that arrives at the same millisecond', () => {
    const h = clocked();
    const clock = h.record.match!.clocks[0]!;
    const conn = turnConn(h);
    const rev = h.record.revision;
    h.step({ type: 'act', conn, id: 'late-move-01', expectedRevision: rev, command: { take: 3 } }, clock.at);
    expect(h.lastReceipt(conn)).toMatchObject({ status: 'rejected' });
    expect(h.persisted.at(-1)?.inputs.map((i) => i.input.kind)).toEqual(['timeout']);
  });

  it('judges a move that arrives after the deadline, before the alarm, against the timed-out state', () => {
    const h = clocked();
    const clock = h.record.match!.clocks[0]!;
    const conn = turnConn(h);
    h.step(
      { type: 'act', conn, id: 'after-deadline', expectedRevision: h.record.revision, command: { take: 3 } },
      clock.at + 250,
    );
    expect(h.lastReceipt(conn)).toMatchObject({ status: 'rejected' });
  });

  it('ignores a timer that fires early, and fires once however often it is woken', () => {
    const h = clocked();
    const clock = h.record.match!.clocks[0]!;
    const before = h.record;
    const early = h.step({ type: 'timer-fired' }, clock.at - 1);
    expect(effectsOf(early, 'persist')).toHaveLength(0);
    expect(h.record).toBe(before);
    h.step({ type: 'timer-fired' }, clock.at);
    const after = h.record;
    const twice = h.step({ type: 'timer-fired' }, clock.at);
    expect(effectsOf(twice, 'persist')).toHaveLength(0);
    expect(h.record).toBe(after);
  });

  it('keeps a clock running while the seat’s decision is unchanged, and extends it on resume', () => {
    const h = clocked();
    const clock = h.record.match!.clocks[0]!;
    h.join('c-spec', 'Cy');
    expect(h.record.match!.clocks[0]).toEqual(clock);
    const r = h.restart(h.core, clock.at - 1_000);
    expect(r.record.match!.clocks[0]!.at).toBe(clock.at - 1_000 + 15_000);
  });
});

describe('jobs', () => {
  const startedPeek = () => {
    const h = Harness.create(coreFor(peek, 'peek'), policy({ absent: 'wait' }), { hand: 2 });
    h.join('c0', 'Ana', hashOf('ana'));
    h.join('c1', 'Ben');
    h.control('c0', { kind: 'ready', ready: true });
    h.control('c1', { kind: 'ready', ready: true });
    h.control('c0', { kind: 'start' });
    return h;
  };

  it('starts a job only after persisting its request, and applies the result', () => {
    const h = startedPeek();
    const step = h.act('c0', { draw: true });
    const types = step.effects.map((e) => e.type);
    expect(types.indexOf('persist')).toBe(0);
    expect(types).toContain('start-job');
    expect(h.record.match?.jobs).toHaveLength(1);
    h.step({
      type: 'job-completed',
      jobId: 'draw-0',
      outcome: { ok: true, value: { card: 77 }, presentation: { motion: [1, 2] } },
    });
    expect((h.state as PeekState).hands[0]).toContain(77);
    expect(h.record.match?.presentation).toEqual({ motion: [1, 2] });
    const logged = h.persisted.at(-1)?.inputs[0]?.input;
    expect(logged).toEqual({ kind: 'job', jobId: 'draw-0', outcome: { ok: true, value: { card: 77 } } });
    const opponent = h.messages('c1', 'update').at(-1);
    expect(JSON.stringify(opponent)).not.toContain('77');
  });

  it('drops a result for a superseded job and times out a job that never answers', () => {
    const h = startedPeek();
    h.act('c0', { draw: true });
    const timeout = effectsOf(h.last!, 'alarm')[0]?.at;
    expect(timeout).toBe(h.now + 5_000);
    h.step({ type: 'timer-fired' }, timeout!);
    expect(h.record.match?.jobs).toEqual([]);
    const step = h.step({ type: 'job-completed', jobId: 'draw-0', outcome: { ok: true, value: { card: 5 } } });
    expect(effectsOf(step, 'log').map((l) => l.event)).toContain('job_superseded');
    expect(effectsOf(step, 'persist')).toHaveLength(0);
  });

  it('re-runs a pending job after a restart', () => {
    const h = startedPeek();
    h.act('c0', { draw: true });
    const r = h.restart();
    expect(effectsOf(r.last!, 'start-job').map((e) => e.jobId)).toEqual(['draw-0']);
  });
});

describe('failures', () => {
  it('rejects with engine-error and keeps the state when the engine throws', () => {
    const throwing = defineEngine({
      ...nim,
      apply: (state: NimState, input) => {
        if (input.kind === 'command' && input.command.take === 2) throw new Error('boom');
        return nim.apply(state, input, {
          next: () => 0,
          int: () => 0,
          shuffle: (x) => [...x],
          save: () => ({ algorithm: 'x', words: [] }),
        });
      },
    });
    const h = Harness.create(coreFor(throwing, 'nim'), policy(), { heap: 9 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.join('c-ben', 'Ben');
    h.control('c-ana', { kind: 'ready', ready: true });
    h.control('c-ben', { kind: 'ready', ready: true });
    h.control('c-ana', { kind: 'start' });
    const record = h.record;
    h.act(turnConn(h), { take: 2 });
    expect(h.lastReceipt(turnConn(h))).toMatchObject({ code: 'engine-error' });
    expect(h.record).toBe(record);
  });

  it('replaces an illegal AI move with a timeout and bounds the AI loop', () => {
    const silly = defineEngine({
      ...nim,
      apply: (state: NimState, input) =>
        input.kind === 'timeout'
          ? ok({ state, beats: [] })
          : input.kind === 'command' && input.command.take === 99
            ? err(gameError('Bad', 'bad'))
            : nim.apply(state, input, {
                next: () => 0,
                int: () => 0,
                shuffle: (x) => [...x],
                save: () => ({ algorithm: 'x', words: [] }),
              }),
      ai: { levels: ['easy'], choose: () => ({ take: 99 }) },
    });
    const h = Harness.create(coreFor(silly, 'nim'), policy({ start: 'immediate' }), { heap: 9 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    if ((h.state as NimState).turn === 0) h.act('c-ana', { take: 1 });
    const events = effectsOf(h.last!, 'log').map((l) => l.event);
    expect(events).toContain('ai_illegal_move');
    expect(events).toContain('ai_loop');
    expect(h.persisted.flatMap((p) => p.inputs).length).toBeLessThanOrEqual(256);
  });
});

describe('records', () => {
  it('round-trips every persisted record through JSON and the record schema', () => {
    const h = startedNim({ decisionMs: 10_000 });
    h.act(turnConn(h), { take: 1 });
    for (const { record } of h.persisted) {
      expect(isJson(record as unknown as Json)).toBe(true);
      const decoded = decodeRecord(JSON.parse(JSON.stringify(record)));
      expect(decoded.ok && decoded.value.record).toEqual(record);
    }
  });

  it('refuses a newer record format', () => {
    const h = startedNim();
    const decoded = decodeRecord({ ...h.record, format: 2 });
    expect(!decoded.ok && decoded.error.code).toBe('newer-format');
  });

  it('creates an immediate room with AI in every other seat', () => {
    const core = coreFor(peek, 'peek');
    const created = core.create(
      {
        code: 'QWERTY',
        policy: policy({ start: 'immediate', seats: { min: 2, max: 3 } }),
        config: { hand: 2 },
        seeds: seeds(3),
        creator: { name: 'Ana', tokenHash: 'h' },
      },
      0,
    );
    expect(created.ok && created.value.seats.map((s) => s.controller)).toEqual(['human', 'ai', 'ai']);
    expect(created.ok && created.value.phase).toBe('playing');
  });
});
