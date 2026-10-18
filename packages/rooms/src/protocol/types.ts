// The wire protocol as TypeScript types. The schemas in schemas.ts decode into these; the
// room core builds messages of these shapes. Every message carries the protocol version `v`
// and a type `t` (room-server.md section 5).
import type { Json, Outcome, SeatClock, SeatId, ViewBeat } from '@joystyk/contracts';
import type { ActionId, RoomCode } from './schemas.ts';

/** The game build and versions a match runs on; fixed for the match (section 6.1). */
export type GamePin = {
  /** Manifest id, e.g. "hearts". */
  readonly id: string;
  /** Build of the game package, e.g. "1.4.0". Clients load this build. */
  readonly build: string;
  readonly rulesVersion: number;
  readonly saveVersion: number;
};

export type RoomPhase = 'lobby' | 'playing' | 'finished' | 'closed';

/** A seat as every viewer sees it. No token or token hash ever leaves the server. */
export type PublicSeat = {
  readonly id: SeatId;
  readonly name: string;
  readonly controller: 'human' | 'ai';
  readonly aiLevel: string | null;
  /** True when a player holds the seat's token (also while the AI covers for them). */
  readonly claimed: boolean;
  readonly ready: boolean;
};

/** A time bank with increment (the manifest's `clock.mode: 'bank'`). */
export type BankSetting = { readonly initialMs: number; readonly incrementMs: number };

/** Live facts that never change the revision: connections and running clocks. */
export type Presence = {
  /** Indexed by seat: whether a player is connected to it. */
  readonly connected: readonly boolean[];
  /**
   * Decision clocks as the contract's `SeatClock`: per-move clocks for pending seats, or
   * every seat's bank. A clock that isn't `running` (paused room, playback hold, a seat
   * that isn't pending) doesn't count down.
   */
  readonly clocks: readonly SeatClock[];
  /**
   * True when no player is connected, so the table is paused (section 3.5 rule 8, D-58):
   * its clocks keep the time they had and say so with `paused`.
   */
  readonly paused: boolean;
  readonly spectators: number;
};

/** What an offer proposes: a new match after this one, or ending this one early with no result (D-61). */
export type OfferKind = 'rematch' | 'end';

/**
 * A rematch or end-match offer as every viewer sees it (section 3.10). Any seated player may
 * make one. A declined or withdrawn offer stays until the next one, so the table can say so.
 */
export type RoomOffer = {
  /** Names the offer in answers: the revision that opened it. */
  readonly id: number;
  readonly kind: OfferKind;
  /** The seat that offered. */
  readonly by: SeatId;
  readonly status: 'open' | 'declined' | 'withdrawn';
  /** Seats that have accepted: the proposer, each player who said yes and, for a rematch, every computer seat. */
  readonly accepted: readonly SeatId[];
  /** The seat that declined, if one did. */
  readonly declinedBy: SeatId | null;
  /** An end offer: when the match ends if nobody declines, in server time. Null for a rematch. */
  readonly endsAt: number | null;
};

/** Room settings the host may change in the lobby. */
export type RoomSettings = {
  /** Per-move clock; null when off or when a bank runs. */
  readonly decisionMs: number | null;
  readonly bank: BankSetting | null;
  readonly aiLevel: string | null;
};

/** A room control: lobby and match actions that belong to the room, not the game. */
export type RoomControl =
  | { readonly kind: 'ready'; readonly ready: boolean }
  | {
      readonly kind: 'settings';
      /** A per-move clock (turns the bank off), or null for none. */
      readonly decisionMs?: number | null;
      /** A time bank (turns the per-move clock off), or null for none. */
      readonly bank?: BankSetting | null;
      readonly config?: Json;
      readonly aiLevel?: string;
    }
  | { readonly kind: 'fill-with-ai'; readonly seat: SeatId }
  | { readonly kind: 'remove-seat'; readonly seat: SeatId }
  | { readonly kind: 'start' }
  /** Offer a rematch (after the match) or to end the match early (during it); D-61. */
  | { readonly kind: 'offer'; readonly offer: OfferKind }
  /** Answer the open offer, named by its id: the other players accept or decline, the proposer withdraws. */
  | { readonly kind: 'accept' | 'decline' | 'withdraw'; readonly offer: number }
  | { readonly kind: 'leave-seat' }
  /** The contract's `resign` input, offered by the platform at any time during a match. */
  | { readonly kind: 'resign' };

// ── Client → server ─────────────────────────────────────────────────────────────────────

export type JoinMessage = {
  readonly v: number;
  readonly t: 'join';
  readonly room: RoomCode;
  readonly game: string;
  readonly name: string;
  readonly token?: string;
  readonly watch?: boolean;
  readonly build: string;
};

export type ActMessage = {
  readonly v: number;
  readonly t: 'act';
  readonly id: ActionId;
  /** The revision the client last saw; staleness is judged per seat (section 3.8). */
  readonly rev: number;
  readonly command: Json;
};

export type ControlMessage = {
  readonly v: number;
  readonly t: 'control';
  readonly id: ActionId;
  readonly rev: number;
  readonly control: RoomControl;
};

