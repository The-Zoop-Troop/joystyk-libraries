// The remote session client: a Layer 1 `GameSession` whose authority is a server room
// (room-server.md section 5). It speaks `@joystyk/rooms/protocol` over a socket port: every
// message it receives is decoded with the protocol's Zod schemas and the game's own view and
// event schemas, every action carries a fresh action ID and the revision the player saw, and
// a dropped connection rejoins with the seat token after Greed's backoff. Snapshots follow the
// same six publishing rules as the local runner; see README.md.
import type {
  GameSession,
  Json,
  Notice,
  Outcome,
  SeatClock,
  SeatId,
  SeatInfo,
  SessionMeta,
  Validator,
  ViewBeat,
} from '@joystyk/contracts';
import {
  CloseCode,
  PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type GamePin,
  type PublicSeat,
  type RoomControl,
  type RoomOffer,
  type RoomPhase,
  type RoomSettings,
  type ServerMessage,
  type SnapshotMessage,
  type UpdateMessage,
} from '@joystyk/rooms/protocol';
import type { Clock, Reporter } from './ports.ts';
import { createPublisher } from './publisher.ts';
import { decode } from './values.ts';

// --- Ports ---------------------------------------------------------------------------------------

/** One open connection to the room server. */
export interface RemoteSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** What a socket reports. `close` fires once, also when the connection never opened. */
export type SocketEvents = {
  open(): void;
  message(text: string): void;
  close(code: number): void;
};

/** Opens a connection to the room server's `/ws`. The browser adapter wraps `WebSocket`. */
export type SocketFactory = (events: SocketEvents) => RemoteSocket;

/** Where seat tokens live, one per room code. The browser adapter uses local storage, so every tab shares them. */
export interface TokenStore {
  get(room: string): string | null;
  set(room: string, token: string): void;
  delete(room: string): void;
}

/** Tokens kept in memory only: for tests, and for a page whose storage is blocked. */
export const memoryTokens = (): TokenStore => {
  const tokens = new Map<string, string>();
  return {
    get: (room) => tokens.get(room) ?? null,
    set: (room, token) => void tokens.set(room, token),
    delete: (room) => void tokens.delete(room),
  };
};

// --- Inputs and snapshots ------------------------------------------------------------------------

/**
 * What the game's UI and the launcher dispatch. Commands always come from the viewer's seat.
 * `resign` is the platform's resign control. `control` carries a room control (ready,
 * settings, start, offers …) from the launcher's lobby and results. `reconnect` takes the seat back
 * after another tab replaced this one; `leave` gives the seat up and closes the session.
 * Local-only inputs (`pause`, `resume`, `reveal`, `undo`) are ignored: a room never pauses.
 */
export type RemoteInput<Command> =
  /** A command for this connection's seat. A named seat must be that seat: a room never acts for another (gp-o2c). */
  | { readonly kind: 'command'; readonly command: Command; readonly seat?: SeatId }
  | { readonly kind: 'resign' }
  | { readonly kind: 'control'; readonly control: RoomControl }
  | { readonly kind: 'reconnect' }
  | { readonly kind: 'leave' }
  | { readonly kind: 'resync' };

/** A rematch or end-match offer, with an end offer's time left measured at `clocksReadAt`. */
export type RemoteOffer = RoomOffer & {
  /** An end offer: milliseconds until the match ends if nobody declines. Null for a rematch. */
  readonly endsInMs: number | null;
};

/** The room around the match: what the launcher's lobby and frame draw. */
export type RemoteRoom = {
  readonly code: string;
  readonly epoch: number;
  readonly phase: RoomPhase;
  readonly host: SeatId | null;
  readonly seats: readonly PublicSeat[];
  readonly settings: RoomSettings;
  readonly game: GamePin;
  /** Indexed by seat: whether a player is connected to it. */
  readonly connected: readonly boolean[];
  readonly spectators: number;
  /** No player is connected, so the table is paused and its clocks hold their time (D-58). */
  readonly paused: boolean;
  /** Counts matches in this room; it rises at every start and rematch. */
  readonly match: number;
  /** When the clocks in `meta.clocks` (and the offer's time left) were read, on this session's clock. */
  readonly clocksReadAt: number;
  /** The latest rematch or end-match offer (D-61). */
  readonly offer: RemoteOffer | null;
};

