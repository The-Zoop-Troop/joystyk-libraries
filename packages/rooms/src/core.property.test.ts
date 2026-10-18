// Property tests for the room core (room-server.md section 10): random command sequences,
// with the core's invariants checked after every step.
import type { AnyDiscreteEngine, EngineInput, Json, SeatId } from '@joystyk/contracts';
import { restoreRng } from '@joystyk/kit';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.ts';
import type { ServerMessage } from './protocol/index.ts';
import { decodeRecord } from './record.ts';
import type {
  LiveRoom,
  LoggedInput,
  RoomCommand,
  RoomControl,
  RoomCore,
  RoomEffect,
  RoomPolicy,
  RoomRecord,
  Step,
} from './types.ts';
import {
  coreFor,
  hashOf,
  pass,
  peek,
  perturbPeek,
  policy,
  seeds,
  testRng,
  type PeekState,
} from './__tests__/fixtures.ts';

const NAMES = ['ana', 'bob', 'cy', 'di'] as const;

type Op =
  | { readonly op: 'join'; readonly who: number; readonly token: 'own' | 'none' | 'wrong'; readonly watch: boolean }
  | { readonly op: 'leave'; readonly who: number }
  | { readonly op: 'act'; readonly who: number; readonly cmd: number; readonly rev: number; readonly id: number }
  | {
      readonly op: 'control';
      readonly who: number;
      readonly kind: number;
      readonly seat: number;
      readonly rev: number;
      readonly id: number;
    }
  | { readonly op: 'time'; readonly mode: 'alarm' | 'early' | 'same' | 'advance'; readonly ms: number }
  | { readonly op: 'job'; readonly id: number; readonly ok: boolean }
  | { readonly op: 'ai'; readonly pick: number; readonly mode: 'answer' | 'null' | 'stale' }
  | { readonly op: 'restart' };