export type ResyncMessage = { readonly v: number; readonly t: 'resync' };

export type ClientMessage = JoinMessage | ActMessage | ControlMessage | ResyncMessage;

// ── Server → client ─────────────────────────────────────────────────────────────────────

export type WelcomeMessage = {
  readonly v: number;
  readonly t: 'welcome';
  readonly room: RoomCode;
  /** Null for a spectator. */
  readonly seat: SeatId | null;
  /** Present only when the server issued a new seat token to this connection. */
  readonly token?: string;
  readonly host: SeatId | null;
  readonly game: GamePin;
  readonly protocol: number;
};

export type SnapshotMessage = {
  readonly v: number;
  readonly t: 'snapshot';
  readonly epoch: number;
  readonly revision: number;
  readonly phase: RoomPhase;
  /** The viewer's own seat (null for a spectator). It can change when a match starts. */
  readonly seat: SeatId | null;
  readonly seats: readonly PublicSeat[];
  readonly host: SeatId | null;
  readonly game: GamePin;
  readonly settings: RoomSettings;
  /** `viewFor(state, seat)`; null in a lobby before the first match. */
  readonly view: Json | null;
  /** The match's recent events, each through `eventFor(event, seat)`. */
  readonly history: readonly Json[];
  readonly pending: readonly SeatId[];
  readonly outcome: Outcome | null;
  readonly presentation: Json | null;
  /** The latest rematch or end-match offer; absent from servers older than D-61. */
  readonly offer?: RoomOffer | null;
  readonly presence: Presence;
  readonly serverTime: number;
};

export type UpdateMessage = {
  readonly v: number;
  readonly t: 'update';
  readonly epoch: number;
  readonly revision: number;
  /** The revision this update follows. A client whose revision differs sends `resync`. */
  readonly from: number;
  readonly phase: RoomPhase;
  readonly host: SeatId | null;
  /** Present when a seat changed. */
  readonly seats?: readonly PublicSeat[];
  /** Present when the settings changed. */
  readonly settings?: RoomSettings;
  readonly beats: readonly ViewBeat<Json, Json>[];
  readonly view: Json | null;
  readonly pending: readonly SeatId[];
  readonly outcome: Outcome | null;
  /** Present when a job delivered new presentation data. */
  readonly presentation?: Json | null;
  /** The latest rematch or end-match offer; absent from servers older than D-61. */
  readonly offer?: RoomOffer | null;
  readonly presence: Presence;
  readonly serverTime: number;
};

export type ReceiptResult =
  | { readonly status: 'accepted'; readonly revision: number }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string; readonly revision: number };

export type ReceiptMessage = {
  readonly v: number;
  readonly t: 'receipt';
  readonly id: ActionId;
  readonly result: ReceiptResult;
};

export type PresenceMessage = {
  readonly v: number;
  readonly t: 'presence';
  readonly presence: Presence;
  readonly serverTime: number;
};

/** `name-replaced`: the display name was refused, so the seat got a generated one; the message says why. */
export type NoticeCode =
  'bad-message' | 'too-fast' | 'no-such-room' | 'room-full' | 'protocol-unsupported' | 'server-busy' | 'name-replaced';

export type NoticeMessage = {
  readonly v: number;
  readonly t: 'notice';
  readonly code: NoticeCode;
  readonly message: string;
};

export type ReplacedMessage = { readonly v: number; readonly t: 'replaced' };

export type ClosingMessage = {
  readonly v: number;
  readonly t: 'closing';
  readonly reason: 'restart' | 'expired' | 'closed';
  readonly retryAfterMs: number | null;
};

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | UpdateMessage
  | ReceiptMessage
  | PresenceMessage
  | NoticeMessage
  | ReplacedMessage
  | ClosingMessage;

// ── HTTP ────────────────────────────────────────────────────────────────────────────────

export type CreateRoomRequest = {
  readonly game: string;
  readonly name: string;
  readonly config?: Json;
  readonly settings?: { readonly decisionMs?: number | null; readonly bank?: BankSetting | null };
};

export type CreateRoomResponse = {
  readonly room: RoomCode;
  /** The creator's seat token for seat 0. Store it before opening the socket. */
  readonly token: string;
  /** The name seat 0 holds: the one asked for, normalized, or a generated one. */
  readonly name: string;
  /** Present when the name asked for was refused: `code` is `name-replaced`, `message` says why. */
  readonly notice?: { readonly code: NoticeCode; readonly message: string };
  readonly game: GamePin;
  readonly expiresAt: number;
};

export type RoomInfo = {
  readonly game: GamePin;
  readonly phase: RoomPhase;
  readonly seatsOpen: number;
  readonly spectatorsAllowed: boolean;
};

/**
 * `GET /api/rooms/games`: what this room server hosts, so a launcher offers "Online with
 * friends" only for games it can open (section 5.4).
 */
export type HostedGames = {
  /** The server's current wire protocol version. */
  readonly protocol: number;
  /** Every protocol version it accepts. */
  readonly protocols: readonly number[];
  /** Ids of the games it opens new rooms for. */
  readonly games: readonly string[];
};
