// Deliberately broken variants of the fixtures, one flaw each, for the suites' self-tests.
// Each proves that a check fires on the bug it exists to catch.

import { err, gameError, ok, type GameError, type StandardSchemaV1, type Validator } from '@joystyk/contracts';
import {
  diceRace,
  drawPlay,
  drift,
  hintPuzzle,
  nim,
  type DiceRaceState,
  type DrawPlayState,
  type DriftState,
  type NimState,
} from './fixtures/index.ts';

// ── Leaks ──────────────────────────────────────────────────────────────────────────────

/** Hides other players' faces but keeps their card ids (the flaw shift-23.md describes). */
export const leakyIds: typeof drawPlay = {
  ...drawPlay,
  viewFor: (state, viewer) =>
    ({
      ...drawPlay.viewFor(state, viewer),
      others: state.hands.map((h, s) => (s === viewer ? [] : h.map((c) => ({ hidden: true, id: c.id })))),
    }) as ReturnType<typeof drawPlay.viewFor>,
};

/** Shows a spectator the first player's hand. */
export const leakySpectator: typeof drawPlay = {
  ...drawPlay,
  viewFor: (state, viewer) => ({
    ...drawPlay.viewFor(state, viewer),
    hand: viewer === null ? (state.hands[0] ?? null) : (state.hands[viewer] ?? null),
  }),
};

/** Tells everyone which card was drawn. */
export const leakyEvents: typeof drawPlay = { ...drawPlay, eventFor: (event) => event };

/** Puts the top of the deck into every seat's decision key. */
export const leakyKey: typeof drawPlay = {
  ...drawPlay,
  decisionKey: (state, seat) => ({ view: drawPlay.viewFor(state, seat), top: state.deck[0]?.id ?? null }),
};

// ── Determinism and purity ─────────────────────────────────────────────────────────────

let calls = 0;
/** Counts calls in module state, so the same input can give a different answer. */
export const nondeterministic: typeof nim = {
  ...nim,
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    if (!result.ok) return result;
    calls += 1;
    return ok({ ...result.value, state: { ...result.value.state, moves: result.value.state.moves + (calls % 2) } });
  },
};

/** Changes the state it was given (the suites freeze it, so this throws). */
export const mutating: typeof nim = {
  ...nim,
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    if (result.ok) (state as { moves: number }).moves += 1;
    return result;
  },
};

/** Throws for an illegal move instead of returning an error. */
export const throwing: typeof nim = {
  ...nim,
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    if (!result.ok && result.error.code === 'IllegalMove') throw new Error('illegal move');
    return result;
  },
};

/** Rejects with something that isn't a GameError. */
export const badRejection: typeof nim = {
  ...nim,
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    return result.ok ? result : err({ code: result.error.code } as GameError);
  },
};

// ── JSON and schemas ───────────────────────────────────────────────────────────────────

/** Leaves an `undefined` in its state. */
export const undefinedInState: typeof nim = {
  ...nim,
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    return result.ok ? ok({ ...result.value, state: { ...result.value.state, last: undefined } as NimState }) : result;
  },
};

/** Produces `-0`, which JSON turns into 0. */
export const negativeZero: typeof nim = {
  ...nim,
  init: (config, seats, rng) => {
    const result = nim.init(config, seats, rng);
    return result.ok ? ok({ ...result.value, lean: Math.round(-0.4) } as NimState) : result;
  },
};

const rejectBigHeaps: Validator<NimState> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value): StandardSchemaV1.Result<NimState> =>
      (value as NimState).heap > 10
        ? { issues: [{ message: 'heap too big', path: ['heap'] }] }
        : { value: value as NimState },
  },
};
/** A state schema that rejects states the engine produces. */
export const schemaDisagrees: typeof nim = { ...nim, schemas: { ...nim.schemas, state: rejectBigHeaps } };

// ── Turns, resignation and outcomes ────────────────────────────────────────────────────

/** Lets any seat take from the heap. */
export const anySeatMoves: typeof nim = {
  ...nim,
  apply: (state, input, rng) =>
    input.kind === 'command' && state.winner === null
      ? nim.apply({ ...state, turn: input.seat === 0 ? 0 : 1 }, { ...input, seat: input.seat === 0 ? 0 : 1 }, rng)
      : nim.apply(state, input, rng),
};

