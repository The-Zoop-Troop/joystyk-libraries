// Test engines and helpers for the room core's tests. Three tiny games cover every room
// feature: Nim (turn-based, perfect information, an AI), Peek (hidden hands, a job, an AI,
// a timeout rule) and Pass (a simultaneous phase whose decision key ignores who has passed).
import {
  defineEngine,
  err,
  gameError,
  ok,
  type Json,
  type Rng,
  type RngState,
  type SeatId,
  type Validator,
} from '@joystyk/contracts';
import type { GamePin, LiveRoom, RoomCommand, RoomCore, RoomEffect, RoomPolicy, RoomRecord, Step } from '../index.ts';
import { createRoomCore } from '../index.ts';
import type { ServerMessage } from '../protocol/index.ts';

/** A Standard Schema that accepts anything. */
export const anything = <T>(): Validator<T> => ({
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value as T }) },
});

/** A small deterministic generator (mulberry32) whose whole state is one word. */
export const testRng = (state: RngState): Rng => {
  let s = (state.words[0] ?? 0) >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min)),
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
    save: () => ({ algorithm: 'test-mulberry32', words: [s] }),
  };
};

export const seedOf = (n: number): RngState => ({ algorithm: 'test-mulberry32', words: [n >>> 0] });
export const seeds = (n: number) => ({ engine: seedOf(n), ai: seedOf(n + 7919) });

// ── Nim ─────────────────────────────────────────────────────────────────────────────────

export type NimState = { readonly heap: number; readonly turn: SeatId; readonly winner: SeatId | null };
export type NimCommand = { readonly take: number };

export const nim = defineEngine({
  rulesVersion: 1,
  schemas: {
    config: anything<{ heap: number }>(),
    command: anything<NimCommand>(),
    state: anything<NimState>(),
    view: anything<NimState>(),
    event: anything<Json>(),
  },
  init: (config: { heap: number }, seats, rng) =>
    seats.length === 2
      ? ok({ heap: config.heap, turn: rng.int(0, 2), winner: null })
      : err(gameError('Seats', 'Nim needs two players.')),
  apply: (state: NimState, input) => {
    if (state.winner !== null) return err(gameError('GameOver', 'The game is over.'));
    const take = (seat: SeatId, count: number) => {
      const heap = state.heap - count;
      return ok({
        state: { heap, turn: 1 - seat, winner: heap === 0 ? seat : null },
        beats: [{ event: { took: count, seat } }],
      });
    };
    switch (input.kind) {
      case 'command': {
        if (input.seat !== state.turn) return err(gameError('NotYourTurn', "It's not your turn."));
        const count = input.command.take;
        if (!Number.isInteger(count) || count < 1 || count > 3 || count > state.heap)
          return err(gameError('IllegalMove', 'Take one, two or three.'));
        return take(input.seat, count);
      }
      case 'timeout':
        return input.seat === state.turn ? take(input.seat, 1) : err(gameError('NotYourTurn', 'Not pending.'));
      case 'resign':
        return ok({ state: { ...state, winner: 1 - input.seat }, beats: [{ event: { resigned: input.seat } }] });
      case 'seat':
        return ok({ state, beats: [] });
      case 'job':
        return err(gameError('NoJobs', 'Nim has no jobs.'));
    }
  },
  pending: (state) => (state.winner === null ? [state.turn] : []),
  viewFor: (state) => state,
  eventFor: (event) => event,
  outcome: (state) =>
    state.winner === null
      ? null
      : {
          result: 'won',
          placements: [
            { seat: state.winner, place: 1 },
            { seat: 1 - state.winner, place: 2 },
          ],
          summary: `Seat ${state.winner + 1} wins.`,
        },
  ai: { levels: ['easy'], choose: (view: NimState) => ({ take: Math.min(1, view.heap) }) },
});

// ── Peek: hidden hands, a draw job, an AI and a timeout rule ────────────────────────────

export type PeekState = {
  readonly hands: readonly (readonly number[])[];
  readonly deck: readonly number[];
  readonly played: readonly { readonly seat: SeatId; readonly card: number }[];
  readonly turn: SeatId;
  /** The draw job this state waits for. */
  readonly awaiting: string | null;
  readonly draws: number;
};
export type PeekCommand = { readonly play: number } | { readonly draw: true };
export type PeekView = {
  readonly hand: readonly number[] | null;
  readonly handSizes: readonly number[];
  readonly played: readonly { readonly seat: SeatId; readonly card: number }[];
  readonly turn: SeatId;
  readonly drawing: boolean;
};
export type PeekEvent =
  | { readonly type: 'dealt'; readonly seat: SeatId; readonly cards: readonly number[] }
  | { readonly type: 'played'; readonly seat: SeatId; readonly card: number }
  | { readonly type: 'drew'; readonly seat: SeatId; readonly card: number | null };

