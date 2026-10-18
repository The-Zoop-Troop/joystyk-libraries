// The room core's types (room-server.md sections 3.2 to 3.4). A room is a pure value; every
// change goes through `step(room, command, now)`, which returns the next room and a list of
// effects for the adapter to carry out.
import type {
  AnyDiscreteEngine,
  EngineInput,
  Json,
  JobOutcome,
  JobRequest,
  Outcome,
  Result,
  Rng,
  RngState,
  SeatId,
  SeatInfo,
} from '@joystyk/contracts';
import type {
  ActionId,
  BankSetting,
  GamePin,
  OfferKind,
  RoomCode,
  RoomControl,
  RoomPhase,
  ServerMessage,
  WelcomeMessage,
} from './protocol/index.ts';

export type {
  ActionId,
  BankSetting,
  GamePin,
  OfferKind,
  RoomCode,
  RoomControl,
  RoomOffer,
  RoomPhase,
} from './protocol/index.ts';

/** Assigned by the adapter to each socket; never persisted. */
export type ConnId = string;

/** Per-game defaults come from the manifest; the creator may change some within bounds. */
export type RoomPolicy = {
  readonly seats: { readonly min: number; readonly max: number };
  /** 'host': a lobby, then the host starts. 'immediate': the match starts at creation with AI in every other seat. */
  readonly start: 'host' | 'immediate';
  /** Someone arriving mid-match watches, or takes over an unclaimed AI seat. */
  readonly lateJoin: 'spectate' | 'take-ai-seat';
  /** After the grace period, an absent player's seat goes to the AI, has its turns expired, or waits. */
  readonly absent: 'ai' | 'timeout' | 'wait';
  readonly graceMs: number;
  /** Per-move clock; null = off, or a bank runs instead. */
  readonly decisionMs: number | null;
  /** A time bank with increment (the manifest's `clock.mode: 'bank'`); when set, decisionMs is null. */
  readonly bank?: BankSetting | null;
  /** 0 disables watching. */
  readonly maxSpectators: number;
  /** Delete after this long without a change. */
  readonly retainMs: number;
};

export type SeatClaim = { readonly tokenHash: string; readonly name: string };

export type SeatRecord = {
  readonly id: SeatId;
  /** Who holds the seat. Null: open, or played by the AI with nobody to give it back to. */
  readonly claim: SeatClaim | null;
  readonly controller: 'human' | 'ai';
  readonly aiLevel: string | null;
  readonly ready: boolean;
};

export type DecisionClock = {
  readonly seat: SeatId;
  /** Epoch ms. */
  readonly at: number;
  /** The clock belongs to this decision: it survives changes that leave the seat's decision alone. */
  readonly decisionRevision: number;
  /** Bank mode: when the bank starts running (after the playback hold). */
  readonly startsAt?: number;
  /** Bank mode: false when the engine's `decisionMs` replaced the bank for this decision. */
  readonly onBank?: boolean;
};

export type PendingJob = {
  /** Id, kind and payload, from the contract. */
  readonly request: JobRequest;
  /** The revision that requested it. */
  readonly revision: number;
};

export type MatchRecord = {
  /** 1, then +1 per rematch. */
  readonly number: number;
  /** Pinned for this match. */
  readonly game: GamePin;
  readonly config: Json;
  /** The seats `init` received: with `seed`, `config` and the input log, the replay. */
  readonly seats: readonly SeatInfo[];
  /** The engine rng at init: the replay seed. */
  readonly seed: RngState;
  /** Engine state. */
  readonly state: Json;
  /** Never sent to a client. */
  readonly rng: RngState;
  /**
   * The AI's stream, kept apart so AI choices never shift the engine's draws. Each decision
   * forks a child from it; it moves on only when an AI move is accepted (rule 7).
   */
  readonly aiRng: RngState;
  /** Per seat: the last revision that changed its `decisionKey`. */
  readonly decisionRevision: readonly number[];
  /** Durable: they survive a restart. */
  readonly clocks: readonly DecisionClock[];
  /** Bank mode: each seat's remaining bank in milliseconds. */
  readonly banks?: readonly number[];
  readonly jobs: readonly PendingJob[];
  /** Latest job presentation, for clients that reconnect. */
  readonly presentation: Json | null;
  /** Recent engine events, unredacted; redacted per viewer when sent. */
  readonly log: readonly Json[];
  readonly outcome: Outcome | null;
  readonly startedAt: number;
  /**
   * Set while the table is paused (no player connected, D-58): when the pause began. Clocks
   * keep their deadlines meanwhile; when a player returns, every deadline moves on by the
   * pause, so no clock or bank is charged for it. Durable, so a pause survives a restart.
   */
  readonly pausedAt?: number;
};

/** A rematch or end-match offer (section 3.10, D-61). */
export type OfferRecord = {
  /** The revision that opened it; answers name it. */
  readonly id: number;
  readonly kind: OfferKind;
  readonly by: SeatId;
  readonly status: 'open' | 'declined' | 'withdrawn';
  /** Human seats that accepted, the proposer first. Computer seats accept without being listed. */
  readonly accepted: readonly SeatId[];
  readonly declinedBy: SeatId | null;
  /** An end offer: when the match ends if nobody declines. */
  readonly endsAt: number | null;
};