/** Refuses a resignation out of turn. */
export const resignOnlyInTurn: typeof nim = {
  ...nim,
  apply: (state, input, rng) =>
    input.kind === 'resign' && input.seat !== state.turn
      ? err(gameError('NotYourTurn', 'Wait for your turn.'))
      : nim.apply(state, input, rng),
};

/** Accepts a resignation after the game ended, rewriting the winner. */
export const lateResign: typeof nim = {
  ...nim,
  apply: (state, input, rng) =>
    input.kind === 'resign' && state.winner !== null
      ? ok({ state: { ...state, winner: 1 - input.seat }, beats: [{ event: { type: 'resigned', seat: input.seat } }] })
      : nim.apply(state, input, rng),
};

/** Keeps listing a pending seat after the outcome. */
export const pendingAfterEnd: typeof nim = { ...nim, pending: (state) => [state.turn] };

/** Places only the winner. */
export const partialPlacements: typeof nim = {
  ...nim,
  outcome: (state) => {
    const outcome = nim.outcome(state);
    return outcome === null ? null : { ...outcome, placements: outcome.placements.slice(0, 1) };
  },
};

/** Never takes anything from the heap, so the game never ends. */
export const endless: typeof nim = {
  ...nim,
  apply: (state, input, rng) => {
    const result = nim.apply(state, input, rng);
    return result.ok && input.kind === 'command'
      ? ok({ ...result.value, state: { ...result.value.state, heap: state.heap, winner: null } })
      : result;
  },
};

/** After the first move nobody is pending, although the game isn't over. */
export const stuck: typeof nim = {
  ...nim,
  pending: (state) => (state.winner === null && state.moves === 0 ? [state.turn] : []),
};

/** Its AI always takes three, even from a smaller heap. */
export const greedyAi: typeof nim = { ...nim, ai: { levels: ['greedy'], choose: () => ({ type: 'take', count: 3 }) } };

/** A decision key that never changes, so a stale command would pass the room's check. */
export const frozenKey: typeof nim = { ...nim, decisionKey: () => null };

// ── Invariants ─────────────────────────────────────────────────────────────────────────

/** Loses the card a player plays instead of putting it on the table. */
export const losesCards: typeof drawPlay = {
  ...drawPlay,
  apply: (state, input, rng) => {
    const result = drawPlay.apply(state, input, rng);
    if (!result.ok || input.kind !== 'command' || input.command.type !== 'play') return result;
    const next: DrawPlayState = { ...result.value.state, table: state.table };
    return ok({ ...result.value, state: next });
  },
};

// ── Undo barriers ──────────────────────────────────────────────────────────────────────

/** Forgets to mark hints as undo barriers. */
export const noBarrier: typeof hintPuzzle = {
  ...hintPuzzle,
  apply: (state, input, rng) => {
    const result = hintPuzzle.apply(state, input, rng);
    if (!result.ok) return result;
    const { undoBarrier: _dropped, ...rest } = result.value;
    return ok(rest);
  },
};

/** Reports a hint as a reveal. */
export const wrongAssist: typeof hintPuzzle = {
  ...hintPuzzle,
  apply: (state, input, rng) => {
    const result = hintPuzzle.apply(state, input, rng);
    return result.ok && result.value.assist !== undefined ? ok({ ...result.value, assist: 'reveal' }) : result;
  },
};

/** Claims undo as its own assistance, which only the platform may record. */
export const assistsUndo: typeof hintPuzzle = {
  ...hintPuzzle,
  apply: (state, input, rng) => {
    const result = hintPuzzle.apply(state, input, rng);
    return result.ok && result.value.assist !== undefined ? ok({ ...result.value, assist: 'undo' as 'hint' }) : result;
  },
};

// ── Session hooks ──────────────────────────────────────────────────────────────────────

/** Starts the clock on every guess, not just the first. */
export const clockEveryGuess: typeof hintPuzzle = {
  ...hintPuzzle,
  apply: (state, input, rng) => {
    const result = hintPuzzle.apply(state, input, rng);
    return result.ok && input.kind === 'command' && input.command.type === 'guess'
      ? ok({ ...result.value, startsClock: true })
      : result;
  },
};

