// The remote session client against a fake socket: joining with a token, snapshots and
// updates, action IDs and revisions, receipts and notices, reconnects with backoff, close
// codes, spectators and disposal. apps/rooms runs it against a real room server too.
import type { StandardSchemaV1 } from '@joystyk/contracts';
import type { ClientMessage, PublicSeat, ServerMessage, SnapshotMessage, UpdateMessage } from '@joystyk/rooms/protocol';
import { describe, expect, it, vi } from 'vitest';
import { manualClock } from './fakes.test-util.ts';
import {
  createRemoteSession,
  memoryTokens,
  reconnectDelay,
  type RemoteGame,
  type RemoteSnapshot,
  type SocketEvents,
} from './remote.ts';

type View = { readonly heap: number; readonly turn: number };
type Command = { readonly take: number };
type Event = { readonly seat: number; readonly took: number };

const schema = <T>(check: (value: unknown) => boolean): StandardSchemaV1<unknown, T> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => (check(value) ? { value: value as T } : { issues: [{ message: 'invalid' }] }),
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const game: RemoteGame<Command, View, Event> = {
  id: 'nim',
  build: '1.0.0',
  rulesVersion: 1,
  schemas: {
    command: schema((v) => isRecord(v) && typeof v['take'] === 'number' && v['take'] >= 1 && v['take'] <= 3),
    view: schema((v) => isRecord(v) && typeof v['heap'] === 'number' && typeof v['turn'] === 'number'),
    event: schema((v) => isRecord(v) && typeof v['took'] === 'number'),
  },
};

const PIN = { id: 'nim', build: '1.0.0', rulesVersion: 1, saveVersion: 1 };
const TOKEN = 'T'.repeat(32);

class FakeSocket {
  readonly sent: ClientMessage[] = [];
  closed: number | null = null;
  readonly events: SocketEvents;

  constructor(events: SocketEvents) {
    this.events = events;
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text) as ClientMessage);
  }

  close(code = 1000): void {
    this.closed = code;
  }

  serve(message: ServerMessage): void {
    this.events.message(JSON.stringify(message));
  }

  last(): ClientMessage | undefined {
    return this.sent.at(-1);
  }
}

const seats: PublicSeat[] = [
  { id: 0, name: 'Ana', controller: 'human', aiLevel: null, claimed: true, ready: false },
  { id: 1, name: 'Ben', controller: 'human', aiLevel: null, claimed: true, ready: false },
];

const presence = {
  connected: [true, true],
  clocks: [{ seat: 0, remainingMs: 30_000, running: true }],
  paused: false,
  spectators: 1,
};

const snapshot = (overrides: Partial<SnapshotMessage> = {}): SnapshotMessage => ({
  v: 1,
  t: 'snapshot',
  epoch: 0,
  revision: 5,
  phase: 'playing',
  seat: 0,
  seats,
  host: 0,
  game: PIN,
  settings: { decisionMs: 30_000, bank: null, aiLevel: null },
  view: { heap: 10, turn: 0 },
  history: [],
  pending: [0],
  outcome: null,
  presentation: null,
  presence,
  serverTime: 1,
  ...overrides,
});

const update = (overrides: Partial<UpdateMessage> = {}): UpdateMessage => ({
  v: 1,
  t: 'update',
  epoch: 0,
  revision: 6,
  from: 5,
  phase: 'playing',
  host: 0,
  beats: [{ event: { seat: 0, took: 2 }, view: { heap: 8, turn: 1 } }],
  view: { heap: 8, turn: 1 },
  pending: [1],
  outcome: null,
  presence,
  serverTime: 2,
  ...overrides,
});

const welcome = (seat: number | null, token?: string): ServerMessage => ({
  v: 1,
  t: 'welcome',
  room: 'ABCDEF',
  seat,
  host: 0,
  game: PIN,
  protocol: 1,
  ...(token === undefined ? {} : { token }),
});