const finished = (state: PeekState): boolean =>
  state.awaiting === null && state.hands.every((hand) => hand.length === 0);

const playCard = (state: PeekState, seat: SeatId, card: number) => {
  const hands = state.hands.map((hand, i) => (i === seat ? hand.filter((c) => c !== card) : hand));
  const next: PeekState = {
    ...state,
    hands,
    played: [...state.played, { seat, card }],
    turn: (seat + 1) % state.hands.length,
  };
  return ok({ state: next, beats: [{ event: { type: 'played', seat, card } as PeekEvent }] });
};

export const peek = defineEngine({
  rulesVersion: 1,
  schemas: {
    config: anything<{ hand: number }>(),
    command: anything<PeekCommand>(),
    state: anything<PeekState>(),
    view: anything<PeekView>(),
    event: anything<PeekEvent>(),
  },
  init: (config: { hand: number }, seats, rng) => {
    const deck = rng.shuffle(Array.from({ length: 40 }, (_, i) => i + 1));
    const hands = seats.map((_, i) => deck.slice(i * config.hand, (i + 1) * config.hand));
    return ok({ hands, deck: deck.slice(seats.length * config.hand), played: [], turn: 0, awaiting: null, draws: 0 });
  },
  apply: (state: PeekState, input) => {
    if (finished(state)) return err(gameError('GameOver', 'The game is over.'));
    switch (input.kind) {
      case 'command': {
        if (state.awaiting !== null || input.seat !== state.turn)
          return err(gameError('NotYourTurn', "It's not your turn."));
        const command = input.command;
        if ('draw' in command) {
          const id = `draw-${state.draws}`;
          return ok({
            state: { ...state, awaiting: id, draws: state.draws + 1 },
            beats: [],
            jobs: [{ id, kind: 'draw', payload: { seed: state.draws } }],
          });
        }
        if (!state.hands[input.seat]?.includes(command.play))
          return err(gameError('NoSuchCard', 'You do not hold that card.'));
        return playCard(state, input.seat, command.play);
      }
      case 'timeout': {
        if (state.awaiting !== null || input.seat !== state.turn) return err(gameError('NotYourTurn', 'Not pending.'));
        const card = state.hands[input.seat]?.[0];
        if (card === undefined)
          return ok({ state: { ...state, turn: (state.turn + 1) % state.hands.length }, beats: [] });
        return playCard(state, input.seat, card);
      }
      case 'job': {
        if (input.jobId !== state.awaiting) return err(gameError('NoSuchJob', 'Not awaiting that job.'));
        const seat = state.turn;
        const drawn = input.outcome.ok ? (input.outcome.value as { card: number }).card : null;
        const hands = state.hands.map((hand, i) => (i === seat && drawn !== null ? [...hand, drawn] : hand));
        return ok({
          state: { ...state, hands, awaiting: null },
          beats: [{ event: { type: 'drew', seat, card: drawn } as PeekEvent }],
        });
      }
      case 'resign': {
        const hands = state.hands.map((hand, i) => (i === input.seat ? [] : hand));
        return ok({ state: { ...state, hands }, beats: [] });
      }
      case 'seat':
        return ok({ state, beats: [] });
    }
  },
  pending: (state) => (finished(state) || state.awaiting !== null ? [] : [state.turn]),
  viewFor: (state, viewer) => ({
    hand: viewer === null ? null : (state.hands[viewer] ?? null),
    handSizes: state.hands.map((hand) => hand.length),
    played: state.played,
    turn: state.turn,
    drawing: state.awaiting !== null,
  }),
  eventFor: (event, viewer) => {
    if (event.type === 'played') return event;
    if (event.seat === viewer) return event;
    return event.type === 'drew' ? { type: 'drew' as const, seat: event.seat, card: null } : null;
  },
  outcome: (state) => {
    if (!finished(state)) return null;
    const totals = state.hands.map((_, seat) =>
      state.played.filter((p) => p.seat === seat).reduce((sum, p) => sum + p.card, 0),
    );
    const order = totals.map((total, seat) => ({ seat, total })).sort((a, b) => b.total - a.total || a.seat - b.seat);
    return {
      result: 'won',
      placements: order.map((o, i) => ({ seat: o.seat, place: i + 1, score: o.total })),
      summary: 'Done.',
    };
  },
  ai: {
    levels: ['easy', 'hard'],
    choose: (view: PeekView) => (view.hand && view.hand.length > 0 ? { play: view.hand[0] as number } : { play: -1 }),
  },
  jobs: { draw: { where: 'server', payload: anything(), result: anything(), timeoutMs: 5_000 } },
  holdMs: (transition) => (transition.beats.some((b) => b.event.type === 'drew') ? 500 : 0),
});