export type Receipt = {
  readonly seat: SeatId;
  readonly id: ActionId;
  /** Hash of the canonical JSON of { expectedRevision, command or control }. */
  readonly fingerprint: string;
  /** The revision the action produced. */
  readonly revision: number;
};

export type RoomRecord = {
  /** The room record's own schema version. */
  readonly format: 1;
  readonly code: RoomCode;
  /** Bumped by a restore from backup (section 6.6). */
  readonly epoch: number;
  /** +1 per persist; guards against two writers (section 4.3). */
  readonly writes: number;
  readonly policy: RoomPolicy;
  readonly phase: RoomPhase;
  readonly revision: number;
  /** The game the room plays: the pin of the current match, or the lobby's intended engine. */
  readonly game: GamePin;
  /** The configuration the next match starts with. */
  readonly config: Json;
  /** The level given to seats filled with the AI. */
  readonly aiLevel: string | null;
  readonly seats: readonly SeatRecord[];
  readonly host: SeatId | null;
  /** Null in a lobby before the first start. */
  readonly match: MatchRecord | null;
  /** The latest rematch or end-match offer; absent in records written before D-61. */
  readonly offer?: OfferRecord | null;
  readonly receipts: readonly Receipt[];
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type Member = {
  /** Null: spectator. */
  readonly seat: SeatId | null;
  /** The wire version this connection speaks. */
  readonly protocol: number;
  readonly joinedAt: number;
};

/** What the core steps. The adapter holds one per room in memory. */
export type LiveRoom = {
  readonly record: RoomRecord;
  readonly members: ReadonlyMap<ConnId, Member>;
  /** Claimed human seats with no connection, since when. */
  readonly absentSince: ReadonlyMap<SeatId, number>;
  /** Job id → start time, for job timeouts. */
  readonly jobStartedAt: ReadonlyMap<string, number>;
  /** Heavy AI: seat → the decisionRevision a `start-ai` is out for. Live-only. */
  readonly aiInFlight: ReadonlyMap<SeatId, number>;
  /** Heavy AI: seat → when to ask the pool again after it failed that decision. Live-only. */
  readonly aiRetry: ReadonlyMap<SeatId, AiRetry>;
  /** The last alarm the core asked for, so it emits `alarm` only when it changes. */
  readonly alarmAt: number | null;
  /** Set by `close`; a closed copy never persists again. */
  readonly closed: boolean;
};

/**
 * Why the pool gave no answer to a `start-ai`. `busy`: it refused the job unrun. `lost`: a
 * restart caused by another job ended it. `timeout` and `crashed`: it ran too long or its worker
 * died while running it. `failed`: the AI's module threw or the job has no module.
 */
export type AiFailure = 'busy' | 'lost' | 'timeout' | 'crashed' | 'failed';

/** A heavy AI decision waiting to be asked again (rule 7). */
export type AiRetry = {
  readonly decisionRevision: number;
  readonly at: number;
  /** Failed asks for this decision so far, which set the backoff. */
  readonly failures: number;
  /** Of those, timeouts and crashes, which count toward `aiAttempts`. */
  readonly faults: number;
};

/** Fresh seeds from the adapter's CSPRNG, for a match that starts in this step. */
export type MatchSeeds = { readonly engine: RngState; readonly ai: RngState };

export type RoomCommand =
  | {
      readonly type: 'join';
      readonly conn: ConnId;
      /**
       * As the client sent it. The core runs the identity filter (`@joystyk/identity/names`) and
       * gives a refused name a generated one, with a `name-replaced` notice.
       */
      readonly name: string;
      readonly protocol: number;
      readonly presentedTokenHash: string | null;
      /** Hash of a fresh token the adapter generated; used only if the core assigns a new seat. */
      readonly freshTokenHash: string;
      /** Spectate even if a seat is free. */
      readonly watch: boolean;
    }
  /** The socket closed. Not a departure: the seat's grace period starts. */
  | { readonly type: 'leave'; readonly conn: ConnId }
  | {
      readonly type: 'act';
      readonly conn: ConnId;
      readonly id: ActionId;
      readonly expectedRevision: number;
      /** Already passed engine.schemas.command. */
      readonly command: Json;
    }
  | {
      readonly type: 'control';
      readonly conn: ConnId;
      readonly id: ActionId;
      readonly expectedRevision: number;
      readonly control: RoomControl;
      /** Used only when this control starts a match (start, or the answer that completes a rematch offer). */
      readonly seeds: MatchSeeds;
    }
  /** The client asked for a full snapshot. */
  | { readonly type: 'resync'; readonly conn: ConnId }
  | { readonly type: 'timer-fired' }
  | { readonly type: 'job-completed'; readonly jobId: string; readonly outcome: JobOutcome }
  /** Heavy AI: the pool's answer to `start-ai`, unparsed, or why there is none. */
  | { readonly type: 'ai-chosen'; readonly seat: SeatId; readonly decisionRevision: number; readonly command: Json }
  | {
      readonly type: 'ai-chosen';
      readonly seat: SeatId;
      readonly decisionRevision: number;
      readonly command: null;
      readonly failure: AiFailure;
    }
  /** First command after loading from storage. */
  | { readonly type: 'resume' }
  | { readonly type: 'close'; readonly reason: 'expired' | 'unload' };

/** One engine input, for the room's replay log (the contract's Replay.inputs). */
export type LoggedInput = {
  readonly match: number;
  readonly revision: number;
  readonly at: number;
  /** Job outcomes without their presentation. */
  readonly input: EngineInput<Json>;
};

export type DropReason = 'replaced' | 'left-room' | 'room-closed' | 'room-full';

export type RoomEffect =
  /** Save. Always the first effect when the record changed; nothing else happens if it fails. */
  | { readonly type: 'persist'; readonly record: RoomRecord; readonly inputs: readonly LoggedInput[] }
  /** Welcome one connection. With `issueToken`, the adapter adds the fresh token it generated. */
  | { readonly type: 'welcome'; readonly conn: ConnId; readonly message: WelcomeMessage; readonly issueToken: boolean }
  /** Send one message to several connections: every member of a seat, or all spectators. */
  | { readonly type: 'send'; readonly to: readonly ConnId[]; readonly message: ServerMessage }
  /** Close a connection the room no longer serves. */
  | { readonly type: 'drop'; readonly conn: ConnId; readonly reason: DropReason }
  /** Wake the room at this time with { type: 'timer-fired' }. Null cancels. */
  | { readonly type: 'alarm'; readonly at: number | null }
  | {
      readonly type: 'start-job';
      readonly jobId: string;
      readonly kind: string;
      readonly payload: Json;
      readonly timeoutMs: number;
    }
  /** Heavy AI: choose on the worker pool. `rng` is this decision's forked stream. */
  | {
      readonly type: 'start-ai';
      readonly seat: SeatId;
      readonly decisionRevision: number;
      readonly view: Json;
      readonly level: string;
      readonly rng: RngState;
    }
  | {
      readonly type: 'log';
      readonly level: 'info' | 'warn' | 'error';
      readonly event: string;
      readonly fields: { readonly [k: string]: Json };
    };

export type Step = {
  readonly room: LiveRoom;
  readonly effects: readonly RoomEffect[];
};

export type RoomError = {
  readonly code: 'bad-config' | 'bad-policy' | 'init-failed';
  readonly message: string;
  /** Server-only diagnostic data. Never serialize the error wholesale to a client. */
  readonly diagnostic?: { readonly reference: string; readonly error: string };
};

export type CreateParams = {
  readonly code: RoomCode;
  readonly policy: RoomPolicy;
  /** Already passed engine.schemas.config. */
  readonly config: Json;
  /** From the adapter's CSPRNG. Used when the match starts at creation (start: 'immediate'). */
  readonly seeds: MatchSeeds;
  /** `name` as the client sent it; a name the identity filter refuses becomes a generated one. */
  readonly creator: { readonly name: string; readonly tokenHash: string };
};

export type CoreLimits = {
  readonly receiptsPerSeat: number;
  readonly logEvents: number;
  readonly aiInputsPerStep: number;
  readonly resumeGraceMs: number;
  /** How long an offer to end a match waits for a decline before the match ends (D-61). */
  readonly endOfferMs: number;
  /** A heavy AI's first wait before the pool is asked again; each further failure doubles it. */
  readonly aiRetryMs: number;
  readonly aiRetryMaxMs: number;
  /** Timeouts and crashes of one decision before its seat gets the timeout move. */
  readonly aiAttempts: number;
};

export const DEFAULT_LIMITS: CoreLimits = {
  receiptsPerSeat: 64,
  logEvents: 300,
  aiInputsPerStep: 256,
  resumeGraceMs: 15_000,
  endOfferMs: 60_000,
  aiRetryMs: 1_000,
  aiRetryMaxMs: 16_000,
  aiAttempts: 3,
};

export type RoomCoreOptions = {
  readonly engine: AnyDiscreteEngine;
  /** The build this core runs; `pin.rulesVersion` must equal `engine.rulesVersion`. */
  readonly pin: GamePin;
  /** Rebuilds the engine's seeded generator from saved state (usually the kit's `restoreRng`). */
  readonly rng: (state: RngState) => Rng;
  /** The manifest's `ai.heavy`: choose on the worker pool (`start-ai`), never inside a step. */
  readonly heavyAi?: boolean;
  readonly limits?: Partial<CoreLimits>;
};

export interface RoomCore {
  readonly engine: AnyDiscreteEngine;
  readonly pin: GamePin;
  /** A new record. For start: 'immediate', the match is initialized too. */
  create(params: CreateParams, now: number): Result<RoomRecord, RoomError>;
  /** Wrap a loaded record. The adapter then steps { type: 'resume' }. */
  load(record: RoomRecord): LiveRoom;
  step(room: LiveRoom, command: RoomCommand, now: number): Step;
}