const setup = (options: { watch?: boolean; token?: string } = {}) => {
  const clock = manualClock();
  const tokens = memoryTokens();
  if (options.token !== undefined) tokens.set('ABCDEF', options.token);
  const sockets: FakeSocket[] = [];
  let ids = 0;
  const report = vi.fn();
  const session = createRemoteSession({
    game,
    room: 'ABCDEF',
    name: 'Ana',
    ...(options.watch === undefined ? {} : { watch: options.watch }),
    connect: (events) => {
      const socket = new FakeSocket(events);
      sockets.push(socket);
      return socket;
    },
    tokens,
    clock,
    actionId: () => `action-${String((ids += 1))}-xyz`,
    random: () => 0,
    report,
  });
  const seen: RemoteSnapshot<View, Event>[] = [];
  session.subscribe((s) => seen.push(s));
  const socket = (): FakeSocket => {
    const last = sockets.at(-1);
    if (last === undefined) throw new Error('no socket');
    return last;
  };
  /** Opens the current socket and answers the join like the server does. */
  const online = (seat: number | null = 0, snap: Partial<SnapshotMessage> = {}): void => {
    socket().events.open();
    socket().serve(welcome(seat));
    socket().serve(snapshot({ seat, ...snap }));
  };
  return { session, clock, tokens, sockets, socket, seen, online, report };
};

describe('joining', () => {
  it('opens at once, joins with the stored token, and goes online with the first snapshot', () => {
    const { session, socket, online } = setup({ token: TOKEN });
    expect(session.get().meta.connection).toBe('connecting');
    expect(session.get().room).toBeNull();
    socket().events.open();
    expect(socket().sent[0]).toEqual({
      v: 1,
      t: 'join',
      room: 'ABCDEF',
      game: 'nim',
      name: 'Ana',
      build: '1.0.0',
      token: TOKEN,
    });
    online();
    const s = session.get();
    expect(s.meta).toMatchObject({ connection: 'online', seat: 0, revision: 5, safePoint: false, notice: null });
    expect(s.meta.seats).toEqual([
      { id: 0, name: 'Ana', controller: 'human' },
      { id: 1, name: 'Ben', controller: 'human' },
    ]);
    expect(s.meta.clocks).toEqual([{ seat: 0, remainingMs: 30_000, running: true }]);
    expect(s.view).toEqual({ heap: 10, turn: 0 });
    expect(s.beats).toEqual([]);
    expect(s.room).toMatchObject({
      code: 'ABCDEF',
      phase: 'playing',
      host: 0,
      spectators: 1,
      match: 1,
      connected: [true, true],
    });
  });

  it('keeps a token the server issues', () => {
    const { tokens, socket } = setup();
    socket().events.open();
    expect(socket().sent[0]).not.toHaveProperty('token');
    socket().serve(welcome(1, TOKEN));
    expect(tokens.get('ABCDEF')).toBe(TOKEN);
  });

  it('asks to watch, and refuses moves from a spectator', () => {
    const { session, socket, online } = setup({ watch: true });
    socket().events.open();
    expect(socket().sent[0]).toMatchObject({ watch: true });
    online(null);
    expect(session.get().meta.seat).toBeNull();
    session.dispatch({ kind: 'command', command: { take: 1 } });
    expect(session.get().meta.notice?.code).toBe('spectator');
    expect(socket().sent.filter((m) => m.t === 'act')).toEqual([]);
  });

  it('shows a lobby with no view, as a safe point', () => {
    const { session, online } = setup();
    online(0, { phase: 'lobby', view: null, pending: [] });
    expect(session.get()).toMatchObject({ view: null, meta: { safePoint: true }, room: { phase: 'lobby', match: 0 } });
  });

  it('stops on a room that plays another rules version', () => {
    const { session, socket } = setup();
    socket().events.open();
    socket().serve({ ...welcome(0), game: { ...PIN, rulesVersion: 2 } } as ServerMessage);
    expect(session.get().meta).toMatchObject({ connection: 'closed', notice: { code: 'update' } });
    expect(socket().closed).toBe(1000);
  });

  it('passes the name-replaced notice on', () => {
    const { session, socket, online } = setup();
    online();
    socket().serve({
      v: 1,
      t: 'notice',
      code: 'name-replaced',
      message: 'That name is not allowed, so you are Pixel Fox 42.',
    });
    expect(session.get().meta.notice).toEqual({
      code: 'name-replaced',
      message: 'That name is not allowed, so you are Pixel Fox 42.',
    });
  });
});

