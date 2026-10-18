// Shared fixtures for this package's tests: a tiny Nim engine and a schema stand-in.
import { defineEngine } from './engine.ts';
import { err, gameError, ok } from './result.ts';
import type { Rng, RngState } from './rng.ts';
import type { Validator } from './schema.ts';
import type { SeatId } from './seats.ts';

/** A Standard Schema that accepts anything; enough for type tests and the fixture engine. */
export const anything = <T>(): Validator<T> => ({
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value as T }) },
});

/** A deterministic stand-in for the kit's RNG: a counter. */
export const counterRng = (start = 0): Rng => {
  let n = start;
  return {
    next: () => ((n += 1) % 100) / 100,
    int: (min, max) => min + ((n += 1) % (max - min)),
    shuffle: (items) => [...items].reverse(),
    save: (): RngState => ({ algorithm: 'counter', words: [n] }),
  };
};

export type NimState = { readonly heap: number; readonly turn: SeatId; readonly winner: SeatId | null };
export type NimCommand = { readonly type: 'take'; readonly count: number };
export type NimView = NimState;
export type NimEvent =
  | { readonly type: 'took'; readonly seat: SeatId; readonly count: number }
  | { readonly type: 'resigned'; readonly seat: SeatId };
export type NimConfig = { readonly heap: number };

/** Two players take 1–3 from a heap; whoever takes the last one wins. */
export const nim = defineEngine({
  rulesVersion: 1,
  schemas: {
    config: anything<NimConfig>(),
    command: anything<NimCommand>(),
    state: anything<NimState>(),
    view: anything<NimView>(),
    event: anything<NimEvent>(),
  },
  init: (config: NimConfig, seats, rng) =>
    seats.length === 2
      ? ok({ heap: config.heap, turn: rng.int(0, 2), winner: null })
      : err(gameError('Seats', 'Nim needs two players.')),
  apply: (state: NimState, input) => {
    if (state.winner !== null) return err(gameError('GameOver', 'The game is over.'));
    switch (input.kind) {
      case 'command': {
        if (input.seat !== state.turn) return err(gameError('NotYourTurn', "It's not your turn."));
        const { count } = input.command;
        if (count < 1 || count > 3 || count > state.heap) {
          return err(gameError('IllegalMove', 'Take one, two or three.', { count }));
        }
        const heap = state.heap - count;
        const next: NimState = { heap, turn: 1 - state.turn, winner: heap === 0 ? input.seat : null };
        return ok({ state: next, beats: [{ event: { type: 'took', seat: input.seat, count } }] });
      }
      case 'resign': {
        const next: NimState = { ...state, winner: 1 - input.seat };
        return ok({ state: next, beats: [{ event: { type: 'resigned', seat: input.seat } }] });
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
        },
});
