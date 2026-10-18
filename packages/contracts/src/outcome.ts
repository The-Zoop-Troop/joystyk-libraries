import type { SeatId } from './seats.ts';

/**
 * How a game ended. From the human seat's point of view in solo and vs-AI play; from the
 * winner's (`won`) in multiplayer, where `placements` carries the detail.
 */
export type OutcomeResult = 'won' | 'lost' | 'draw' | 'completed' | 'abandoned';

/**
 * Help a player had, recorded by the platform: an undo it performed, or a hint, check or
 * reveal the engine flagged on a transition (`Transition.assist`). Whether a kind makes a
 * result "assisted" for a game's stats is the game spec's call: Chess counts any takeback,
 * Sudoku counts hints and checks but not undo.
 */
export type AssistKind = 'undo' | 'hint' | 'check' | 'reveal' | 'shuffle';

/** Lifetime accepted uses, including help whose transition was later undone. */
export type AssistCounts = Readonly<Partial<Record<AssistKind, number>>>;

/** The assistance kinds an engine may flag. Undo is the platform's own, so engines never report it. */
export type EngineAssist = Exclude<AssistKind, 'undo'>;

/** Every assistance kind, in the order runners list them. */
export const ASSIST_KINDS: readonly AssistKind[] = ['undo', 'hint', 'check', 'reveal', 'shuffle'];

/** One seat's final placing. Ties share a place. */
export type Placement = {
  readonly seat: SeatId;
  readonly place: number;
  readonly score?: number;
};

/** The end of a game, for the results screen, stats and share text. */
export type Outcome = {
  readonly result: OutcomeResult;
  /** Final placing per seat. Solo games have one entry. */
  readonly placements: readonly Placement[];
  /** Short line for the results screen and share text, e.g. "Solved in 4:12". */
  readonly summary: string;
  /** Game-specific stats for the stats screen, e.g. { "moves": 87 }. */
  readonly stats?: { readonly [name: string]: number };
  /**
   * Active play time in milliseconds, measured by the platform. Engines never set it (they
   * read no clock); the runner adds it before publishing the outcome.
   */
  readonly elapsedMs?: number;
  /**
   * Undos taken in this game, counted by the platform, which alone performs undo. Engines
   * never set it.
   */
  readonly undosUsed?: number;
  /**
   * The kinds of assistance used, each listed once in `ASSIST_KINDS` order; empty when none.
   * Written by the runner (undo, plus the kinds the engine flagged on transitions), never
   * by the engine.
   */
  readonly assists?: readonly AssistKind[];
  readonly assistCounts?: AssistCounts;
};