/** Sets startsClock without declaring clockStart, so runners would ignore it. */
export const undeclaredClockStart: typeof hintPuzzle = { ...hintPuzzle, clockStart: undefined };

let saveCalls = 0;
/** Answers worthSaving from hidden module state. */
export const impureWorthSaving: typeof hintPuzzle = {
  ...hintPuzzle,
  worthSaving: () => {
    saveCalls += 1;
    return saveCalls % 2 === 0;
  },
};

/** Writes into the state it is asked about. */
export const mutatingWorthSaving: typeof hintPuzzle = {
  ...hintPuzzle,
  worthSaving: (state) => {
    (state as { gaveUp: boolean }).gaveUp = state.gaveUp;
    return true;
  },
};

// ── Jobs ───────────────────────────────────────────────────────────────────────────────

/** Accepts a job outcome for any id while it is rolling. */
export const anyJobId: typeof diceRace = {
  ...diceRace,
  apply: (state, input, rng) =>
    input.kind === 'job' && state.awaiting !== null && state.winner === null && state.resigned === null
      ? diceRace.apply(state, { ...input, jobId: state.awaiting }, rng)
      : diceRace.apply(state, input, rng),
};

/** Refuses failed throws, so a lost job leaves the game stuck. */
export const refusesFailures: typeof diceRace = {
  ...diceRace,
  apply: (state, input, rng) =>
    input.kind === 'job' && !input.outcome.ok
      ? err(gameError('Fumble', 'Throw again.'))
      : diceRace.apply(state, input, rng),
};

/** Uses the same job id for every throw. */
export const reusedJobId: typeof diceRace = {
  ...diceRace,
  apply: (state, input, rng) => {
    const fixed: DiceRaceState = state.awaiting === null ? state : { ...state, awaiting: `throw-${state.throws}` };
    const shifted = input.kind === 'job' && input.jobId === 'throw' ? { ...input, jobId: fixed.awaiting ?? '' } : input;
    const result = diceRace.apply(fixed, shifted, rng);
    if (!result.ok) return result;
    return ok({ ...result.value, jobs: (result.value.jobs ?? []).map((job) => ({ ...job, id: 'throw' })) });
  },
};

// ── Simulations ────────────────────────────────────────────────────────────────────────

let steps = 0;
/** Adds a push that depends on how often `step` was called. */
export const driftNondeterministic: typeof drift = {
  ...drift,
  step: (state, inputs, rng) => {
    steps += 1;
    const result = drift.step(state, inputs, rng);
    return steps % 97 === 0 ? { ...result, state: { ...result.state, score: result.state.score + 1 } } : result;
  },
};

/** Increments the tick in place (the suite freezes states, so this throws). */
export const driftMutating: typeof drift = {
  ...drift,
  step: (state, inputs, rng) => {
    const result = drift.step(state, inputs, rng);
    (state as { tick: number }).tick = result.state.tick;
    return result;
  },
};

/** Puts `-0` into the state. */
export const driftNegativeZero: typeof drift = {
  ...drift,
  step: (state, inputs, rng) => {
    const result = drift.step(state, inputs, rng);
    return { ...result, state: { ...result.state, drag: Math.round(-0.2) } as DriftState };
  },
};

/** A state schema that resets the score, so a restored checkpoint isn't the saved one. */
export const driftLossySchema: typeof drift = {
  ...drift,
  schemas: {
    ...drift.schemas,
    state: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: { ...(value as DriftState), score: 0 } }),
      },
    },
  },
};

/** Forgets to bounce off the right-hand end of the track. */
export const driftEscapes: typeof drift = {
  ...drift,
  step: (state, inputs, rng) => {
    const result = drift.step(state, inputs, rng);
    return {
      ...result,
      state: { ...result.state, pos: result.state.pos + (result.state.pos >= state.length - 3 ? 10 : 0) },
    };
  },
};

/** Burns time in every step. */
export const driftSlow: typeof drift = {
  ...drift,
  step: (state, inputs, rng) => {
    let sink = 0;
    for (let i = 0; i < 20_000; i += 1) sink += i % 7;
    const result = drift.step(state, inputs, rng);
    return sink < 0 ? { state } : result;
  },
};