describe('playing', () => {
  it('sends a move with a fresh action ID and the revision the player saw', () => {
    const { session, socket, online } = setup();
    online();
    session.dispatch({ kind: 'command', command: { take: 2 } });
    expect(socket().last()).toEqual({ v: 1, t: 'act', id: 'action-1-xyz', rev: 5, command: { take: 2 } });
    session.dispatch({ kind: 'resign' });
    expect(socket().last()).toEqual({ v: 1, t: 'control', id: 'action-2-xyz', rev: 5, control: { kind: 'resign' } });
    session.dispatch({ kind: 'control', control: { kind: 'ready', ready: true } });
    expect(socket().last()).toMatchObject({ t: 'control', control: { kind: 'ready', ready: true } });
  });

  it('checks a move with the game schema before sending it', () => {
    const { session, socket, online } = setup();
    online();
    session.dispatch({ kind: 'command', command: { take: 9 } });
    expect(session.get().meta.notice?.code).toBe('bad-command');
    expect(socket().sent.some((m) => m.t === 'act')).toBe(false);
  });

  it('refuses a move that names another seat, and sends one that names its own (gp-o2c)', () => {
    const { session, socket, online } = setup();
    online();
    session.dispatch({ kind: 'command', seat: 1, command: { take: 2 } });
    expect(session.get().meta.notice?.code).toBe('wrong-seat');
    expect(socket().sent.some((m) => m.t === 'act')).toBe(false);
    session.dispatch({ kind: 'command', seat: 0, command: { take: 2 } });
    expect(socket().last()).toEqual({ v: 1, t: 'act', id: 'action-1-xyz', rev: 5, command: { take: 2 } });
  });

  it('plays an update back once: beats on the update, none on the presence that follows', () => {
    const { session, socket, online, seen } = setup();
    online();
    socket().serve(update());
    expect(session.get()).toMatchObject({ view: { heap: 8, turn: 1 }, pending: [1], meta: { revision: 6 } });
    expect(session.get().beats).toEqual([{ event: { seat: 0, took: 2 }, view: { heap: 8, turn: 1 } }]);
    socket().serve({ v: 1, t: 'presence', presence: { ...presence, connected: [true, false] }, serverTime: 3 });
    expect(session.get().beats).toEqual([]);
    expect(session.get().room?.connected).toEqual([true, false]);
    expect(seen.at(-1)).toBe(session.get());
    expect(Object.isFrozen(session.get())).toBe(true);
  });

  it('asks for a snapshot on a gap or another epoch, and ignores what it already has', () => {
    const { session, socket, online } = setup();
    online();
    socket().serve(update({ revision: 8, from: 7 }));
    expect(socket().last()).toEqual({ v: 1, t: 'resync' });
    expect(session.get().meta.revision).toBe(5);
    socket().serve(update({ epoch: 1 }));
    expect(session.get().meta.revision).toBe(5);
    const sent = socket().sent.length;
    socket().serve(update({ revision: 5, from: 4 }));
    expect(socket().sent.length).toBe(sent);
  });

  it('accepts an older snapshot from a new epoch (a restored backup), and drops one from the same epoch', () => {
    const { session, socket, online } = setup();
    online();
    socket().serve(snapshot({ revision: 3 }));
    expect(session.get().meta.revision).toBe(5);
    socket().serve(snapshot({ epoch: 1, revision: 3, view: { heap: 12, turn: 1 } }));
    expect(session.get()).toMatchObject({ meta: { revision: 3 }, view: { heap: 12, turn: 1 }, room: { epoch: 1 } });
  });

  it('shows a rejection as a notice, and clears it with the next accepted change', () => {
    const { session, socket, online } = setup();
    online();
    session.dispatch({ kind: 'command', command: { take: 1 } });
    socket().serve({
      v: 1,
      t: 'receipt',
      id: 'action-1-xyz',
      result: { status: 'rejected', code: 'game:NotYourTurn', message: "It's not your turn.", revision: 5 },
    });
    expect(session.get().meta.notice).toEqual({ code: 'game:NotYourTurn', message: "It's not your turn." });
    socket().serve(update());
    expect(session.get().meta.notice).toBeNull();
  });

  it('counts a rematch as a new match', () => {
    const { session, socket, online } = setup();
    online();
    socket().serve(
      update({
        phase: 'finished',
        pending: [],
        outcome: {
          result: 'won',
          placements: [
            { seat: 0, place: 1 },
            { seat: 1, place: 2 },
          ],
          summary: 'Ana took the last stone.',
        },
      }),
    );
    expect(session.get()).toMatchObject({
      meta: { safePoint: true, outcome: { summary: 'Ana took the last stone.' } },
      room: { match: 1, phase: 'finished' },
    });
    socket().serve(snapshot({ revision: 7, phase: 'playing' }));
    expect(session.get()).toMatchObject({ meta: { outcome: null }, room: { match: 2 } });
  });

  it('carries the latest offer, with an end offer’s time left, and sends answers as room controls', () => {
    const { session, socket, online } = setup();
    online();
    expect(session.get().room?.offer).toBeNull();
    const offer = {
      id: 6,
      kind: 'end' as const,
      by: 1,
      status: 'open' as const,
      accepted: [1],
      declinedBy: null,
      endsAt: 60_002,
    };
    socket().serve(update({ offer, serverTime: 2_002 }));
    expect(session.get().room?.offer).toEqual({ ...offer, endsInMs: 58_000 });
    session.dispatch({ kind: 'control', control: { kind: 'accept', offer: 6 } });
    expect(socket().last()).toEqual({
      v: 1,
      t: 'control',
      id: 'action-1-xyz',
      rev: 6,
      control: { kind: 'accept', offer: 6 },
    });
    // A server older than offers sends none: the room has none.
    socket().serve(update({ revision: 7, from: 6 }));
    expect(session.get().room?.offer).toBeNull();
  });

  it('keeps the last presentation until a job brings a new one', () => {
    const { session, socket, online } = setup();
    online(0, { presentation: { frames: 1 } });
    socket().serve(update());
    expect(session.get().presentation).toEqual({ frames: 1 });
    socket().serve(update({ revision: 7, from: 6, presentation: { frames: 2 } }));
    expect(session.get().presentation).toEqual({ frames: 2 });
  });
});