/** Shuffles everything `viewer` may not see: other seats' cards and the deck. */
export const perturbPeek = (state: PeekState, viewer: SeatId | null, salt: number): PeekState => {
  const hidden = [...state.deck, ...state.hands.flatMap((hand, i) => (i === viewer ? [] : hand))];
  const shuffled = testRng(seedOf(salt))
    .shuffle(hidden)
    .map((c) => c + 100);
  let k = 0;
  const hands = state.hands.map((hand, i) => (i === viewer ? hand : hand.map(() => shuffled[k++] as number)));
  return { ...state, hands, deck: state.deck.map(() => shuffled[k++] as number) };
};

// ── Pass: a simultaneous phase ──────────────────────────────────────────────────────────

export type PassState = {
  readonly round: number;
  readonly picks: readonly (number | null)[];
  readonly totals: readonly number[];
};
export type PassCommand = { readonly pick: number };

export const pass = defineEngine({
  rulesVersion: 1,
  schemas: {
    config: anything<{ rounds: number }>(),
    command: anything<PassCommand>(),
    state: anything<PassState>(),
    view: anything<Json>(),
    event: anything<Json>(),
  },
  init: (_config: { rounds: number }, seats) =>
    ok({ round: 1, picks: seats.map(() => null), totals: seats.map(() => 0) }),
  apply: (state: PassState, input) => {
    if (state.round > 3) return err(gameError('GameOver', 'The game is over.'));
    const pick = (seat: SeatId, value: number) => {
      if (state.picks[seat] !== null) return err(gameError('AlreadyPicked', 'You already picked.'));
      const picks = state.picks.map((p, i) => (i === seat ? value : p));
      if (picks.every((p) => p !== null)) {
        const totals = state.totals.map((t, i) => t + (picks[i] ?? 0));
        return ok({
          state: { round: state.round + 1, picks: picks.map(() => null), totals },
          beats: [{ event: { revealed: picks } as Json }],
        });
      }
      return ok({ state: { ...state, picks }, beats: [{ event: { passed: seat } as Json }] });
    };
    switch (input.kind) {
      case 'command':
        if (![1, 2, 3].includes(input.command.pick)) return err(gameError('IllegalPick', 'Pick 1, 2 or 3.'));
        return pick(input.seat, input.command.pick);
      case 'timeout':
        return pick(input.seat, 1);
      case 'seat':
        return ok({ state, beats: [] });
      case 'resign':
        return ok({ state: { ...state, round: 4 }, beats: [] });
      case 'job':
        return err(gameError('NoJobs', 'No jobs.'));
    }
  },
  pending: (state) => (state.round > 3 ? [] : state.picks.flatMap((p, i) => (p === null ? [i] : []))),
  viewFor: (state, viewer) => ({
    round: state.round,
    mine: viewer === null ? null : (state.picks[viewer] ?? null),
    passed: state.picks.map((p) => p !== null),
    totals: state.totals,
  }),
  eventFor: (event) => event,
  outcome: (state) =>
    state.round > 3
      ? {
          result: 'completed',
          placements: state.totals.map((t, seat) => ({ seat, place: 1, score: t })),
          summary: 'Done.',
        }
      : null,
  // Who has already passed is not part of a seat's decision.
  decisionKey: (state, seat) => ({ round: state.round, picked: state.picks[seat] !== null }),
  ai: { levels: ['easy'], choose: () => ({ pick: 2 }) },
});

// ── Room helpers ────────────────────────────────────────────────────────────────────────

export const pinOf = (id: string, rulesVersion = 1, build = '1.0.0'): GamePin => ({
  id,
  build,
  rulesVersion,
  saveVersion: 1,
});

export const policy = (overrides: Partial<RoomPolicy> = {}): RoomPolicy => ({
  seats: { min: 2, max: 2 },
  start: 'host',
  lateJoin: 'spectate',
  absent: 'ai',
  graceMs: 30_000,
  decisionMs: null,
  maxSpectators: 2,
  retainMs: 86_400_000,
  ...overrides,
});

export const coreFor = (
  engine: Parameters<typeof createRoomCore>[0]['engine'],
  id: string,
  build = '1.0.0',
  heavyAi = false,
): RoomCore => createRoomCore({ engine, pin: pinOf(id, engine.rulesVersion, build), rng: testRng, heavyAi });

