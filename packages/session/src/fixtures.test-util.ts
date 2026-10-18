// Fixture games for the runner tests: a Nim variant that exercises every engine feature the
// local runner handles, and a tiny drifting-point simulation for the fixed-step runner.
import {
  defineEngine,
  defineSimulation,
  err,
  gameError,
  ok,
  type Migration,
  type SeatId,
  type Validator,
} from '@joystyk/contracts';
import type { RunnerManifest } from './saves.ts';

/** A Standard Schema built from a type guard. */
export const schema = <T>(guard: (value: unknown) => boolean, name: string): Validator<T> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => (guard(value) ? { value: value as T } : { issues: [{ message: `Expected ${name}.` }] }),
  },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export type NimState = {
  readonly heap: number;
  readonly turn: SeatId;
  readonly winner: SeatId | null;
  /** One private number per seat; each seat sees only its own. */
  readonly secrets: readonly (number | null)[];
  readonly hints: number;
  /** The id of the dice job in flight. */
  readonly rolling: string | null;
  readonly seq: number;
};
export type NimCommand =
  | { readonly type: 'take'; readonly count: number }
  | { readonly type: 'hint' }
  | { readonly type: 'roll' }
  | { readonly type: 'gamble' }
  | { readonly type: 'boom' };
export type NimEvent =
  | { readonly type: 'took'; readonly seat: SeatId; readonly count: number }
  | { readonly type: 'hinted'; readonly seat: SeatId }
  | { readonly type: 'rolling'; readonly seat: SeatId }
  | { readonly type: 'resigned'; readonly seat: SeatId }
  | { readonly type: 'seat'; readonly seat: SeatId };
export type NimConfig = { readonly heap: number };

const COMMANDS = ['take', 'hint', 'roll', 'gamble', 'boom'];

/** Every view an AI was given, so tests can prove it saw only its seat's view. */
export const aiViews: { seat: SeatId; view: NimState }[] = [];

const take = (state: NimState, seat: SeatId, count: number, players: number) => {
  const heap = state.heap - count;
  const next: NimState = {
    ...state,
    heap,
    turn: (seat + 1) % players,
    winner: heap === 0 ? seat : null,
    rolling: null,
    seq: state.seq + 1,
  };
  return ok({ state: next, beats: [{ event: { type: 'took', seat, count } as NimEvent, state: next }] });
};

/**
 * Nim for two or more seats: take one to three from the heap; whoever takes the last wins.
 * Extras for the runner: `hint` is an undo barrier, an assist and a private event, `roll` asks a dice job
 * how many to take, `gamble` draws from the rng and may then be rejected, and `boom` throws.
 */
export const nim = defineEngine({
  rulesVersion: 1,
  schemas: {
    config: schema<NimConfig>(
      (v) => isObject(v) && Number.isInteger(v['heap']) && (v['heap'] as number) > 0,
      'a heap size',
    ),
    command: schema<NimCommand>((v) => isObject(v) && COMMANDS.includes(v['type'] as string), 'a Nim command'),
    state: schema<NimState>(
      (v) => isObject(v) && typeof v['heap'] === 'number' && typeof v['hints'] === 'number',
      'a Nim state',
    ),
    view: schema<NimState>(isObject, 'a Nim view'),
    event: schema<NimEvent>(isObject, 'a Nim event'),
  },
  init: (config: NimConfig, seats, rng) =>
    seats.length < 2
      ? err(gameError('Seats', 'Nim needs two players.'))
      : ok({
          heap: config.heap,
          turn: 0,
          winner: null,
          secrets: seats.map(() => rng.int(0, 100)),
          hints: 0,
          rolling: null,
          seq: 0,
        }),
  apply: (state: NimState, input, rng) => {
    if (state.winner !== null) return err(gameError('GameOver', 'The game is over.'));
    const players = state.secrets.length;
    switch (input.kind) {
      case 'command': {
        if (input.seat !== state.turn || state.rolling !== null)
          return err(gameError('NotYourTurn', "It's not your turn."));
        const command = input.command;
        switch (command.type) {
          case 'take':
            if (command.count < 1 || command.count > 3 || command.count > state.heap) {
              return err(gameError('IllegalMove', 'Take one, two or three.'));
            }
            return take(state, input.seat, command.count, players);
          case 'gamble': {
            const count = rng.int(1, 4);
            return count > state.heap ? err(gameError('Bust', 'Too many.')) : take(state, input.seat, count, players);
          }
          case 'hint': {
            const next = { ...state, hints: state.hints + 1, seq: state.seq + 1 };
            return ok({
              state: next,
              beats: [{ event: { type: 'hinted', seat: input.seat } as NimEvent }],
              undoBarrier: true,
              assist: 'hint' as const,
            });
          }
          case 'roll': {
            const id = `roll-${state.seq}`;
            const next = { ...state, rolling: id, seq: state.seq + 1 };
            return ok({
              state: next,
              beats: [{ event: { type: 'rolling', seat: input.seat } as NimEvent }],
              jobs: [{ id, kind: 'dice', payload: { sides: 3 } }],
            });
          }
          case 'boom':
            throw new Error('boom');
        }
        return err(gameError('IllegalMove', 'Unknown command.'));
      }
      case 'job': {
        if (state.rolling !== input.jobId) return err(gameError('StaleJob', 'That roll is no longer awaited.'));
        if (!input.outcome.ok) return ok({ state: { ...state, rolling: null, seq: state.seq + 1 }, beats: [] });
        const value = typeof input.outcome.value === 'number' ? input.outcome.value : 1;
        return take(state, state.turn, Math.max(1, Math.min(value, 3, state.heap)), players);
      }
      case 'resign': {
        const next: NimState = { ...state, winner: (input.seat + 1) % players, seq: state.seq + 1 };
        return ok({ state: next, beats: [{ event: { type: 'resigned', seat: input.seat } as NimEvent }] });
      }
      case 'seat':
        return ok({
          state: { ...state, seq: state.seq + 1 },
          beats: [{ event: { type: 'seat', seat: input.seat } as NimEvent }],
        });
      case 'timeout':
        return err(gameError('Unsupported', 'Nim has no clock.'));
    }
  },
  pending: (state) => (state.winner === null && state.rolling === null ? [state.turn] : []),
  viewFor: (state, viewer) => ({
    ...state,
    secrets: state.secrets.map((secret, seat) => (seat === viewer ? secret : null)),
  }),
  eventFor: (event, viewer) => (event.type === 'hinted' && event.seat !== viewer ? null : event),
  outcome: (state) =>
    state.winner === null
      ? null
      : { result: 'won', placements: [{ seat: state.winner, place: 1 }], summary: `Seat ${state.winner + 1} wins.` },
  ai: {
    levels: ['easy', 'hard'],
    choose: (view: NimState, seat, level, rng) => {
      aiViews.push({ seat, view });
      const max = Math.min(3, view.heap);
      const count = level === 'hard' && view.heap % 4 !== 0 ? view.heap % 4 : rng.int(1, max + 1);
      return { type: 'take', count } as NimCommand;
    },
  },
  jobs: {
    dice: {
      where: 'either',
      payload: schema((v) => isObject(v) && v['sides'] === 3, 'dice'),
      result: schema((v) => Number.isInteger(v), 'a face'),
      timeoutMs: 5000,
    },
  },
});

