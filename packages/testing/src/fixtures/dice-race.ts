// Dice Race: one or two players race to a target score. Rolling requests a `throw` job, as
// Greed's physics dice do; nobody can act until the job's outcome arrives. A failed throw lets
// the same player roll again. It exercises job requests, awaited job ids and failures.

import { defineEngine, err, gameError, ok, type Json, type SeatId } from '@joystyk/contracts';
import { createRng } from '@joystyk/kit';
import { guardSchema } from '../builders.ts';
import type { EngineConformanceOptions } from '../engine-conformance.ts';
import { isArrayOf, isInt, isRecord, isSeat, isSeatOrNull, rankPlaces } from './guards.ts';

export type DiceRaceState = {
  readonly target: number;
  readonly scores: readonly number[];
  readonly turn: SeatId;
  /** The id of the throw job being awaited, if any. */
  readonly awaiting: string | null;
  readonly throws: number;
  readonly resigned: SeatId | null;
  readonly winner: SeatId | null;
};
export type DiceRaceCommand = { readonly type: 'roll' };
export type DiceRaceEvent =
  | { readonly type: 'rolling'; readonly seat: SeatId }
  | { readonly type: 'rolled'; readonly seat: SeatId; readonly faces: readonly number[] }
  | { readonly type: 'fumbled'; readonly seat: SeatId }
  | { readonly type: 'resigned'; readonly seat: SeatId };
export type DiceRaceConfig = { readonly target: number };
export type ThrowPayload = { readonly seed: number; readonly dice: number };

const isFaces = (v: unknown): v is number[] => isArrayOf(v, (n): n is number => isInt(n, 1, 6)) && v.length === 2;
const isPayload = (v: unknown): v is ThrowPayload => isRecord(v) && isInt(v['seed'], 0) && v['dice'] === 2;
const isState = (v: unknown): v is DiceRaceState =>
  isRecord(v) &&
  isInt(v['target'], 1) &&
  isArrayOf(v['scores'], (n): n is number => isInt(n, 0)) &&
  isSeat(v['turn']) &&
  (v['awaiting'] === null || typeof v['awaiting'] === 'string') &&
  isInt(v['throws'], 0) &&
  isSeatOrNull(v['resigned']) &&
  isSeatOrNull(v['winner']);
const isEvent = (v: unknown): v is DiceRaceEvent =>
  isRecord(v) &&
  isSeat(v['seat']) &&
  (['rolling', 'fumbled', 'resigned'].includes(String(v['type'])) || (v['type'] === 'rolled' && isFaces(v['faces'])));

/** The job runner: two dice from the payload's seed, so a re-run gives the same faces. */
export const throwDice = (payload: Json): Json => {
  const seed = isPayload(payload) ? payload.seed : 0;
  const rng = createRng(`dice-race:${seed}`);
  return [rng.int(1, 7), rng.int(1, 7)];
};

const over = (s: DiceRaceState): boolean => s.winner !== null || s.resigned !== null;

export const diceRace = defineEngine<DiceRaceState, DiceRaceCommand, DiceRaceState, DiceRaceEvent, DiceRaceConfig>({
  rulesVersion: 1,
  schemas: {
    config: guardSchema((v): v is DiceRaceConfig => isRecord(v) && isInt(v['target'], 1, 200), 'Expected { target }.'),
    command: guardSchema(
      (v): v is DiceRaceCommand => isRecord(v) && v['type'] === 'roll',
      'Expected { type: "roll" }.',
    ),
    state: guardSchema(isState, 'Not a Dice Race state.'),
    view: guardSchema(isState, 'Not a Dice Race view.'),
    event: guardSchema(isEvent, 'Not a Dice Race event.'),
  },
  jobs: {
    throw: {
      where: 'either',
      payload: guardSchema(isPayload, 'Expected { seed, dice: 2 }.'),
      result: guardSchema(isFaces, 'Expected two faces from 1 to 6.'),
      timeoutMs: 5000,
    },
  },
  init: (config: DiceRaceConfig, seats, rng) =>
    seats.length < 1 || seats.length > 2
      ? err(gameError('Seats', 'Dice Race takes one or two players.'))
      : ok({
          target: config.target,
          scores: seats.map(() => 0),
          turn: rng.int(0, seats.length),
          awaiting: null,
          throws: 0,
          resigned: null,
          winner: null,
        }),
  apply: (state: DiceRaceState, input, rng) => {
    if (over(state)) return err(gameError('GameOver', 'The game is over.'));
    switch (input.kind) {
      case 'resign':
        if (state.scores[input.seat] === undefined) return err(gameError('NoSuchSeat', 'There is no such seat.'));
        return ok({
          state: { ...state, resigned: input.seat, awaiting: null },
          beats: [{ event: { type: 'resigned', seat: input.seat } }],
        });
      case 'command': {
        if (state.awaiting !== null || input.seat !== state.turn)
          return err(gameError('NotYourTurn', "It's not your turn."));
        const id = `throw-${state.throws + 1}`;
        return ok({
          state: { ...state, awaiting: id, throws: state.throws + 1 },
          beats: [{ event: { type: 'rolling', seat: input.seat } }],
          jobs: [{ id, kind: 'throw', payload: { seed: rng.int(0, 2147483647), dice: 2 } }],
        });
      }
      case 'job': {
        if (input.jobId !== state.awaiting) return err(gameError('NotAwaited', 'That throw is no longer awaited.'));
        const seat = state.turn;
        if (!input.outcome.ok) {
          return ok({ state: { ...state, awaiting: null }, beats: [{ event: { type: 'fumbled', seat } }] });
        }
        const faces = input.outcome.value;
        if (!isFaces(faces)) return err(gameError('BadThrow', 'The dice landed strangely.'));
        const score = (state.scores[seat] ?? 0) + faces[0]! + faces[1]!;
        const scores = state.scores.map((s, i) => (i === seat ? score : s));
        const winner = score >= state.target ? seat : null;
        return ok({
          state: { ...state, scores, awaiting: null, winner, turn: (seat + 1) % state.scores.length },
          beats: [{ event: { type: 'rolled', seat, faces } }],
        });
      }
      default:
        return err(gameError('Unsupported', 'Dice Race has no clocks or seat changes.'));
    }
  },
  pending: (state) => (over(state) || state.awaiting !== null ? [] : [state.turn]),
  viewFor: (state) => state,
  eventFor: (event) => event,
  outcome: (state) => {
    if (!over(state)) return null;
    if (state.scores.length === 1) {
      return {
        result: state.resigned === null ? 'completed' : 'abandoned',
        placements: [{ seat: 0, place: 1, score: state.scores[0] ?? 0 }],
        summary: `Reached ${state.target} in ${state.throws} throws.`,
      };
    }
    return { result: 'won', placements: rankPlaces(state.scores, state.resigned), summary: 'The race is over.' };
  },
});

/** Conformance options for the Dice Race fixture. */
export const diceRaceConformance: EngineConformanceOptions<DiceRaceState, DiceRaceCommand, DiceRaceConfig> = {
  name: 'dice-race',
  configs: [{ target: 30 }],
  seatCounts: [1, 2],
  commands: () => [{ type: 'roll' }],
  jobs: { throw: throwDice },
  jobFailureRate: 0.2,
};