/** A token hash stand-in: the core only compares hashes. */
export const hashOf = (name: string): string => `hash-${name}`;

/**
 * Drives one room through the core like an adapter would, keeping the persisted records
 * and logged inputs, and the messages each connection received.
 */
export class Harness {
  room: LiveRoom;
  now: number;
  readonly persisted: { record: RoomRecord; inputs: readonly import('../index.ts').LoggedInput[] }[] = [];
  readonly inbox = new Map<string, ServerMessage[]>();
  readonly dropped = new Map<string, string>();
  readonly welcomes = new Map<string, { seat: SeatId | null; issued: boolean }>();
  last: Step | null = null;
  private ids = 0;
  private seedCounter = 100;

  core: RoomCore;

  constructor(core: RoomCore, record: RoomRecord, now = 1_000_000) {
    this.core = core;
    this.now = now;
    this.room = core.load(record);
    this.step({ type: 'resume' });
  }

  static create(core: RoomCore, roomPolicy: RoomPolicy, config: Json, creator = 'ana', now = 1_000_000): Harness {
    const created = core.create(
      {
        code: 'ABCDEF',
        policy: roomPolicy,
        config,
        seeds: seeds(1),
        creator: { name: creator, tokenHash: hashOf(creator) },
      },
      now,
    );
    if (!created.ok) throw new Error(created.error.message);
    return new Harness(core, created.value, now);
  }

  step(command: RoomCommand, at = this.now): Step {
    this.now = at;
    const result = this.core.step(this.room, command, at);
    this.room = result.room;
    this.last = result;
    for (const effect of result.effects) this.perform(effect);
    return result;
  }

  private perform(effect: RoomEffect): void {
    switch (effect.type) {
      case 'persist':
        this.persisted.push({ record: effect.record, inputs: effect.inputs });
        break;
      case 'welcome':
        this.welcomes.set(effect.conn, { seat: effect.message.seat, issued: effect.issueToken });
        this.push(effect.conn, effect.message);
        break;
      case 'send':
        for (const conn of effect.to) this.push(conn, effect.message);
        break;
      case 'drop':
        this.dropped.set(effect.conn, effect.reason);
        break;
      default:
        break;
    }
  }

  private push(conn: string, message: ServerMessage): void {
    const list = this.inbox.get(conn) ?? [];
    list.push(message);
    this.inbox.set(conn, list);
  }

  join(conn: string, name: string, token: string | null = null, watch = false): Step {
    return this.step({
      type: 'join',
      conn,
      name,
      protocol: 1,
      presentedTokenHash: token,
      freshTokenHash: hashOf(name),
      watch,
    });
  }

  act(conn: string, command: Json, rev = this.room.record.revision, id = this.nextId()): Step {
    return this.step({ type: 'act', conn, id, expectedRevision: rev, command });
  }

  control(
    conn: string,
    control: import('../index.ts').RoomControl,
    rev = this.room.record.revision,
    id = this.nextId(),
  ): Step {
    this.seedCounter += 1;
    return this.step({ type: 'control', conn, id, expectedRevision: rev, control, seeds: seeds(this.seedCounter) });
  }

  nextId(): string {
    this.ids += 1;
    return `action-${String(this.ids).padStart(4, '0')}`;
  }

  /** Messages a connection received, optionally only of one type. */
  messages<T extends ServerMessage['t']>(conn: string, t?: T): Extract<ServerMessage, { t: T }>[] {
    return (this.inbox.get(conn) ?? []).filter(
      (m): m is Extract<ServerMessage, { t: T }> => t === undefined || m.t === t,
    );
  }

  lastReceipt(conn: string) {
    return this.messages(conn, 'receipt').at(-1)?.result;
  }

  get record(): RoomRecord {
    return this.room.record;
  }

  get state(): Json {
    const match = this.room.record.match;
    if (match === null) throw new Error('No match.');
    return match.state;
  }

  /** The room as it would load after a restart: the last persisted record, nothing live. */
  restart(core: RoomCore = this.core, at = this.now): Harness {
    const last = this.persisted.at(-1)?.record ?? this.room.record;
    const next = new Harness(core, JSON.parse(JSON.stringify(last)) as RoomRecord, at);
    return next;
  }
}

/** Effects of one kind from a step. */
export const effectsOf = <T extends RoomEffect['type']>(step: Step, type: T): Extract<RoomEffect, { type: T }>[] =>
  step.effects.filter((e): e is Extract<RoomEffect, { type: T }> => e.type === type);