describe('reconnecting', () => {
  it('backs off like Greed: min(10 s, 500 ms · 2ⁿ) plus up to 250 ms of jitter', () => {
    expect(reconnectDelay(0, 0)).toBe(500);
    expect(reconnectDelay(3, 0.999)).toBe(4249);
    expect(reconnectDelay(10, 0)).toBe(10_000);
  });

  it('rejoins with the token after a dropped connection, and resends an action that had no receipt', () => {
    const { session, socket, sockets, clock, online, tokens } = setup();
    online();
    tokens.set('ABCDEF', TOKEN);
    session.dispatch({ kind: 'command', command: { take: 2 } });
    socket().events.close(1006);
    expect(session.get().meta.connection).toBe('reconnecting');
    session.dispatch({ kind: 'command', command: { take: 1 } });
    expect(session.get().meta.notice?.code).toBe('offline');
    clock.advance(499);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
    socket().events.open();
    expect(socket().sent[0]).toMatchObject({ t: 'join', token: TOKEN });
    socket().serve(welcome(0));
    socket().serve(snapshot());
    expect(session.get().meta).toMatchObject({ connection: 'online', notice: null });
    expect(socket().last()).toEqual({ v: 1, t: 'act', id: 'action-1-xyz', rev: 5, command: { take: 2 } });
  });

  it('waits longer after each failure, and starts over once online', () => {
    const { socket, sockets, clock, online } = setup();
    socket().events.close(1006);
    clock.advance(500);
    socket().events.close(1006);
    clock.advance(999);
    expect(sockets).toHaveLength(2);
    clock.advance(1);
    expect(sockets).toHaveLength(3);
    online();
    socket().events.close(1013);
    clock.advance(500);
    expect(sockets).toHaveLength(4);
  });

  it('comes back after a restart when the server says to', () => {
    const { socket, sockets, clock, online } = setup();
    online();
    socket().serve({ v: 1, t: 'closing', reason: 'restart', retryAfterMs: 2000 });
    socket().events.close(1012);
    clock.advance(1999);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
  });

  it('stops when a newer tab takes the seat, and takes it back on request', () => {
    const { session, socket, sockets, clock, online } = setup();
    online();
    socket().serve({ v: 1, t: 'replaced' });
    socket().events.close(4001);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(session.get().meta).toMatchObject({ connection: 'closed', notice: { code: 'replaced' } });
    session.dispatch({ kind: 'reconnect' });
    expect(sockets).toHaveLength(2);
    expect(session.get().meta.connection).toBe('connecting');
  });

  it('stops for a closed room and forgets its token', () => {
    const { session, socket, sockets, clock, tokens } = setup({ token: TOKEN });
    socket().events.open();
    socket().serve({ v: 1, t: 'notice', code: 'no-such-room', message: 'This room has closed.' });
    socket().events.close(4004);
    clock.advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(session.get().meta).toMatchObject({ connection: 'closed', notice: { code: 'closed' } });
    expect(tokens.get('ABCDEF')).toBeNull();
  });

  it('stops for an expired room', () => {
    const { session, socket, online } = setup();
    online();
    socket().serve({ v: 1, t: 'closing', reason: 'expired', retryAfterMs: null });
    socket().events.close(1000);
    expect(session.get().meta.connection).toBe('closed');
  });
});

