import type { JobOutcome, JobRequest, JobSpec } from './jobs.ts';
import type { Json } from './json.ts';
import type { EngineAssist, Outcome } from './outcome.ts';
import type { Result } from './result.ts';
import type { Rng } from './rng.ts';
import type { Validator } from './schema.ts';
import type { Controller, SeatId, SeatInfo } from './seats.ts';

/** A seat changing hands or emptying, fed to the engine as a `seat` input. */
export type SeatChange =
  | {
      readonly type: 'controller';
      readonly controller: Controller;
      readonly name: string;
      readonly aiLevel?: string;
    }
  | { readonly type: 'left' };

/**
 * Everything that can change engine state. Players send commands; the platform adds facts no
 * player controls (a seat changing hands, a clock running out, a resignation, a finished
 * job). Making them explicit inputs keeps the engine the single authority and puts them in
 * the replay log.
 *
 * Turn discipline applies to `command` only: the engine rejects a command from a seat that
 * isn't pending, except for an explicitly authorized untimed `sideCommand`. The platform-originated inputs are valid whenever the game is in progress:
 * `resign` in particular arrives during the opponent's turn, and the engine decides what it
 * means (usually the resigning seat loses; a multi-seat game may hand the seat to the AI or
 * drop it).
 */
export type EngineInput<Command> =
  | { readonly kind: 'command'; readonly seat: SeatId; readonly command: Command }
  | { readonly kind: 'seat'; readonly seat: SeatId; readonly change: SeatChange }
  | { readonly kind: 'timeout'; readonly seat: SeatId }
  | { readonly kind: 'resign'; readonly seat: SeatId }
  | { readonly kind: 'job'; readonly jobId: string; readonly outcome: JobOutcome };

/** One step of playback: an event and, optionally, the state just after it. */
export type Beat<State, Event> = {
  readonly event: Event;
  /** State right after this event. Omit when playback needs only the final state. */
  readonly state?: State;
};

/** What a viewer receives for each beat, already redacted. */
export type ViewBeat<View, Event> = {
  readonly event: Event;
  readonly view?: View;
};

/** One complete, accepted change: the result of a successful `apply`. */
export type Transition<State, Event> = {
  readonly state: State;
  /** Ordered beats for playback. */
  readonly beats: readonly Beat<State, Event>[];
  /** Work requested by this transition. */
  readonly jobs?: readonly JobRequest[];
  /**
   * True when undo must never step back past the input that produced this transition, such
   * as a hint or a check that marks the game as assisted. Replay reproduces the flag, so the
   * platform never guesses which inputs are barriers. Omit it (or set false) otherwise.
   */
  readonly undoBarrier?: boolean;
  /**
   * Set when this input gave the player help (a hint, a check, a reveal or a shuffle). The runner records
   * the kind in the save and the outcome, where undoing the input can't erase it. Replay
   * reproduces it, like `undoBarrier`. Independent of `undoBarrier`: a game that must also
   * stop undo there sets both.
   */
  readonly assist?: EngineAssist;
  /**
   * True on the transition that starts the platform's play clock, for an engine that declares
   * `clockStart: 'transition'` (Minesweeper's first uncover; a flag doesn't start it). Set it
   * at most once in a game. Replay reproduces it, like `undoBarrier`. Ignored otherwise.
   */
  readonly startsClock?: boolean;
  /** A new local puzzle/course. Requires an undo barrier and a state without an outcome. */
  readonly restartsGame?: boolean;
};

/** The Standard Schemas a discrete engine publishes for the data crossing its boundaries. */
export interface EngineSchemas<State, Command, View, Event, Config> {
  readonly config: Validator<Config>;
  readonly command: Validator<Command>;
  /** The current save shape. */
  readonly state: Validator<State>;
  /** Remote clients decode views with it. */
  readonly view: Validator<View>;
  readonly event: Validator<Event>;
}

/**
 * What a finished daily game shares (content-pipeline.md, "Share text"): the result that ends
 * the header line, and symbol rows, each also in words for *Copy as text*. Never answer
 * letters, clue text or anything else that spoils the puzzle.
 */
export type ShareSummary = {
  /** The game's own policy, e.g. Queens permits undo without assistance. */
  readonly assisted?: boolean;
  /** Ends the header line: "4/6", "4/6 (hard)", "2/3". */
  readonly headline: string;
  /** One row per line: emoji symbols only (no letters or digits), and the same row in words. */
  readonly rows: readonly { readonly symbols: string; readonly words: string; readonly detail?: number | 'found' }[];
  /** The variant played, one of the manifest's `dailyVariants`; left out for a one-puzzle day. */
  readonly variant?: string;
};

/** Runner-driven AI. It sees only the seat's view, so it can't cheat. */
export interface EngineAi<View, Command> {
  /** E.g. ["easy", "medium", "hard"]. */
  readonly levels: readonly string[];
  choose(view: View, seat: SeatId, level: string, rng: Rng): Command;
}