const who = fc.integer({ min: 0, max: 4 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('join' as const),
      who,
      token: fc.constantFrom('own' as const, 'none' as const, 'wrong' as const),
      watch: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('leave' as const), who }) },
  {
    weight: 6,
    arbitrary: fc.record({
      op: fc.constant('act' as const),
      who,
      cmd: fc.integer({ min: 0, max: 5 }),
      rev: fc.integer({ min: -3, max: 1 }),
      id: fc.integer({ min: 0, max: 5 }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('control' as const),
      who,
      kind: fc.integer({ min: 0, max: 12 }),
      seat: fc.integer({ min: 0, max: 3 }),
      rev: fc.integer({ min: -1, max: 1 }),
      id: fc.integer({ min: 0, max: 5 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      op: fc.constant('time' as const),
      mode: fc.constantFrom('alarm' as const, 'early' as const, 'same' as const, 'advance' as const),
      ms: fc.integer({ min: 0, max: 40_000 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant('job' as const), id: fc.integer({ min: 0, max: 3 }), ok: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('ai' as const),
      pick: fc.integer({ min: 0, max: 3 }),
      mode: fc.constantFrom('answer' as const, 'null' as const, 'stale' as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.constant('restart' as const) }) },
);

/** A room control; answers name the room's current offer, or a stale one when `seat` is 3. */
const controlOf = (kind: number, seat: number, room: LiveRoom): RoomControl => {
  const offer = Math.max(0, (room.record.offer?.id ?? 0) - (seat === 3 ? 1 : 0));
  switch (kind) {
    case 0:
      return { kind: 'ready', ready: true };
    case 1:
      return { kind: 'ready', ready: false };
    case 2:
      return { kind: 'start' };
    case 3:
      return { kind: 'offer', offer: seat % 2 === 0 ? 'rematch' : 'end' };
    case 9:
      return { kind: 'accept', offer };
    case 10:
      return { kind: 'decline', offer };
    case 11:
      return { kind: 'withdraw', offer };
    case 4:
      return { kind: 'fill-with-ai', seat };
    case 5:
      return { kind: 'remove-seat', seat };
    case 6:
      return { kind: 'leave-seat' };
    case 7:
      return { kind: 'resign' };
    default:
      return { kind: 'settings', decisionMs: seat === 0 ? null : 5_000 * seat };
  }
};

type Game = {
  readonly name: string;
  readonly core: RoomCore;
  readonly policy: RoomPolicy;
  readonly config: Json;
  readonly command: (cmd: number, room: LiveRoom, seat: SeatId | null) => Json;
  /** Perturbs what `viewer` may not see; null when the game hides nothing. */
  readonly perturb: ((state: Json, viewer: SeatId | null, salt: number) => Json) | null;
};

const games: readonly Game[] = [
  {
    name: 'Peek (hidden hands, a job, AI)',
    core: coreFor(peek, 'peek'),
    policy: policy({ seats: { min: 2, max: 3 }, decisionMs: 10_000, absent: 'wait', lateJoin: 'take-ai-seat' }),
    config: { hand: 2 },
    command: (cmd, room, seat) => {
      if (cmd === 0) return { draw: true } as Json;
      if (cmd === 5) return { play: 999 };
      const state = room.record.match?.state as PeekState | undefined;
      const hand = seat === null ? [] : (state?.hands[seat] ?? []);
      return { play: hand[(cmd - 1) % Math.max(1, hand.length)] ?? 1 };
    },
    perturb: (state, viewer, salt) => perturbPeek(state as PeekState, viewer, salt),
  },
  {
    name: 'Peek with AI handover',
    core: coreFor(peek, 'peek'),
    policy: policy({ seats: { min: 2, max: 3 }, decisionMs: 10_000, absent: 'ai', graceMs: 5_000 }),
    config: { hand: 3 },
    command: (cmd, room, seat) => {
      const state = room.record.match?.state as PeekState | undefined;
      const hand = seat === null ? [] : (state?.hands[seat] ?? []);
      return cmd === 0 ? ({ draw: true } as Json) : { play: hand[0] ?? cmd };
    },
    perturb: (state, viewer, salt) => perturbPeek(state as PeekState, viewer, salt),
  },
  {
    name: 'Peek with heavy AI on the pool',
    core: coreFor(peek, 'peek', '1.0.0', true),
    policy: policy({
      seats: { min: 2, max: 3 },
      decisionMs: 10_000,
      absent: 'ai',
      graceMs: 5_000,
      lateJoin: 'take-ai-seat',
    }),
    config: { hand: 3 },
    command: (cmd, room, seat) => {
      const state = room.record.match?.state as PeekState | undefined;
      const hand = seat === null ? [] : (state?.hands[seat] ?? []);
      return cmd === 0 ? ({ draw: true } as Json) : { play: hand[0] ?? cmd };
    },
    perturb: (state, viewer, salt) => perturbPeek(state as PeekState, viewer, salt),
  },
  {
    name: 'Pass with a time bank',
    core: coreFor(pass, 'pass'),
    policy: policy({
      seats: { min: 2, max: 4 },
      decisionMs: null,
      bank: { initialMs: 20_000, incrementMs: 1_000 },
      absent: 'wait',
    }),
    config: { rounds: 3 },
    command: (cmd) => ({ pick: cmd % 4 }),
    perturb: null,
  },
  {
    name: 'Pass (simultaneous phase)',
    core: coreFor(pass, 'pass'),
    policy: policy({ seats: { min: 2, max: 4 }, decisionMs: 8_000, absent: 'timeout', graceMs: 4_000 }),
    config: { rounds: 3 },
    command: (cmd) => ({ pick: cmd % 4 }),
    perturb: null,
  },
];

const humanMember = (room: LiveRoom): boolean =>
  [...room.members.values()].some((m) => m.seat !== null && room.record.seats[m.seat]?.controller === 'human');

/** Recipient → viewer seat, from the room before and after (dropped connections keep theirs). */
const viewerOf = (before: LiveRoom, after: LiveRoom, conn: string): SeatId | null | undefined =>
  after.members.has(conn) ? after.members.get(conn)?.seat : before.members.get(conn)?.seat;

const replay = (engine: AnyDiscreteEngine, record: RoomRecord, inputs: readonly LoggedInput[]): Json => {
  const match = record.match;
  if (match === null) throw new Error('No match.');
  const rng = testRng(match.seed);
  const init = engine.init(match.config, match.seats, rng);
  if (!init.ok) throw new Error(init.error.message);
  let state = init.value;
  for (const { input } of inputs.filter((i) => i.match === match.number)) {
    const result = engine.apply(state, input as EngineInput<Json>, rng);
    if (!result.ok) throw new Error(`Replay rejected ${JSON.stringify(input)}: ${result.error.code}`);
    state = result.value.state;
  }
  return state;
};

const checkStep = (
  game: Game,
  before: LiveRoom,
  command: RoomCommand,
  now: number,
  step: Step,
  inputs: readonly LoggedInput[],
): void => {
  const { core } = game;
  const engine = core.engine;
  const after = step.room;
  const record = after.record;

  // 1. Deterministic.
  expect(core.step(before, command, now)).toEqual(step);

  // 2. One persist at most, always first, carrying the new record.
  const persists = step.effects.filter((e) => e.type === 'persist');
  expect(persists.length).toBeLessThanOrEqual(1);
  if (persists.length === 1) {
    expect(step.effects[0]).toBe(persists[0]);
    expect(persists[0]?.type === 'persist' && persists[0].record).toBe(record);
    expect(record.writes).toBe(before.record.writes + 1);
  } else {
    expect(record).toBe(before.record);
  }

  // 3. A rejected action changes nothing beyond what the clock alone would have changed.
  if (command.type === 'act' || command.type === 'control') {
    const receipt = step.effects.find(
      (e) => e.type === 'send' && e.message.t === 'receipt' && e.to.includes(command.conn),
    );
    if (receipt?.type === 'send' && receipt.message.t === 'receipt' && receipt.message.result.status === 'rejected') {
      const clockOnly = core.step(before, { type: 'timer-fired' }, now).room.record;
      expect(canonicalJson(record as unknown as Json)).toBe(canonicalJson(clockOnly as unknown as Json));
    }
  }

  // 4. Revisions never fall, and rise at least once per logged input.
  const logged = persists[0]?.type === 'persist' ? persists[0].inputs : [];
  expect(record.revision).toBeGreaterThanOrEqual(before.record.revision + logged.length);

  // 5. Every view a connection receives is its own seat's view (or the spectators').
  const match = record.match;
  for (const effect of step.effects) {
    if (effect.type !== 'send') continue;
    const message = effect.message;
    if (message.t !== 'update' && message.t !== 'snapshot') continue;
    for (const conn of effect.to) {
      const viewer = viewerOf(before, after, conn);
      expect(viewer).not.toBeUndefined();
      const expected = match === null ? null : engine.viewFor(match.state, viewer ?? null);
      expect(message.view).toEqual(expected);
      if (message.t === 'snapshot') {
        expect(message.seat).toBe(viewer);
        const history = (match?.log ?? []).map((e) => engine.eventFor(e, viewer ?? null)).filter((e) => e !== null);
        expect(message.history).toEqual(history);
      }
    }
  }
  //    …and changing what a seat can't see changes nothing it is sent.
  if (game.perturb !== null && match !== null) {
    for (const [conn, member] of after.members) {
      const perturbedState = game.perturb(match.state, member.seat, record.revision + 1);
      const perturbed: LiveRoom = { ...after, record: { ...record, match: { ...match, state: perturbedState } } };
      const a = core.step(after, { type: 'resync', conn }, now).effects.filter((e) => e.type === 'send');
      const b = core.step(perturbed, { type: 'resync', conn }, now).effects.filter((e) => e.type === 'send');
      expect(b).toEqual(a);
    }
  }

  // 6. At most one connection per seat.
  const seated = [...after.members.values()].flatMap((m) => (m.seat === null ? [] : [m.seat]));
  expect(new Set(seated).size).toBe(seated.length);

  // 7. The host holds a claimed seat, or there is none.
  if (record.host !== null) expect(record.seats[record.host]?.claim).not.toBeNull();

  // 8. Clocks only for pending human seats; the alarm is no later than the earliest clock.
  if (match !== null && record.phase === 'playing') {
    const pending = new Set(engine.pending(match.state));
    for (const clock of match.clocks) {
      expect(pending.has(clock.seat)).toBe(true);
      expect(record.seats[clock.seat]?.controller).toBe('human');
    }
    if (humanMember(after) && match.clocks.length > 0) {
      const earliest = Math.min(...match.clocks.map((c) => c.at));
      expect(after.alarmAt).not.toBeNull();
      expect(after.alarmAt!).toBeLessThanOrEqual(Math.max(earliest, now + 1_000));
    }
  } else if (match !== null) {
    expect(match.clocks).toEqual([]);
  }

  // 9. Replaying the input log from the seed reproduces the state.
  if (match !== null) expect(replay(engine, record, inputs)).toEqual(match.state);

  // 10. A frozen room applies no AI or clock inputs.
  if (
    !humanMember(before) &&
    !humanMember(after) &&
    (command.type === 'timer-fired' || command.type === 'leave' || command.type === 'resume')
  ) {
    expect(logged.every((i) => i.input.kind === 'job')).toBe(true);
  }

  // 11. Bank mode: no bank is negative or holds more than its start plus one increment per move.
  const bank = record.policy.bank ?? null;
  if (bank !== null && match?.banks !== undefined) {
    match.banks.forEach((left, seat) => {
      const moves = inputs.filter(
        (i) => i.match === match.number && i.input.kind === 'command' && i.input.seat === seat,
      ).length;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(bank.initialMs + bank.incrementMs * moves);
    });
  }

  // 12. A heavy-AI answer for a decision that has moved on changes nothing.
  if (
    command.type === 'ai-chosen' &&
    (before.record.match?.decisionRevision[command.seat] ?? -1) !== command.decisionRevision
  ) {
    const clockOnly = core.step(before, { type: 'timer-fired' }, now).room.record;
    expect(canonicalJson(record as unknown as Json)).toBe(canonicalJson(clockOnly as unknown as Json));
  }

  // 13. Records survive JSON and the record schema.
  const decoded = decodeRecord(JSON.parse(JSON.stringify(record)));
  expect(decoded.ok && decoded.value.record).toEqual(record);

  // Timer races: every timeout for a human seat answers a clock that was already due.
  const beforeMatch = before.record.match;
  const clocks = [...(beforeMatch?.clocks ?? [])];
  for (const { input } of logged) {
    // AI seats fall back to a timeout when their move is refused; only human seats need a clock.
    if (
      input.kind !== 'timeout' ||
      before.record.seats[input.seat]?.controller !== 'human' ||
      record.seats[input.seat]?.controller !== 'human'
    )
      continue;
    // Under the timeout policy an absent seat's turn expires without a clock (leave-seat starts that at once).
    const absent =
      ![...before.members.values()].some((m) => m.seat === input.seat) ||
      ![...after.members.values()].some((m) => m.seat === input.seat);
    if (game.policy.absent === 'timeout' && absent) continue;
    // An empty bank times out as soon as its seat is pending again (section 3.7).
    if (bank !== null && record.match?.banks?.[input.seat] === 0) continue;
    const index = clocks.findIndex((c) => c.seat === input.seat && c.at <= now);
    expect(index, `timeout for seat ${input.seat} at ${now} without a due clock`).toBeGreaterThanOrEqual(0);
    clocks.splice(index, 1);
  }
};

/** Seats `players` players (and optionally one AI), readies them and starts, so play begins. */
const prelude = (players: number, ai: boolean): Op[] => {
  const ops: Op[] = [];
  for (let i = 0; i < players; i += 1) ops.push({ op: 'join', who: i, token: i === 0 ? 'own' : 'none', watch: false });
  if (ai) ops.push({ op: 'control', who: 0, kind: 4, seat: players, rev: 0, id: 9 });
  for (let i = 0; i < players; i += 1) ops.push({ op: 'control', who: i, kind: 0, seat: 0, rev: 0, id: 8 });
  ops.push({ op: 'control', who: 0, kind: 2, seat: 0, rev: 0, id: 7 });
  return ops;
};

const run = (game: Game, ops: readonly Op[]): void => {
  const created = game.core.create(
    {
      code: 'ABCDEF',
      policy: game.policy,
      config: game.config,
      seeds: seeds(11),
      creator: { name: 'ana', tokenHash: hashOf('ana') },
    },
    1_000_000,
  );
  if (!created.ok) throw new Error(created.error.message);
  let now = 1_000_000;
  let lastPersisted: RoomRecord = created.value;
  const inputs: LoggedInput[] = [];
  let room = game.core.load(created.value);
  let seedCounter = 500;
  let asks: Extract<RoomEffect, { type: 'start-ai' }>[] = [];

  const apply = (command: RoomCommand): void => {
    const before = room;
    const step = game.core.step(before, command, now);
    const persist = step.effects.find((e) => e.type === 'persist');
    if (persist?.type === 'persist') {
      lastPersisted = persist.record;
      inputs.push(...persist.inputs);
    }
    checkStep(game, before, command, now, step, inputs);
    for (const effect of step.effects) if (effect.type === 'start-ai') asks.push(effect);
    room = step.room;
  };

  apply({ type: 'resume' });
  for (const op of ops) {
    const conn = op.op === 'join' || op.op === 'leave' || op.op === 'act' || op.op === 'control' ? `c${op.who}` : '';
    const seat = room.members.get(conn)?.seat ?? null;
    switch (op.op) {
      case 'join': {
        const name = NAMES[op.who] ?? 'spec';
        const token = op.token === 'own' ? hashOf(name) : op.token === 'wrong' ? 'hash-nobody' : null;
        apply({
          type: 'join',
          conn,
          name,
          protocol: 1,
          presentedTokenHash: token,
          freshTokenHash: hashOf(name),
          watch: op.watch,
        });
        break;
      }
      case 'leave':
        apply({ type: 'leave', conn });
        break;
      case 'act':
        apply({
          type: 'act',
          conn,
          id: `act-${op.who}-${op.id}`,
          expectedRevision: Math.max(0, room.record.revision + op.rev),
          command: game.command(op.cmd, room, seat),
        });
        break;
      case 'control':
        seedCounter += 1;
        apply({
          type: 'control',
          conn,
          id: `ctl-${op.who}-${op.id}`,
          expectedRevision: Math.max(0, room.record.revision + op.rev),
          control: controlOf(op.kind, op.seat, room),
          seeds: seeds(seedCounter),
        });
        break;
      case 'time': {
        const alarm = room.alarmAt;
        if (op.mode === 'alarm') now = Math.max(now, alarm ?? now + op.ms);
        else if (op.mode === 'early') now = Math.max(now, (alarm ?? now) - 1);
        else if (op.mode === 'advance') now += op.ms;
        apply({ type: 'timer-fired' });
        break;
      }
      case 'job':
        apply({
          type: 'job-completed',
          jobId: `draw-${op.id}`,
          outcome: op.ok
            ? { ok: true, value: { card: 60 + op.id }, presentation: { id: op.id } }
            : { ok: false, reason: 'failed' },
        });
        break;
      case 'ai': {
        const ask = asks.splice(op.pick % Math.max(1, asks.length), 1)[0];
        if (ask === undefined) break;
        const ai = game.core.engine.ai;
        const decisionRevision = op.mode === 'stale' ? ask.decisionRevision - 1 : ask.decisionRevision;
        if (op.mode === 'null' || ai === undefined) {
          const failure = (['busy', 'lost', 'timeout', 'crashed', 'failed'] as const)[op.pick % 5]!;
          apply({ type: 'ai-chosen', seat: ask.seat, decisionRevision, command: null, failure });
        } else {
          apply({
            type: 'ai-chosen',
            seat: ask.seat,
            decisionRevision,
            command: ai.choose(ask.view, ask.seat, ask.level, restoreRng(ask.rng)),
          });
        }
        break;
      }
      case 'restart':
        asks = [];
        room = game.core.load(JSON.parse(JSON.stringify(lastPersisted)) as RoomRecord);
        apply({ type: 'resume' });
        break;
    }
  }
};

describe.each(games)('the room core under random commands: $name', (game) => {
  // 80 runs of up to 80 commands, each checked against every invariant: a few seconds on a quiet
  // machine and several times that on a loaded one, so the run count stays and the budget grows.
  it('keeps every invariant after every step', { timeout: 120_000 }, () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 }),
        fc.boolean(),
        fc.array(opArb, { minLength: 10, maxLength: 80 }),
        (players, ai, ops) => run(game, [...prelude(players + (ai ? 0 : 1), ai), ...ops]),
      ),
      { numRuns: 80 },
    );
  });
});

