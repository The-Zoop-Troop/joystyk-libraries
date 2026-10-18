// Hint Puzzle: a solo guessing puzzle. The engine picks a secret number; each guess is told
// "higher", "lower" or "correct". A hint reveals whether the secret is even or odd; its
// transition flags `assist: 'hint'` and is an undo barrier, as Sudoku's hints are. The
// secret is hidden until solved, so the no-leak check applies to a solo game too. It uses
// both session hooks: the first guess starts the clock (a hint doesn't), and a puzzle with
// no guess or hint isn't worth saving.

import { defineEngine, err, gameError, ok, type EngineInput, type SeatId } from '@joystyk/contracts';
import { guardSchema } from '../builders.ts';
import type { EngineConformanceOptions } from '../engine-conformance.ts';
import { isArrayOf, isInt, isRecord } from './guards.ts';

export type Clue = 'higher' | 'lower' | 'correct';
export type HintPuzzleState = {
  readonly max: number;
  readonly secret: number;
  readonly guesses: readonly { readonly n: number; readonly clue: Clue }[];
  readonly hints: readonly ('even' | 'odd')[];
  readonly solved: boolean;
  readonly gaveUp: boolean;
};
export type HintPuzzleCommand = { readonly type: 'guess'; readonly n: number } | { readonly type: 'hint' };
export type HintPuzzleEvent =
  | { readonly type: 'guessed'; readonly n: number; readonly clue: Clue }
  | { readonly type: 'hinted'; readonly parity: 'even' | 'odd' }
  | { readonly type: 'gave-up' };
export type HintPuzzleView = Omit<HintPuzzleState, 'secret'> & { readonly secret: number | null };
export type HintPuzzleConfig = { readonly max: number };

/** At most this many hints per game. */
export const MAX_HINTS = 2;

const isClue = (v: unknown): v is Clue => v === 'higher' || v === 'lower' || v === 'correct';
const isGuesses = (v: unknown): v is HintPuzzleState['guesses'] =>
  isArrayOf(v, (g): g is { n: number; clue: Clue } => isRecord(g) && isInt(g['n']) && isClue(g['clue']));
const isHints = (v: unknown): v is ('even' | 'odd')[] =>
  isArrayOf(v, (h): h is 'even' | 'odd' => h === 'even' || h === 'odd');
const isState = (v: unknown): v is HintPuzzleState =>
  isRecord(v) &&
  isInt(v['max'], 2) &&
  isInt(v['secret'], 1) &&
  isGuesses(v['guesses']) &&
  isHints(v['hints']) &&
  typeof v['solved'] === 'boolean' &&
  typeof v['gaveUp'] === 'boolean';
const isView = (v: unknown): v is HintPuzzleView =>
  isRecord(v) &&
  isInt(v['max'], 2) &&
  (v['secret'] === null || isInt(v['secret'], 1)) &&
  isGuesses(v['guesses']) &&
  isHints(v['hints']) &&
  typeof v['solved'] === 'boolean' &&
  typeof v['gaveUp'] === 'boolean';
const isCommand = (v: unknown): v is HintPuzzleCommand =>
  isRecord(v) && ((v['type'] === 'guess' && isInt(v['n'])) || v['type'] === 'hint');
const isEvent = (v: unknown): v is HintPuzzleEvent =>
  isRecord(v) &&
  ((v['type'] === 'guessed' && isInt(v['n']) && isClue(v['clue'])) ||
    (v['type'] === 'hinted' && (v['parity'] === 'even' || v['parity'] === 'odd')) ||
    v['type'] === 'gave-up');

const over = (s: HintPuzzleState): boolean => s.solved || s.gaveUp;

export const hintPuzzle = defineEngine<
  HintPuzzleState,
  HintPuzzleCommand,
  HintPuzzleView,
  HintPuzzleEvent,
  HintPuzzleConfig
