// A paused table (section 3.5 rule 8, D-58): with no player connected, running clocks stop
// where they are and resume from there when a player returns, banks are charged only for live
// time, and a pause survives a restart. Time is the harness's fake clock.
import { describe, expect, it } from 'vitest';
import { Harness, coreFor, hashOf, nim, policy, type NimState } from './__tests__/fixtures.ts';
import type { RoomPolicy } from './types.ts';

const started = (overrides: Partial<RoomPolicy>) => {
  const h = Harness.create(coreFor(nim, 'nim'), policy({ absent: 'wait', ...overrides }), { heap: 20 });
  h.join('c-ana', 'Ana', hashOf('ana'));
  h.join('c-ben', 'Ben');
  h.control('c-ana', { kind: 'ready', ready: true });
  h.control('c-ben', { kind: 'ready', ready: true });
  h.control('c-ana', { kind: 'start' });
  return h;
};

/** The player to move: their seat, connection, name and token hash. */
const moverOf = (h: Harness) => {
  const seat = (h.state as NimState).turn;
  return seat === 0
    ? { seat, conn: 'c-ana', name: 'Ana', token: hashOf('ana') }
    : { seat, conn: 'c-ben', name: 'Ben', token: hashOf('Ben') };
};

const timeouts = (h: Harness) => h.persisted.flatMap((p) => p.inputs).filter((i) => i.input.kind === 'timeout');

describe('a paused table', () => {
  it('stops a running clock when the last player leaves, and runs it on from there when one returns', () => {
    const h = started({ decisionMs: 10_000 });
    const mover = moverOf(h);
    const t0 = h.now;
    const deadline = h.record.match!.clocks[0]!.at;
    expect(deadline).toBe(t0 + 10_000);
    h.step({ type: 'leave', conn: 'c-ana' }, t0 + 3_000);
    h.step({ type: 'leave', conn: 'c-ben' }, t0 + 3_000);
    expect(h.record.match!.pausedAt).toBe(t0 + 3_000);

    // Someone watching sees the clock as it stood, and that it is paused.
    h.now = t0 + 50_000;
    h.join('c-spec', 'Cy', null, true);
    const presence = h.messages('c-spec', 'snapshot').at(-1)!.presence;
    expect(presence.paused).toBe(true);
    expect(presence.clocks).toEqual([{ seat: mover.seat, remainingMs: 7_000, running: false, paused: true }]);

    // The old deadline passes with nobody there: nothing times out.
    h.step({ type: 'timer-fired' }, deadline + 60_000);
    expect(timeouts(h)).toEqual([]);

    // The mover comes back 97 seconds later and has the 7 seconds they had left.
    h.now = t0 + 100_000;
    h.join(`${mover.conn}-2`, mover.name, mover.token);
    expect(h.record.match!.pausedAt).toBeUndefined();
    expect(h.record.match!.clocks[0]!.at).toBe(t0 + 107_000);
    expect(h.messages(`${mover.conn}-2`, 'snapshot').at(-1)!.presence.clocks).toEqual([
      { seat: mover.seat, remainingMs: 7_000, running: true },
    ]);
    h.step({ type: 'timer-fired' }, t0 + 106_999);
    expect(timeouts(h)).toEqual([]);
    h.step({ type: 'timer-fired' }, t0 + 107_000);
    expect(timeouts(h).map((i) => i.input)).toEqual([{ kind: 'timeout', seat: mover.seat }]);
  });

  it('charges a time bank only for the time a player was there to decide', () => {
    const h = started({ decisionMs: null, bank: { initialMs: 60_000, incrementMs: 2_000 } });
    const mover = moverOf(h);
    const other = mover.conn === 'c-ana' ? 'c-ben' : 'c-ana';
    const t0 = h.now;
    // The other player leaves first: the mover is still there, so their bank runs on.
    h.step({ type: 'leave', conn: other }, t0 + 1_000);
    h.step({ type: 'leave', conn: mover.conn }, t0 + 5_000);
    h.now = t0 + 65_000;
    h.join(`${mover.conn}-2`, mover.name, mover.token);
    const clock = h.record.match!.clocks[0]!;
    expect(clock.startsAt).toBe(t0 + 60_000);
    expect(clock.at).toBe(t0 + 120_000);
    h.step(
      {
        type: 'act',
        conn: `${mover.conn}-2`,
        id: 'after-pause',
        expectedRevision: h.record.revision,
        command: { take: 1 },
      },
      t0 + 67_000,
    );
    // Five seconds before the pause and two after it, then the increment for moving.
    expect(h.record.match!.banks![mover.seat]).toBe(60_000 - 7_000 + 2_000);
  });

  it('keeps a pause through a restart, however long the server was down', () => {
    const h = started({ decisionMs: 10_000, graceMs: 30_000 });
    const mover = moverOf(h);
    const t0 = h.now;
    h.step({ type: 'leave', conn: 'c-ana' }, t0 + 3_000);
    h.step({ type: 'leave', conn: 'c-ben' }, t0 + 3_000);
    // The server comes back far beyond the grace periods; the table is still paused as it was.
    const r = h.restart(h.core, t0 + 100_000);
    expect(r.record.match!.pausedAt).toBe(t0 + 3_000);
    expect(r.record.match!.clocks[0]!.at).toBe(t0 + 10_000);
    r.now = t0 + 200_000;
    r.join(mover.conn, mover.name, mover.token);
    expect(r.record.match!.clocks[0]!.at).toBe(t0 + 207_000);
    r.step({ type: 'timer-fired' }, t0 + 206_999);
    expect(timeouts(r)).toEqual([]);
  });

  it('gives a table that was live when the server stopped the resume grace, then pauses it until a player returns', () => {
    const h = started({ decisionMs: 10_000 });
    const mover = moverOf(h);
    const deadline = h.record.match!.clocks[0]!.at;
    const back = deadline - 1_000;
    const r = h.restart(h.core, back);
    expect(r.record.match!.pausedAt).toBe(back);
    expect(r.record.match!.clocks[0]!.at).toBe(back + 15_000);
    r.now = back + 100_000;
    r.join(mover.conn, mover.name, mover.token);
    expect(r.record.match!.clocks[0]!.at).toBe(r.now + 15_000);
  });
});