/**
 * Nim with the session hooks: the clock starts at the first `take` (a hint doesn't start
 * it), and a game with no `take` yet isn't worth saving. `heap` is the starting heap.
 */
export const timedNim = (heap: number): typeof nim => ({
  ...nim,
  clockStart: 'transition',
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    if (!result.ok) return result;
    const first = state.heap === heap && result.value.state.heap < heap;
    return first ? ok({ ...result.value, startsClock: true }) : result;
  },
  worthSaving: (state) => state.heap < heap,
});

export const nimManifest = (overrides: Partial<RunnerManifest> = {}): RunnerManifest => ({
  id: 'nim',
  versions: { build: '1.0.0', rules: 1, save: 2, minProtocol: 1 },
  undo: 'unlimited',
  handoff: false,
  ...overrides,
});

/** Save version 1 had no `hints`; version 2 adds it. */
export const nimMigrations: readonly Migration[] = [
  {
    from: 1,
    to: 2,
    migrate: (old) => (isObject(old) ? ok({ ...old, hints: 0 }) : err(gameError('Bad', 'Not a state.'))),
  },
];

export type DriftState = { readonly x: number; readonly v: number; readonly score: number; readonly target: number };
export type DriftInput = { readonly type: 'push'; readonly dx: number };
export type DriftEvent = { readonly type: 'bonus'; readonly n: number };
export type DriftView = { readonly x: number; readonly score: number; readonly trail: Float32Array };

/** Ticks counted by the simulation itself, so the tests can check what each tick received. */
export const driftLog: { inputs: readonly DriftInput[] }[] = [];

/**
 * A point drifting along a line. Inputs push its velocity; every tenth tick of motion it
 * scores 0–2 points from the rng. It ends at the target score. The view holds a typed array,
 * which snapshot freezing must leave alone.
 */
export const drift = defineSimulation({
  rulesVersion: 1,
  stepHz: 50,
  schemas: {
    config: schema<{ readonly target: number }>((v) => isObject(v) && typeof v['target'] === 'number', 'a target'),
    input: schema<DriftInput>((v) => isObject(v) && v['type'] === 'push' && typeof v['dx'] === 'number', 'a push'),
    state: schema<DriftState>((v) => isObject(v) && typeof v['x'] === 'number', 'a drift state'),
    event: schema<DriftEvent>(isObject, 'a drift event'),
  },
  init: (config: { readonly target: number }) => ok({ x: 0, v: 0, score: 0, target: config.target }),
  step: (state: DriftState, inputs: readonly DriftInput[], rng) => {
    driftLog.push({ inputs });
    const v = inputs.reduce((sum, input) => sum + input.dx, state.v);
    const x = state.x + v;
    const bonus = Math.abs(Math.round(x)) % 10 === 0 ? rng.int(0, 3) : 0;
    return {
      state: { ...state, x, v, score: state.score + bonus },
      events: bonus > 0 ? [{ type: 'bonus', n: bonus } as DriftEvent] : [],
    };
  },
  view: (state) => ({ x: state.x, score: state.score, trail: Float32Array.of(state.x) }),
  outcome: (state) =>
    state.score >= state.target
      ? { result: 'completed', placements: [{ seat: 0, place: 1, score: state.score }], summary: 'Done.' }
      : null,
});