/**
 * Layer 2: a pure rules engine for games that advance by discrete decisions. Implementing it
 * gets a game a local runner, P2P and server rooms, AI seats, saves, replay and the
 * conformance tests.
 *
 * All five type parameters must be JSON; declare them with `type`, not `interface` (see
 * `Json`).
 */
export interface DiscreteEngine<
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
> {
  readonly rulesVersion: number;
  readonly schemas: EngineSchemas<State, Command, View, Event, Config>;

  /** A new game. Deals, shuffles and sets up using `rng` only. */
  init(config: Config, seats: readonly SeatInfo[], rng: Rng): Result<State>;

  /** The only way state changes. One input becomes one complete transition. */
  apply(state: State, input: EngineInput<Command>, rng: Rng): Result<Transition<State, Event>>;

  /** Seats whose decision the engine is waiting for. Several seats at once is legal. */
  pending(state: State): readonly SeatId[];

  /** What one seat may see; `viewer` null is a spectator. Must hide everything private. */
  viewFor(state: State, viewer: SeatId | null): View;

  /** Redacts one event for a viewer; null removes it from that viewer's beats. */
  eventFor(event: Event, viewer: SeatId | null): Event | null;

  /** Null while the game is in progress. */
  outcome(state: State): Outcome | null;

  /** Independent local saves by variant/date; pure, with a public label and safe key. */
  saveSlot?(state: State): { readonly key: string; readonly label: string };

  /**
   * Pass-and-play games with manifest.handoff: false skips the cover for a public phase.
   * Those phase views must carry no private data. Returning to true covers the new hand,
   * even if the same human remains pending. Default true; never enables a manifest cover.
   */
  handoffRequired?(state: State): boolean;

  /** When false, the platform waits before offering updates. Default: outcome !== null. */
  safePoint?(state: State): boolean;

  /**
   * The config for a rematch after `finished`, when it differs from the last game's (Nim
   * swaps who moves first). The platform calls it for "Play again". Default: the same config.
   */
  rematch?(config: Config, finished: State): Config;

  /**
   * Daily games: the spoiler-free share summary of a finished game (content-pipeline.md,
   * "Share text"), or null while it is in progress. The launcher's daily mode records it with
   * the result and builds the share text from it. Pure, like `outcome`.
   */
  share?(state: State, outcome?: Outcome): ShareSummary | null;

  /** Runner-driven AI. Engines that play AI seats inside `apply` leave it out. */
  readonly ai?: EngineAi<View, Command>;

  /** Asynchronous work the engine can request, by kind. */
  readonly jobs?: { readonly [kind: string]: JobSpec };

  /**
   * The part of a seat's view that its decisions depend on. A command is stale only if this
   * changed after the revision the client saw. Default: `viewFor(state, seat)`. Hearts
   * excludes "who has already passed", so simultaneous passes are never stale.
   */
  decisionKey?(state: State, seat: SeatId): Json;

  /** Untimed control action outside pending. Must preserve pending seats and their decision keys. */
  sideCommand?(state: State, seat: SeatId, command: Command): boolean;

  /**
   * How long `seat` has for its current decision, in milliseconds, given the room's
   * configured clock (null: clock off). With a per-move clock, `configured` is the chosen
   * preset; with a time bank, it is the seat's remaining bank, and returning anything else
   * takes the decision off the bank. Null means no clock. Default: `configured` for every
   * pending human seat. Shift 23 returns its auto-deal pause for the dealer between hands,
   * even with the clock off.
   */
  decisionMs?(state: State, seat: SeatId, configured: number | null): number | null;

  /**
   * How long clients need to play back this transition (dice settling, cards dealt), in
   * milliseconds. Decision clocks start after it. Default: 0.
   */
  holdMs?(transition: Transition<State, Event>, presentation: Json | null): number;

  /**
   * When the platform's play clock (`elapsedMs`) starts. `'first-input'`, the default, starts
   * it at the first accepted input. `'transition'` starts it at the first transition that sets
   * `startsClock`, so a game whose spec times from a particular move (a first uncover, a first
   * digit) gets the right time without reading a clock. The runner owns the time.
   */
  readonly clockStart?: 'first-input' | 'transition';

  /**
   * False when the state holds nothing worth resuming: no meaningful move yet (a puzzle with
   * no digit, a minefield with no uncover). The local runner then writes no save, and clears
   * one it wrote earlier, so the launcher never offers "Continue" for an untouched game. Pure,
   * like `outcome`. Default: every state is worth saving.
   */
  worthSaving?(state: State): boolean;
}

/**
 * Any discrete engine, as the launcher and the room server hold it without knowing the
 * game's types. Every concrete engine is assignable to it.
 */
export type AnyDiscreteEngine = DiscreteEngine<Json, Json, Json, Json, Json>;

/**
 * Returns the engine unchanged. It exists so TypeScript infers and checks the five type
 * parameters from the object literal, without writing them out.
 */
export const defineEngine = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
): DiscreteEngine<State, Command, View, Event, Config> => engine;