describe('duplicate and stale actions under random play', () => {
  it('answers any resent accepted action with its receipt and changes nothing', { timeout: 120_000 }, () => {
    const game = games[0]!;
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 12 }), (moves) => {
        const created = game.core.create(
          {
            code: 'ABCDEF',
            policy: game.policy,
            config: { hand: 4 },
            seeds: seeds(5),
            creator: { name: 'ana', tokenHash: hashOf('ana') },
          },
          0,
        );
        if (!created.ok) throw new Error('create failed');
        let room = game.core.load(created.value);
        const step = (command: RoomCommand): Step => {
          const result = game.core.step(room, command, 0);
          room = result.room;
          return result;
        };
        step({ type: 'resume' });
        step({
          type: 'join',
          conn: 'a',
          name: 'ana',
          protocol: 1,
          presentedTokenHash: hashOf('ana'),
          freshTokenHash: 'x',
          watch: false,
        });
        step({
          type: 'join',
          conn: 'b',
          name: 'bob',
          protocol: 1,
          presentedTokenHash: null,
          freshTokenHash: hashOf('bob'),
          watch: false,
        });
        for (const conn of ['a', 'b'])
          step({
            type: 'control',
            conn,
            id: `ready-${conn}-1`,
            expectedRevision: room.record.revision,
            control: { kind: 'ready', ready: true },
            seeds: seeds(1),
          });
        step({
          type: 'control',
          conn: 'a',
          id: 'start-0001',
          expectedRevision: room.record.revision,
          control: { kind: 'start' },
          seeds: seeds(2),
        });
        moves.forEach((card, i) => {
          const turn = (room.record.match?.state as PeekState).turn;
          const conn = turn === 0 ? 'a' : 'b';
          const hand = (room.record.match?.state as PeekState).hands[turn] ?? [];
          const command: RoomCommand = {
            type: 'act',
            conn,
            id: `move-${i}-xyz`,
            expectedRevision: room.record.revision,
            command: { play: hand[card % Math.max(1, hand.length)] ?? 0 },
          };
          const first = step(command);
          const firstReceipt = first.effects.find(
            (e): e is Extract<typeof e, { type: 'send' }> => e.type === 'send' && e.message.t === 'receipt',
          );
          const record = room.record;
          const again = step(command);
          expect(again.effects.some((e) => e.type === 'persist')).toBe(false);
          expect(room.record).toBe(record);
          const replayReceipt = again.effects.find((e) => e.type === 'send' && e.message.t === 'receipt');
          const result = (m: ServerMessage | undefined) => (m?.t === 'receipt' ? m.result : null);
          if (result(firstReceipt?.message)?.status === 'accepted') {
            expect(replayReceipt?.type === 'send' && result(replayReceipt.message)).toEqual(
              result(firstReceipt?.message),
            );
            const changed = step({ ...command, command: { play: -42 } });
            const code = changed.effects.find((e) => e.type === 'send' && e.message.t === 'receipt');
            expect(
              code?.type === 'send' &&
                code.message.t === 'receipt' &&
                code.message.result.status === 'rejected' &&
                code.message.result.code,
            ).toBe('action-id-reused');
          }
        });
      }),
      { numRuns: 100 },
    );
  });
});
