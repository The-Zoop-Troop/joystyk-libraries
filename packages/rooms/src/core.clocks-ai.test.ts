// Time banks (section 3.7) and the AI's stream, inline and heavy (rule 7).
import { defineEngine } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { Harness, coreFor, effectsOf, hashOf, nim, peek, policy, type NimState } from './__tests__/fixtures.ts';
import type { RoomPolicy } from './types.ts';

const bank = { initialMs: 60_000, incrementMs: 2_000 };

const started = (engine: typeof nim, overrides: Partial<RoomPolicy>, heavy = false) => {
  const h = Harness.create(coreFor(engine, 'nim', '1.0.0', heavy), policy(overrides), { heap: 20 });
  h.join('c-ana', 'Ana', hashOf('ana'));
  h.join('c-ben', 'Ben');
  h.control('c-ana', { kind: 'ready', ready: true });
  h.control('c-ben', { kind: 'ready', ready: true });
  h.control('c-ana', { kind: 'start' });
  return h;
};

const turnConn = (h: Harness): string => ((h.state as NimState).turn === 0 ? 'c-ana' : 'c-ben');

describe('time banks', () => {
  const banked = () => started(nim, { decisionMs: null, bank, absent: 'wait' });

  it('starts every seat with the bank and charges only the time a seat spent deciding', () => {
    const h = banked();
    const match = h.record.match!;
    expect(match.banks).toEqual([60_000, 60_000]);
    const mover = (h.state as NimState).turn;
    expect(match.clocks).toEqual([
      {
        seat: mover,
        at: h.now + 60_000,
        decisionRevision: match.decisionRevision[mover],
        startsAt: h.now,
        onBank: true,
      },
    ]);
    h.step(
      {
        type: 'act',
        conn: turnConn(h),
        id: 'banked-move-1',
        expectedRevision: h.record.revision,
        command: { take: 1 },
      },
      h.now + 10_000,
    );
    expect(h.record.match!.banks![mover]).toBe(60_000 - 10_000 + 2_000);
    expect(h.record.match!.banks![1 - mover]).toBe(60_000);
    const clocks = h.messages('c-ana', 'update').at(-1)!.presence.clocks;
    expect(clocks).toEqual([
      { seat: 0, remainingMs: mover === 0 ? 52_000 : 60_000, running: mover !== 0 },
      { seat: 1, remainingMs: mover === 1 ? 52_000 : 60_000, running: mover !== 1 },
    ]);
  });

  it('empties the bank when it runs out, then applies the timeout', () => {
    const h = banked();
    const mover = (h.state as NimState).turn;
    const heap = (h.state as NimState).heap;
    h.step({ type: 'timer-fired' }, h.record.match!.clocks[0]!.at);
    expect(h.record.match!.banks![mover]).toBe(0);
    expect((h.state as NimState).heap).toBe(heap - 1);
  });

  it('never charges a playback hold, and moves the start with a restart’s extension', () => {
    const h = Harness.create(coreFor(peek, 'peek'), policy({ decisionMs: null, bank, absent: 'wait' }), { hand: 2 });
    h.join('c0', 'Ana', hashOf('ana'));
    h.join('c1', 'Ben');
    h.control('c0', { kind: 'ready', ready: true });
    h.control('c1', { kind: 'ready', ready: true });
    h.control('c0', { kind: 'start' });
    h.act('c0', { draw: true });
    h.step({ type: 'job-completed', jobId: 'draw-0', outcome: { ok: true, value: { card: 50 } } });
    // Peek holds playback for 500 ms after a draw; the bank starts after it.
    const clock = h.record.match!.clocks[0]!;
    expect(clock.startsAt).toBe(h.now + 500);
    h.step(
      { type: 'act', conn: 'c0', id: 'during-hold', expectedRevision: h.record.revision, command: { play: 50 } },
      h.now + 300,
    );
    // The draw and the play were both Ana's own commands, each worth an increment; neither was charged.
    expect(h.record.match!.banks![0]).toBe(60_000 + 2 * 2_000);
    const next = h.record.match!.clocks[0]!;
    const r = h.restart(h.core, next.at - 1_000);
    const resumed = r.record.match!.clocks[0]!;
    expect(resumed.at).toBe(next.at - 1_000 + 15_000);
    expect(resumed.startsAt! - next.startsAt!).toBe(resumed.at - next.at);
  });

  it('lets the engine take a decision off the bank', () => {
    const pause = defineEngine({ ...nim, decisionMs: () => 5_000 });
    const h = started(pause, { decisionMs: null, bank, absent: 'wait' });
    expect(h.record.match!.clocks[0]!.onBank).toBe(false);
    h.step({ type: 'timer-fired' }, h.record.match!.clocks[0]!.at);
    expect(h.record.match!.banks).toEqual([60_000, 60_000]);
  });

  it('switches between a per-move clock and a bank in the lobby', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy({ decisionMs: 10_000 }), { heap: 5 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    h.control('c-ana', { kind: 'settings', bank });
    expect(h.record.policy).toMatchObject({ decisionMs: null, bank });
    h.control('c-ana', { kind: 'settings', decisionMs: 20_000 });
    expect(h.record.policy).toMatchObject({ decisionMs: 20_000, bank: null });
  });

  it('reports per-move clocks as running, and paused when the room is frozen', () => {
    const h = started(nim, { decisionMs: 10_000, absent: 'wait' });
    expect(h.messages('c-ana', 'snapshot').at(-1)!.presence.clocks).toEqual([
      { seat: (h.state as NimState).turn, remainingMs: 10_000, running: true },
    ]);
    h.step({ type: 'leave', conn: 'c-ana' });
    h.step({ type: 'leave', conn: 'c-ben' });
    h.join('c-spec', 'Cy', null, true);
    expect(h.messages('c-spec', 'snapshot').at(-1)!.presence.clocks[0]!.running).toBe(false);
  });
});