/** The remote client's snapshot: the contract's `EngineSnapshot`, plus the room. `view` is null in a lobby. */
export type RemoteSnapshot<View, Event> = {
  readonly meta: SessionMeta;
  readonly view: View | null;
  readonly beats: readonly ViewBeat<View, Event>[];
  readonly pending: readonly SeatId[];
  readonly presentation: Json | null;
  /** Null until the first snapshot arrives. */
  readonly room: RemoteRoom | null;
};

export interface RemoteSession<Command, View, Event> extends GameSession<
  RemoteSnapshot<View, Event>,
  RemoteInput<Command>
> {
  /** The room code this session plays in. */
  readonly code: string;
}

/** The engine parts the client needs: its schemas, to decode what the server sends. */
export type RemoteGame<Command, View, Event> = {
  readonly id: string;
  /** The build this page carries, sent with `join`. */
  readonly build: string;
  readonly rulesVersion: number;
  readonly schemas: {
    readonly command: Validator<Command>;
    readonly view: Validator<View>;
    readonly event: Validator<Event>;
  };
};

export type RemoteSessionOptions<Command, View, Event> = {
  readonly game: RemoteGame<Command, View, Event>;
  /** The six-character room code. */
  readonly room: string;
  /** The display name to claim a seat with (the server filters it again). */
  readonly name: string;
  /** Ask to watch even if a seat is free (D-33). */
  readonly watch?: boolean;
  readonly connect: SocketFactory;
  readonly tokens: TokenStore;
  readonly clock: Clock;
  /** A fresh action ID: 8–40 URL-safe characters, unique for the seat across reloads. */
  readonly actionId: () => string;
  /** A number in [0, 1) for the reconnect jitter. Default: always 0.5. */
  readonly random?: () => number;
  /** Deep-freeze snapshots. Default true. */
  readonly freeze?: boolean;
  readonly report?: Reporter;
};

// --- Words for players -----------------------------------------------------------------------------

const NOTICES = {
  offline: 'Waiting for the connection to come back.',
  spectator: 'You are watching this game.',
  replaced: 'This seat is now open in another tab.',
  left: 'You left the room.',
  closed: 'This room has closed.',
  update: 'This room plays a newer version of the game. Reload the page to keep playing.',
  invalid: 'That move is not valid.',
  wrongSeat: 'You can only move for your own seat.',
} as const;

const notice = (code: string, message: string): Notice => ({ code, message });

/** Greed's backoff: min(10 s, 500 ms · 2ⁿ) plus up to 250 ms of jitter. */
export const reconnectDelay = (attempt: number, random: number): number =>
  Math.min(10_000, 500 * 2 ** attempt) + Math.floor(random * 250);

/** A policy close (4008) waits at least this long. */
const POLICY_DELAY_MS = 15_000;

const seatInfo = (seat: PublicSeat): SeatInfo =>
  seat.controller === 'ai' && seat.aiLevel !== null
    ? { id: seat.id, name: seat.name, controller: 'ai', aiLevel: seat.aiLevel }
    : { id: seat.id, name: seat.name, controller: seat.controller };

type Status = SessionMeta['connection'];

/**
 * Opens a session in a server room. The socket opens at once; the first snapshot arrives
 * after the server's `welcome`. Nothing throws: problems become `meta.notice` and
 * `meta.connection`.
 */