describe('leaving and disposal', () => {
  it('gives the seat up on leave and forgets the token', () => {
    const { session, socket, online, tokens } = setup({ token: TOKEN });
    online();
    session.dispatch({ kind: 'leave' });
    expect(socket().last()).toMatchObject({ t: 'control', control: { kind: 'leave-seat' } });
    expect(tokens.get('ABCDEF')).toBeNull();
    socket().events.close(4002);
    expect(session.get().meta).toMatchObject({ connection: 'closed', notice: { code: 'left' } });
  });

  it('closes the socket once and publishes nothing afterwards', () => {
    const { session, socket, seen, clock, sockets } = setup();
    const before = seen.length;
    session.dispose();
    session.dispose();
    expect(socket().closed).toBe(1000);
    socket().events.close(1006);
    socket().serve(snapshot());
    clock.advance(60_000);
    expect(seen.length).toBe(before);
    expect(sockets).toHaveLength(1);
  });

  it('reports a message it cannot read and carries on', () => {
    const { session, socket, online, report } = setup();
    online();
    socket().events.message('not json');
    socket().events.message(JSON.stringify({ v: 1, t: 'shout' }));
    socket().serve(update({ view: { nonsense: true } }));
    expect(report).toHaveBeenCalledTimes(3);
    expect(session.get().meta.revision).toBe(5);
  });
});

it('reconnects after recovery to an older snapshot under a new epoch and can act again', () => {
  const { session, socket, clock, online } = setup();
  online();
  socket().events.close(1006);
  clock.advance(500);
  socket().events.open();
  socket().serve(welcome(0));
  socket().serve(snapshot({ epoch: 1, revision: 3 }));
  expect(session.get().meta.connection).toBe('online');
  expect(session.get().meta.revision).toBe(3);
  session.dispatch({ kind: 'command', command: { take: 1 } });
  expect(socket().last()).toMatchObject({ t: 'act', rev: 3, command: { take: 1 } });
});