describe('the AI stream', () => {
  it('forks each decision from the AI stream and moves it only when the move is accepted', () => {
    const h = Harness.create(coreFor(nim, 'nim'), policy({ start: 'immediate' }), { heap: 30 });
    const before = h.record.match!.aiRng;
    h.join('c-ana', 'Ana', hashOf('ana'));
    if ((h.state as NimState).turn === 0) h.act('c-ana', { take: 1 });
    const aiMoves = h.persisted
      .flatMap((p) => p.inputs)
      .filter((i) => i.input.kind === 'command' && i.input.seat === 1);
    expect(aiMoves.length).toBeGreaterThan(0);
    expect(h.record.match!.aiRng).not.toEqual(before);
  });
});

describe('heavy AI', () => {
  const heavy = () => {
    const h = Harness.create(coreFor(nim, 'nim', '1.0.0', true), policy({ start: 'immediate' }), { heap: 30 });
    h.join('c-ana', 'Ana', hashOf('ana'));
    if ((h.state as NimState).turn === 0) h.act('c-ana', { take: 1 });
    return h;
  };

  it('asks the pool once per decision instead of choosing inside the step', () => {
    const h = heavy();
    const asks = effectsOf(h.last!, 'start-ai');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ seat: 1, level: 'easy', view: h.state });
    // Each decision's child is a kit SFC32 fork, whatever the parent stream's algorithm.
    expect(asks[0]!.rng.algorithm).toBe('sfc32');
    expect((h.state as NimState).turn).toBe(1);
    expect(effectsOf(h.step({ type: 'timer-fired' }), 'start-ai')).toHaveLength(0);
  });

  it('applies a current answer and moves the stream, drops a stale one, and times out a missing one', () => {
    const h = heavy();
    const ask = effectsOf(h.last!, 'start-ai')[0]!;
    const stream = h.record.match!.aiRng;
    const record = h.record;
    const stale = h.step({
      type: 'ai-chosen',
      seat: 1,
      decisionRevision: ask.decisionRevision - 1,
      command: { take: 2 },
    });
    expect(effectsOf(stale, 'log').map((l) => l.event)).toContain('ai_superseded');
    expect(h.record).toBe(record);
    const heap = (h.state as NimState).heap;
    h.step({ type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: { take: 2 } });
    expect((h.state as NimState).heap).toBe(heap - 2);
    expect(h.record.match!.aiRng).not.toEqual(stream);
    h.act('c-ana', { take: 1 });
    const second = effectsOf(h.last!, 'start-ai')[0]!;
    const before = h.record.match!.aiRng;
    const heap2 = (h.state as NimState).heap;
    h.step({ type: 'ai-chosen', seat: 1, decisionRevision: second.decisionRevision, command: null, failure: 'failed' });
    expect((h.state as NimState).heap).toBe(heap2 - 1);
    expect(h.record.match!.aiRng).toEqual(before);
  });

  it.each(['busy', 'lost'] as const)(
    'asks again with backoff when the pool is %s, and never plays the timeout move',
    (failure) => {
      const h = heavy();
      const ask = effectsOf(h.last!, 'start-ai')[0]!;
      const heap = (h.state as NimState).heap;
      let at = h.now;
      for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 16_000]) {
        const failed = h.step(
          { type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure },
          at,
        );
        expect(effectsOf(failed, 'log').map((l) => l.event)).toContain('ai_retry');
        expect(effectsOf(failed, 'alarm')).toEqual([{ type: 'alarm', at: at + wait }]);
        expect(effectsOf(h.step({ type: 'timer-fired' }, at + wait - 1), 'start-ai')).toHaveLength(0);
        at += wait;
        expect(effectsOf(h.step({ type: 'timer-fired' }, at), 'start-ai')).toEqual([ask]);
        expect((h.state as NimState).heap).toBe(heap);
      }
      h.step({ type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: { take: 2 } }, at);
      expect((h.state as NimState).heap).toBe(heap - 2);
    },
  );

  it('falls back to the timeout move after three timeouts or crashes of the same decision', () => {
    const h = heavy();
    const ask = effectsOf(h.last!, 'start-ai')[0]!;
    const heap = (h.state as NimState).heap;
    h.step({ type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure: 'timeout' });
    h.step(
      { type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure: 'busy' },
      h.now + 1_000,
    );
    h.step(
      { type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure: 'crashed' },
      h.now + 2_000,
    );
    expect((h.state as NimState).heap).toBe(heap);
    const third = h.step(
      { type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure: 'timeout' },
      h.now + 4_000,
    );
    expect(effectsOf(third, 'log').map((l) => l.event)).toContain('ai_failed');
    expect((h.state as NimState).heap).toBe(heap - 1);
  });

  it('starts each decision’s retries afresh and forgets a retry the decision outlived', () => {
    const h = heavy();
    const ask = effectsOf(h.last!, 'start-ai')[0]!;
    h.step({ type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure: 'timeout' });
    h.step(
      { type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: null, failure: 'timeout' },
      h.now + 1_000,
    );
    expect(effectsOf(h.step({ type: 'timer-fired' }, h.now + 2_000), 'start-ai')).toEqual([ask]);
    h.step({ type: 'ai-chosen', seat: 1, decisionRevision: ask.decisionRevision, command: { take: 1 } });
    h.act('c-ana', { take: 1 });
    const next = effectsOf(h.last!, 'start-ai')[0]!;
    const heap = (h.state as NimState).heap;
    h.step({ type: 'ai-chosen', seat: 1, decisionRevision: next.decisionRevision, command: null, failure: 'timeout' });
    h.step(
      { type: 'ai-chosen', seat: 1, decisionRevision: next.decisionRevision, command: null, failure: 'timeout' },
      h.now + 1_000,
    );
    expect((h.state as NimState).heap).toBe(heap);
  });

  it('asks again after a restart, with the same child stream', () => {
    const h = heavy();
    const ask = effectsOf(h.last!, 'start-ai')[0]!;
    const r = h.restart();
    r.join('c-ana', 'Ana', hashOf('ana'));
    expect(effectsOf(r.last!, 'start-ai')[0]).toEqual(ask);
  });
});