>({
  rulesVersion: 1,
  schemas: {
    config: guardSchema((v): v is HintPuzzleConfig => isRecord(v) && isInt(v['max'], 2, 1000), 'Expected { max }.'),
    command: guardSchema(isCommand, 'Not a Hint Puzzle command.'),
    state: guardSchema(isState, 'Not a Hint Puzzle state.'),
    view: guardSchema(isView, 'Not a Hint Puzzle view.'),
    event: guardSchema(isEvent, 'Not a Hint Puzzle event.'),
  },
  init: (config: HintPuzzleConfig, seats, rng) =>
    seats.length === 1
      ? ok({
          max: config.max,
          secret: rng.int(1, config.max + 1),
          guesses: [],
          hints: [],
          solved: false,
          gaveUp: false,
        })
      : err(gameError('Seats', 'Hint Puzzle is a solo game.')),
  apply: (state: HintPuzzleState, input) => {
    if (over(state)) return err(gameError('GameOver', 'The puzzle is finished.'));
    if (input.kind !== 'job' && input.seat !== 0) return err(gameError('NotYourTurn', 'Only seat 0 plays.'));
    if (input.kind === 'resign')
      return ok({ state: { ...state, gaveUp: true }, beats: [{ event: { type: 'gave-up' } }] });
    if (input.kind !== 'command')
      return err(gameError('Unsupported', 'Hint Puzzle has no clocks, seat changes or jobs.'));
    const command = input.command;
    if (command.type === 'hint') {
      if (state.hints.length >= MAX_HINTS) return err(gameError('NoHintsLeft', 'No hints left.'));
      const parity = state.secret % 2 === 0 ? 'even' : 'odd';
      return ok({
        state: { ...state, hints: [...state.hints, parity] },
        beats: [{ event: { type: 'hinted', parity } }],
        undoBarrier: true,
        assist: 'hint',
      });
    }
    if (command.n < 1 || command.n > state.max) return err(gameError('OutOfRange', `Guess from 1 to ${state.max}.`));
    const clue: Clue = command.n === state.secret ? 'correct' : command.n < state.secret ? 'higher' : 'lower';
    const next = { ...state, guesses: [...state.guesses, { n: command.n, clue }], solved: clue === 'correct' };
    const beats = [{ event: { type: 'guessed', n: command.n, clue } as const }];
    return ok(state.guesses.length === 0 ? { state: next, beats, startsClock: true } : { state: next, beats });
  },
  clockStart: 'transition',
  worthSaving: (state) => state.guesses.length > 0 || state.hints.length > 0,
  pending: (state) => (over(state) ? [] : [0]),
  viewFor: (state): HintPuzzleView => ({ ...state, secret: state.solved ? state.secret : null }),
  eventFor: (event) => event,
  outcome: (state) =>
    over(state)
      ? {
          result: state.solved ? 'won' : 'abandoned',
          placements: [{ seat: 0, place: 1 }],
          summary: state.solved ? `Solved in ${state.guesses.length} guesses.` : 'Gave up.',
          stats: { guesses: state.guesses.length, hints: state.hints.length },
        }
      : null,
});

/** The spec's barrier rule: every hint. */
export const isHint = (input: EngineInput<HintPuzzleCommand>): boolean =>
  input.kind === 'command' && input.command.type === 'hint';

/** Moves the secret, which the player can't see until solving the puzzle. */
export const perturbHintPuzzle = (
  state: HintPuzzleState,
  _viewer: SeatId | null,
  rng: { int(min: number, max: number): number },
): HintPuzzleState => (state.solved ? state : { ...state, secret: rng.int(1, state.max + 1) });

/** Conformance options for the Hint Puzzle fixture. */
export const hintPuzzleConformance: EngineConformanceOptions<HintPuzzleState, HintPuzzleCommand, HintPuzzleConfig> = {
  name: 'hint-puzzle',
  configs: [{ max: 12 }],
  seatCounts: [1],
  commands: (state) => [
    { type: 'hint' },
    ...Array.from({ length: state.max + 1 }, (_, n): HintPuzzleCommand => ({ type: 'guess', n })),
  ],
  perturbHidden: perturbHintPuzzle,
  undoBarrier: isHint,
  assist: (input) => (isHint(input) ? 'hint' : null),
  invariants: (s) =>
    s.solved === s.guesses.some((g) => g.clue === 'correct') ? true : 'solved disagrees with the guesses',
};
