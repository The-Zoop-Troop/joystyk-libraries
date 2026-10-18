// Tally, the launcher's fixture game: race to a target by adding one or two to your own
// score. It is deliberately tiny, yet it exercises what the launcher must handle: solo,
// vs-AI and pass-and-play play, a private number per seat (so the hand-off screen matters),
// an AI with two levels, an assist (a hint), resignation and an outcome. It exists for tests
// and development builds only and is never listed in production.
import { defineEngine, err, gameError, ok, type Outcome, type SeatId, type Validator } from '@joystyk/contracts';

/** A Standard Schema from a type guard. */
const schema = <T>(guard: (value: unknown) => value is T, name: string): Validator<T> => ({
  '~standard': {
    version: 1,
    vendor: 'joystyk-fixture',
    validate: (value) => (guard(value) ? { value } : { issues: [{ message: `Expected ${name}.` }] }),
  },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isIntArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((n) => Number.isInteger(n));

/** `firstSeat`: who moves first (default seat 0); a rematch swaps it. */
export type TallyConfig = { readonly target?: number; readonly firstSeat?: 0 | 1 };

export type TallyState = {
  readonly target: number;
  readonly names: readonly string[];
  readonly ai: readonly boolean[];
  readonly scores: readonly number[];
  /** One private number per seat; a seat sees only its own. */
  readonly secrets: readonly number[];
  readonly turn: SeatId;
  /** The seat that moved first. */
  readonly first: SeatId;
  readonly moves: number;
  readonly hints: number;
  readonly winner: SeatId | null;
  readonly resigned: SeatId | null;
};

export type TallyCommand = { readonly type: 'add'; readonly amount: 1 | 2 } | { readonly type: 'hint' };

export type TallyEvent =
  | { readonly type: 'added'; readonly seat: SeatId; readonly amount: number }
  | { readonly type: 'hinted'; readonly seat: SeatId }
  | { readonly type: 'resigned'; readonly seat: SeatId };

/** What one seat sees: everything but the other seats' secrets. */
export type TallyView = {
  readonly target: number;
  readonly names: readonly string[];
  readonly scores: readonly number[];
  readonly turn: SeatId;
  readonly moves: number;
  readonly winner: SeatId | null;
  /** The viewer's own secret; null for a spectator (and behind the hand-off screen). */
  readonly secret: number | null;
};

const isConfig = (value: unknown): value is TallyConfig =>
  isObject(value) &&
  (value['target'] === undefined ||
    (Number.isInteger(value['target']) && (value['target'] as number) >= 2 && (value['target'] as number) <= 50)) &&
  (value['firstSeat'] === undefined || value['firstSeat'] === 0 || value['firstSeat'] === 1);

const isState = (value: unknown): value is TallyState =>
  isObject(value) &&
  Number.isInteger(value['target']) &&
  isIntArray(value['scores']) &&
  isIntArray(value['secrets']) &&
  Array.isArray(value['names']) &&
  Array.isArray(value['ai']) &&
  Number.isInteger(value['turn']) &&
  Number.isInteger(value['first']) &&
  Number.isInteger(value['moves']) &&
  Number.isInteger(value['hints']);

const isCommand = (value: unknown): value is TallyCommand =>
  isObject(value) &&
  ((value['type'] === 'add' && (value['amount'] === 1 || value['amount'] === 2)) || value['type'] === 'hint');

const isView = (value: unknown): value is TallyView => isObject(value) && isIntArray(value['scores']);
const isEvent = (value: unknown): value is TallyEvent => isObject(value) && typeof value['type'] === 'string';

const outcomeOf = (state: TallyState): Outcome | null => {
  const players = state.scores.length;
  if (state.resigned !== null && players === 1) {
    return {
      result: 'abandoned',
      placements: [{ seat: 0, place: 1, score: state.scores[0] ?? 0 }],
      summary: 'Gave up.',
    };
  }
  if (state.winner === null) return null;
  const winner = state.winner;
  const placements = state.scores.map((score, seat) => ({ seat, place: seat === winner ? 1 : 2, score }));
  if (players === 1)
    return {
      result: 'completed',
      placements,
      summary: `Reached ${String(state.target)} in ${String(state.moves)} moves.`,
      stats: { moves: state.moves },
    };
  const human = state.ai.findIndex((ai) => !ai);
  const vsAi = state.ai.some((ai) => ai);
  const result = vsAi && human !== winner ? 'lost' : 'won';
  return {
    result,
    placements,
    summary: `${state.names[winner] ?? 'Someone'} reached ${String(state.target)} first.`,
    stats: { moves: state.moves },
  };
};

export const tallyEngine = defineEngine({
  rulesVersion: 1,
  schemas: {
    config: schema(isConfig, 'a Tally setup'),
    command: schema(isCommand, 'a Tally move'),
    state: schema(isState, 'a Tally game'),
    view: schema(isView, 'a Tally view'),
    event: schema(isEvent, 'a Tally event'),
  },
  init: (config: TallyConfig, seats, rng) =>
    seats.length < 1 || seats.length > 2
      ? err(gameError('Seats', 'Tally is for one or two players.'))
      : ok<TallyState>({
          target: config.target ?? 5,
          names: seats.map((seat) => seat.name),
          ai: seats.map((seat) => seat.controller === 'ai'),
          scores: seats.map(() => 0),
          secrets: seats.map(() => rng.int(10, 100)),
          turn: Math.min(config.firstSeat ?? 0, seats.length - 1),
          first: Math.min(config.firstSeat ?? 0, seats.length - 1),
          moves: 0,
          hints: 0,
          winner: null,
          resigned: null,
        }),
  apply: (state: TallyState, input) => {
    if (outcomeOf(state) !== null) return err(gameError('GameOver', 'The game is over.'));
    const players = state.scores.length;
    switch (input.kind) {
      case 'command': {
        if (input.seat !== state.turn) return err(gameError('NotYourTurn', "It's not your turn."));
        if (input.command.type === 'hint') {
          const next = { ...state, hints: state.hints + 1 };
          return ok({
            state: next,
            beats: [{ event: { type: 'hinted', seat: input.seat } as TallyEvent }],
            assist: 'hint' as const,
          });
        }
        const amount = input.command.amount;
        const scores = state.scores.map((score, seat) => (seat === input.seat ? score + amount : score));
        const reached = (scores[input.seat] ?? 0) >= state.target;
        const next: TallyState = {
          ...state,
          scores,
          moves: state.moves + 1,
          turn: (state.turn + 1) % players,
          winner: reached ? input.seat : null,
        };
        return ok({
          state: next,
          beats: [{ event: { type: 'added', seat: input.seat, amount } as TallyEvent, state: next }],
        });
      }
      case 'resign': {
        const next: TallyState = {
          ...state,
          resigned: input.seat,
          winner: players === 1 ? null : (input.seat + 1) % players,
        };
        return ok({ state: next, beats: [{ event: { type: 'resigned', seat: input.seat } as TallyEvent }] });
      }
      case 'seat':
        return ok({
          state: {
            ...state,
            ai: state.ai.map((ai, seat) =>
              seat === input.seat && input.change.type === 'controller' ? input.change.controller === 'ai' : ai,
            ),
          },
          beats: [],
        });
      case 'timeout':
      case 'job':
        return err(gameError('Unsupported', 'Tally has no clock and no jobs.'));
    }
  },
  pending: (state: TallyState) => (outcomeOf(state) === null ? [state.turn] : []),
  viewFor: (state: TallyState, viewer): TallyView => ({
    target: state.target,
    names: state.names,
    scores: state.scores,
    turn: state.turn,
    moves: state.moves,
    winner: state.winner,
    secret: viewer === null ? null : (state.secrets[viewer] ?? null),
  }),
  eventFor: (event: TallyEvent) => event,
  outcome: outcomeOf,
  // A rematch keeps the target and swaps who moves first.
  rematch: (config: TallyConfig, finished: TallyState): TallyConfig =>
    finished.scores.length < 2 ? config : { ...config, firstSeat: finished.first === 0 ? 1 : 0 },
  ai: {
    levels: ['easy', 'hard'],
    choose: (_view: TallyView, _seat, level): TallyCommand => ({ type: 'add', amount: level === 'hard' ? 2 : 1 }),
  },
});
