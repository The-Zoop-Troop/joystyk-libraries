// Nim: two players take one to three from a heap; whoever takes the last one wins. All state
// is public. The fixture also has a save history (v1 lacked the move counter) and an AI.

import { defineEngine, err, gameError, ok, type Json, type Migration, type SeatId } from '@joystyk/contracts';
import { guardSchema, saveFixture } from '../builders.ts';
import type { EngineConformanceOptions } from '../engine-conformance.ts';
import { isInt, isRecord, isSeat, isSeatOrNull } from './guards.ts';

export type NimState = {
  readonly heap: number;
  readonly turn: SeatId;
  readonly winner: SeatId | null;
  readonly moves: number;
};
export type NimCommand = { readonly type: 'take'; readonly count: number };
export type NimView = NimState;
export type NimEvent =
  | { readonly type: 'took'; readonly seat: SeatId; readonly count: number }
  | { readonly type: 'resigned'; readonly seat: SeatId };
export type NimConfig = { readonly heap: number };

export const isNimState = (v: unknown): v is NimState =>
  isRecord(v) &&
  isInt(v['heap'], 0) &&
  isSeat(v['turn']) &&
  v['turn'] < 2 &&
  isSeatOrNull(v['winner']) &&
  isInt(v['moves'], 0);
const isNimCommand = (v: unknown): v is NimCommand => isRecord(v) && v['type'] === 'take' && isInt(v['count']);
const isNimEvent = (v: unknown): v is NimEvent =>
  isRecord(v) &&
  ((v['type'] === 'took' && isSeat(v['seat']) && isInt(v['count'])) || (v['type'] === 'resigned' && isSeat(v['seat'])));
const isNimConfig = (v: unknown): v is NimConfig => isRecord(v) && isInt(v['heap'], 1, 1000);

/** The current save version of Nim's state. */
export const NIM_SAVE_VERSION = 2;

/** v1 → v2 added `moves`; a v1 save restarts the count at 0. */
export const nimMigrations: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    migrate: (old: Json) =>
      isRecord(old) ? ok({ ...old, moves: 0 }) : err(gameError('BadSave', 'This saved game is damaged.')),
  },
];

/** Stored states for every shipped save version. */
export const nimSaveFixtures = [
  saveFixture('v1 mid-game', 1, { heap: 7, turn: 1, winner: null }),
  saveFixture('v2 finished', 2, { heap: 0, turn: 0, winner: 1, moves: 6 }),
];

const legalCounts = (heap: number): number[] => [1, 2, 3].filter((n) => n <= heap);

export const nim = defineEngine<NimState, NimCommand, NimView, NimEvent, NimConfig>({
  rulesVersion: 1,
  schemas: {
    config: guardSchema(isNimConfig, 'Expected { heap }.'),
    command: guardSchema(isNimCommand, 'Expected { type: "take", count }.'),
    state: guardSchema(isNimState, 'Not a Nim state.'),
    view: guardSchema(isNimState, 'Not a Nim view.'),
    event: guardSchema(isNimEvent, 'Not a Nim event.'),
  },
  init: (config: NimConfig, seats, rng) =>
    seats.length === 2
      ? ok({ heap: config.heap, turn: rng.int(0, 2), winner: null, moves: 0 })
      : err(gameError('Seats', 'Nim needs two players.')),
  apply: (state: NimState, input) => {
    if (state.winner !== null) return err(gameError('GameOver', 'The game is over.'));
    switch (input.kind) {
      case 'command': {
        if (input.seat !== state.turn) return err(gameError('NotYourTurn', "It's not your turn."));
        const { count } = input.command;
        if (!legalCounts(state.heap).includes(count))
          return err(gameError('IllegalMove', 'Take one, two or three.', { count }));
        const heap = state.heap - count;
        const next: NimState = {
          heap,
          turn: 1 - state.turn,
          winner: heap === 0 ? input.seat : null,
          moves: state.moves + 1,
        };
        return ok({ state: next, beats: [{ event: { type: 'took', seat: input.seat, count } }] });
      }
      case 'resign': {
        if (input.seat !== 0 && input.seat !== 1) return err(gameError('NoSuchSeat', 'There is no such seat.'));
        return ok({
          state: { ...state, winner: 1 - input.seat },
          beats: [{ event: { type: 'resigned', seat: input.seat } }],
        });
      }
      default:
        return err(gameError('Unsupported', 'Nim has no clocks, seat changes or jobs.'));
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
          stats: { moves: state.moves },
        },
  ai: {
    levels: ['random', 'perfect'],
    choose: (view, _seat, level, rng) => {
      const counts = legalCounts(view.heap);
      const perfect = view.heap % 4;
      const count = level === 'perfect' && perfect > 0 ? perfect : (counts[rng.int(0, counts.length)] ?? 1);
      return { type: 'take', count };
    },
  },
});

/** Conformance options for the Nim fixture. */
export const nimConformance: EngineConformanceOptions<NimState, NimCommand, NimConfig> = {
  name: 'nim',
  configs: [{ heap: 5 }, { heap: 21 }],
  seatCounts: [2],
  commands: () => [0, 1, 2, 3, 4].map((count) => ({ type: 'take', count })),
  invariants: (s) =>
    s.heap < 0 ? 'the heap is negative' : s.heap === 0 && s.winner === null ? 'an empty heap without a winner' : true,
  saves: { version: NIM_SAVE_VERSION, migrations: nimMigrations, fixtures: nimSaveFixtures },
};