export const createRemoteSession = <Command, View, Event>(
  options: RemoteSessionOptions<Command, View, Event>,
): RemoteSession<Command, View, Event> => {
  const { game, room: code, clock, tokens } = options;
  const report: Reporter = options.report ?? (() => {});
  const random = options.random ?? (() => 0.5);

  let status: Status = 'connecting';
  let socket: RemoteSocket | null = null;
  let generation = 0;
  let attempt = 0;
  let timer: (() => void) | null = null;
  let retryAfter: number | null | undefined;
  let disposed = false;
  /** Set once a `welcome` arrived on the current socket. */
  let joined = false;

  let seat: SeatId | null = null;
  let revision = 0;
  let epoch = -1;
  let phase: RoomPhase = 'lobby';
  let host: SeatId | null = null;
  let seats: readonly PublicSeat[] = [];
  let settings: RoomSettings = { decisionMs: null, bank: null, aiLevel: null };
  let pin: GamePin | null = null;
  let view: View | null = null;
  let pending: readonly SeatId[] = [];
  let outcome: Outcome | null = null;
  let presentation: Json | null = null;
  let connected: readonly boolean[] = [];
  let clocks: readonly SeatClock[] = [];
  let clocksReadAt = clock.now();
  let spectators = 0;
  let paused = false;
  let offer: RoomOffer | null = null;
  /** The server's time when the clocks were read. */
  let serverTime = 0;
  let match = 0;
  let hasRoom = false;
  let currentNotice: Notice | null = null;
  /** Actions sent without a receipt yet: resent with the same ID after a reconnect. */
  const inflight = new Map<string, ClientMessage>();

  const build = (beats: readonly ViewBeat<View, Event>[]): RemoteSnapshot<View, Event> => ({
    meta: {
      connection: status,
      seat,
      revision,
      seats: seats.map(seatInfo),
      outcome,
      safePoint: phase !== 'playing',
      notice: currentNotice,
      clocks,
    },
    view,
    beats,
    pending,
    presentation,
    room:
      hasRoom && pin !== null
        ? {
            code,
            epoch,
            phase,
            host,
            seats,
            settings,
            game: pin,
            connected,
            spectators,
            paused,
            match,
            clocksReadAt,
            offer: remoteOffer(),
          }
        : null,
  });

  function remoteOffer(): RemoteOffer | null {
    if (offer === null) return null;
    return { ...offer, endsInMs: offer.endsAt === null ? null : Math.max(0, offer.endsAt - serverTime) };
  }

  const publisher = createPublisher<RemoteSnapshot<View, Event>>(build([]), { freeze: options.freeze ?? true, report });
  const publish = (beats: readonly ViewBeat<View, Event>[] = []): void => publisher.publish(build(beats));

  // --- The connection ---------------------------------------------------------------------------

  const send = (message: ClientMessage): boolean => {
    if (socket === null) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      report(error, 'Sending to the room failed.');
      return false;
    }
  };

  const cancelTimer = (): void => {
    timer?.();
    timer = null;
  };

  /** Stops for good: no more reconnects. */
  const stop = (why: Notice | null): void => {
    cancelTimer();
    status = 'closed';
    if (why !== null) currentNotice = why;
    const open = socket;
    socket = null;
    generation += 1;
    open?.close(CloseCode.normal, 'done');
  };

  const open = (): void => {
    cancelTimer();
    generation += 1;
    const mine = generation;
    joined = false;
    retryAfter = undefined;
    const events: SocketEvents = {
      open: () => {
        if (mine !== generation) return;
        const token = tokens.get(code);
        send({
          v: PROTOCOL_VERSION,
          t: 'join',
          room: code,
          game: game.id,
          name: options.name,
          build: game.build,
          ...(token === null ? {} : { token }),
          ...(options.watch === true ? { watch: true } : {}),
        });
      },
      message: (text) => {
        if (mine === generation) receive(text);
      },
      close: (closeCode) => {
        if (mine === generation) closed(closeCode);
      },
    };
    try {
      socket = options.connect(events);
    } catch (error) {
      report(error, 'Opening the room connection failed.');
      socket = null;
      closed(1006);
    }
  };

  const schedule = (delay: number): void => {
    cancelTimer();
    timer = clock.after(delay, () => {
      timer = null;
      if (!disposed && status !== 'closed') open();
    });
  };

  const closed = (closeCode: number): void => {
    socket = null;
    generation += 1;
    if (disposed || status === 'closed') return;
    switch (closeCode) {
      case CloseCode.replaced:
        stop(notice('replaced', NOTICES.replaced));
        return publish();
      case CloseCode.leftRoom:
        stop(notice('left', NOTICES.left));
        return publish();
      case CloseCode.noSuchRoom:
        tokens.delete(code);
        stop(notice('closed', NOTICES.closed));
        return publish();
      default:
        break;
    }
    if (retryAfter === null) {
      stop(notice('closed', NOTICES.closed));
      return publish();
    }
    const delay =
      closeCode === CloseCode.restarting && retryAfter !== undefined
        ? retryAfter
        : closeCode === CloseCode.policy
          ? Math.max(POLICY_DELAY_MS, reconnectDelay(attempt, random()))
          : reconnectDelay(attempt, random());
    attempt += 1;
    status = 'reconnecting';
    publish();
    schedule(delay);
  };

  // --- What the server sends ----------------------------------------------------------------------

  const decodeView = (
    raw: Json | null,
  ): { readonly ok: true; readonly value: View | null } | { readonly ok: false } => {
    if (raw === null) return { ok: true, value: null };
    const decoded = decode(game.schemas.view, raw, 'view');
    if (!decoded.ok) {
      report(decoded.error, 'The room sent a view this game cannot read.');
      return { ok: false };
    }
    return { ok: true, value: decoded.value };
  };

  const decodeBeats = (beats: UpdateMessage['beats']): ViewBeat<View, Event>[] =>
    beats.flatMap((beat) => {
      const event = decode(game.schemas.event, beat.event, 'event');
      if (!event.ok) {
        report(event.error, 'The room sent an event this game cannot read.');
        return [];
      }
      if (beat.view === undefined) return [{ event: event.value }];
      const after = decodeView(beat.view);
      return after.ok && after.value !== null ? [{ event: event.value, view: after.value }] : [{ event: event.value }];
    });

  /** A room on a different rules version can't be played with this page's engine. */
  const versionProblem = (other: GamePin): boolean => other.id !== game.id || other.rulesVersion !== game.rulesVersion;

  const takePresence = (message: Pick<SnapshotMessage, 'presence' | 'serverTime'>): void => {
    serverTime = message.serverTime;
    connected = message.presence.connected;
    clocks = message.presence.clocks;
    clocksReadAt = clock.now();
    spectators = message.presence.spectators;
    paused = message.presence.paused;
  };

  const onSnapshot = (message: SnapshotMessage): void => {
    // An older snapshot of the same epoch is a straggler; a new epoch (a restored backup) always wins.
    if (hasRoom && message.epoch === epoch && message.revision < revision) return;
    if (versionProblem(message.game)) {
      stop(notice('update', NOTICES.update));
      return publish();
    }
    const decoded = decodeView(message.view);
    if (!decoded.ok) return;
    // A match began since this client last looked: a start, a rematch, or a first look mid-game.
    const newMatch = message.phase === 'playing' && (phase !== 'playing' || !hasRoom);
    epoch = message.epoch;
    revision = message.revision;
    phase = message.phase;
    seat = message.seat;
    seats = message.seats;
    host = message.host;
    pin = message.game;
    settings = message.settings;
    view = decoded.value;
    pending = message.pending;
    outcome = message.outcome;
    presentation = message.presentation;
    offer = message.offer ?? null;
    if (newMatch) match += 1;
    takePresence(message);
    hasRoom = true;
    if (status !== 'online') {
      status = 'online';
      attempt = 0;
      if (currentNotice?.code === 'offline') currentNotice = null;
      // Actions whose receipt was lost go again with the same ID; the receipt answers them.
      for (const queued of inflight.values()) send(queued);
    }
    publish();
  };

  const onUpdate = (message: UpdateMessage): void => {
    if (!hasRoom || message.epoch !== epoch) {
      send({ v: PROTOCOL_VERSION, t: 'resync' });
      return;
    }
    if (message.revision <= revision) return;
    if (message.from !== revision) {
      // A gap can only come from a bug; a fresh snapshot repairs it.
      send({ v: PROTOCOL_VERSION, t: 'resync' });
      return;
    }
    const decoded = decodeView(message.view);
    if (!decoded.ok) return;
    const startedMatch = message.phase === 'playing' && phase !== 'playing';
    revision = message.revision;
    phase = message.phase;
    host = message.host;
    if (message.seats !== undefined) seats = message.seats;
    if (message.settings !== undefined) settings = message.settings;
    view = decoded.value;
    pending = message.pending;
    outcome = message.outcome;
    if (message.presentation !== undefined) presentation = message.presentation;
    offer = message.offer ?? null;
    if (startedMatch) match += 1;
    takePresence(message);
    currentNotice = null;
    publish(decodeBeats(message.beats));
  };

  const receive = (text: string): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return report(error, 'The room sent a message that is not JSON.');
    }
    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) return report(parsed.error, 'The room sent a message this client cannot read.');
    const message = parsed.data as ServerMessage;
    switch (message.t) {
      case 'welcome':
        joined = true;
        if (message.token !== undefined) tokens.set(code, message.token);
        seat = message.seat;
        host = message.host;
        if (versionProblem(message.game)) {
          stop(notice('update', NOTICES.update));
          publish();
        }
        return;
      case 'snapshot':
        return onSnapshot(message);
      case 'update':
        return onUpdate(message);
      case 'receipt': {
        inflight.delete(message.id);
        if (message.result.status === 'rejected') {
          currentNotice = notice(message.result.code, message.result.message);
          publish();
        }
        return;
      }
      case 'presence':
        takePresence(message);
        return publish();
      case 'notice':
        currentNotice = notice(message.code, message.message);
        return publish();
      case 'replaced':
        stop(notice('replaced', NOTICES.replaced));
        return publish();
      case 'closing':
        retryAfter = message.retryAfterMs;
        return;
    }
  };

  // --- What the player does -----------------------------------------------------------------------

  /** Sends an action with a fresh ID and the revision the player saw, or says why it can't. */
  const act = (message: (id: string) => ClientMessage, needsSeat: boolean): void => {
    if (status !== 'online' || !joined) {
      currentNotice = notice('offline', NOTICES.offline);
      return publish();
    }
    if (needsSeat && seat === null) {
      currentNotice = notice('spectator', NOTICES.spectator);
      return publish();
    }
    const outgoing = message(options.actionId());
    if ('id' in outgoing) inflight.set(outgoing.id, outgoing);
    send(outgoing);
  };

  const dispatch = (input: RemoteInput<Command>): void => {
    if (disposed) return;
    switch (input.kind) {
      case 'command': {
        if (input.seat !== undefined && seat !== null && input.seat !== seat) {
          currentNotice = notice('wrong-seat', NOTICES.wrongSeat);
          return publish();
        }
        const checked = decode(game.schemas.command, input.command, 'move');
        if (!checked.ok) {
          currentNotice = notice('bad-command', NOTICES.invalid);
          return publish();
        }
        return act(
          (id) => ({ v: PROTOCOL_VERSION, t: 'act', id, rev: revision, command: checked.value as Json }),
          true,
        );
      }
      case 'resign':
        return act(
          (id) => ({ v: PROTOCOL_VERSION, t: 'control', id, rev: revision, control: { kind: 'resign' } }),
          true,
        );
      case 'control':
        return act((id) => ({ v: PROTOCOL_VERSION, t: 'control', id, rev: revision, control: input.control }), true);
      case 'resync':
        if (status === 'online') send({ v: PROTOCOL_VERSION, t: 'resync' });
        return;
      case 'reconnect':
        if (status !== 'closed' || currentNotice?.code !== 'replaced') return;
        status = 'connecting';
        attempt = 0;
        currentNotice = null;
        publish();
        return open();
      case 'leave':
        tokens.delete(code);
        if (status === 'online' && seat !== null) {
          // The server answers with a 4002 close, which ends the session.
          send({
            v: PROTOCOL_VERSION,
            t: 'control',
            id: options.actionId(),
            rev: revision,
            control: { kind: 'leave-seat' },
          });
          return;
        }
        stop(notice('left', NOTICES.left));
        return publish();
      default:
        // Local-only inputs (pause, resume, reveal, undo) mean nothing in a room.
        return;
    }
  };

  open();

  return {
    code,
    get: publisher.get,
    subscribe: publisher.subscribe,
    dispatch: dispatch as (input: RemoteInput<Command>) => void,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelTimer();
      const last = socket;
      socket = null;
      generation += 1;
      last?.close(CloseCode.normal, 'disposed');
      publisher.close();
    },
  };
};
