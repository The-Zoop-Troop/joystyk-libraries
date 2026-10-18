import type { ViewBeat } from './engine.ts';
import type { Json } from './json.ts';
import type { AssistCounts, Outcome } from './outcome.ts';
import type { SeatId, SeatInfo } from './seats.ts';

/** The session's link to its authority. Local sessions stay 'local'. */
export type ConnectionState = 'local' | 'connecting' | 'online' | 'reconnecting' | 'closed';

/** A rejection or connection problem, worded for players. */
export type Notice = {
  readonly code: string;
  readonly message: string;
};

/**
 * One seat's decision clock as a room reports it. `remainingMs` is measured when the
 * snapshot was made; the UI counts down from there while `running`. With a time bank,
 * every seat has an entry and only pending seats run; with a per-move clock, only seats
 * whose clock is running appear.
 */
export type SeatClock = {
  readonly seat: SeatId;
  readonly remainingMs: number;
  readonly running: boolean;
  /** True while the room is paused because no player is connected (D-58): the clock holds its time. */
  readonly paused?: boolean;
};

/** The platform's part of every snapshot. */
export type SessionMeta = {
  readonly connection: ConnectionState;
  /** The viewer's seat; null for a spectator. */
  readonly seat: SeatId | null;
  /** Increments with every accepted change. */
  readonly revision: number;
  readonly seats: readonly SeatInfo[];
  readonly outcome: Outcome | null;
  /** True when the platform may offer an update or leave without losing anything. */
  readonly safePoint: boolean;
  /** The most recent rejection or connection problem. */
  readonly notice: Notice | null;
  /** Decision clocks, from rooms that run one. Local play never runs a clock (D-34). */
  readonly clocks?: readonly SeatClock[];
  /** Local play's lifetime assistance counts; rooms may omit it. */
  readonly assistCounts?: AssistCounts;
};

/** The least every snapshot carries. The rest belongs to the game or its runner. */
export type SessionSnapshot = { readonly meta: SessionMeta };

/**
 * Layer 1: how the launcher talks to every game. Implementations must behave like this:
 *
 * 1. `get()` returns the latest published snapshot.
 * 2. `subscribe()` calls the listener immediately with the current snapshot, then with each
 *    later one. The returned function removes the listener and is safe to call twice.
 * 3. `dispatch()` queues an input on the session's ordered path. It doesn't promise that the
 *    input is accepted, or accepted synchronously; the answer arrives as a new snapshot,
 *    possibly with a `notice`.
 * 4. A snapshot is published atomically: no listener sees new state with old beats, an old
 *    revision or old metadata.
 * 5. Snapshots are read-only. Development builds deep-freeze them.
 * 6. `dispose()` is idempotent and releases sockets, workers, timers and listeners. Nothing
 *    publishes after it.
 */
export interface GameSession<Snapshot extends SessionSnapshot, Input> {
  get(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  dispatch(input: Input): void;
  dispose(): void;
}

/**
 * Any session, as the launcher holds it. Every concrete session is assignable to it; it
 * accepts no input, because the launcher never dispatches on a game's behalf.
 */
export type AnyGameSession = GameSession<SessionSnapshot, never>;

/** The snapshot produced by the platform's Layer 2 runners (local, P2P, remote). */
export type EngineSnapshot<View, Event> = {
  readonly meta: SessionMeta;
  readonly view: View;
  /** Beats since the previous snapshot, already redacted for this viewer, for playback. */
  readonly beats: readonly ViewBeat<View, Event>[];
  /** Seats whose decision is awaited right now. */
  readonly pending: readonly SeatId[];
  /** Presentation data from completed jobs (e.g. Greed's recorded dice motion). */
  readonly presentation: Json | null;
};

/** The snapshot produced by the platform's Layer 3 scheduler. */
export type SimulationSnapshot<View> = {
  readonly meta: SessionMeta;
  readonly view: View;
  readonly tick: number;
  readonly paused: boolean;
};
