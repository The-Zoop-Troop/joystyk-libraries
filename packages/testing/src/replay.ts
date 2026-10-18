// Replay and undo by replay, as the platform performs them (game-contract.md, "Replays" and
// "Undo, barriers and assistance"). The session package's runners do the same in production;
// these versions also report what each input's transition flagged, which tests need.

import {
  ASSIST_KINDS,
  err,
  gameError,
  ok,
  type AssistKind,
  type DiscreteEngine,
  type EngineAssist,
  type EngineInput,
  type EngineReplay,
  type FixedStepSimulation,
  type Json,
  type Outcome,
  type Result,
  type SeatInfo,
  type SimulationReplay,
} from '@joystyk/contracts';
import { restoreRng } from '@joystyk/kit';

/** What one replayed input's transition flagged. */
export type ReplayedInput = {
  readonly barrier: boolean;
  readonly assist: EngineAssist | null;
  /** Whether the input was a command from a seat a human controlled at the time. */
  readonly humanCommand: boolean;
};

/** The end of a Layer 2 replay. */
export type EngineReplayResult<State> = {
  readonly state: State;
  readonly outcome: Outcome | null;
  /** One entry per input, in order. */
  readonly inputs: readonly ReplayedInput[];
  /** One flag per input: whether its transition set `undoBarrier`. */
  readonly barriers: readonly boolean[];
};

const ENGINE_ASSISTS: readonly unknown[] = ['hint', 'check', 'reveal', 'shuffle'];

const seatsAfter = (seats: readonly SeatInfo[], input: EngineInput<unknown>): readonly SeatInfo[] => {
  if (input.kind !== 'seat' || input.change.type !== 'controller') return seats;
  const { change } = input;
  return seats.map((seat) =>
    seat.id !== input.seat
      ? seat
      : change.aiLevel === undefined
        ? { id: seat.id, name: change.name, controller: change.controller }
        : { id: seat.id, name: change.name, controller: change.controller, aiLevel: change.aiLevel },
  );
};

/**
 * Replays a Layer 2 log: `init` with the seed, then every input in order with the same
 * generator. Fails with `ReplayInitFailed` or `ReplayInputRejected` (detail: the input's
 * index and the engine's error) when the log no longer applies, as it won't after a rules
 * change. An engine that throws is a bug, so the exception propagates.
 */
export const replayEngine = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  replay: EngineReplay<Command, Config>,
): Result<EngineReplayResult<State>> => {
  const rng = restoreRng(replay.seed);
  const started = engine.init(replay.config, replay.seats, rng);
  if (!started.ok) return err(gameError('ReplayInitFailed', 'The replay could not start.', { error: started.error }));
  let state = started.value;
  let seats = replay.seats;
  const inputs: ReplayedInput[] = [];
  for (const [index, input] of replay.inputs.entries()) {
    const applied = engine.apply(state, input, rng);
    if (!applied.ok) {
      return err(gameError('ReplayInputRejected', 'The replay no longer applies.', { index, error: applied.error }));
    }
    const { assist } = applied.value;
    inputs.push({
      barrier: applied.value.undoBarrier === true,
      assist: ENGINE_ASSISTS.includes(assist) ? (assist as EngineAssist) : null,
      humanCommand: input.kind === 'command' && seats.find((s) => s.id === input.seat)?.controller === 'human',
    });
    seats = seatsAfter(seats, input);
    state = applied.value.state;
  }
  return ok({ state, outcome: engine.outcome(state), inputs, barriers: inputs.map((i) => i.barrier) });
};

/** The result of one undo by replay. */
export type UndoResult<State, Command extends Json, Config extends Json> = {
  /** The replay without the undone inputs. */
  readonly replay: EngineReplay<Command, Config>;
  readonly state: State;
  /** How many inputs were dropped: the human's command and everything after it. */
  readonly dropped: number;
  /**
   * Every assistance kind used in the game before the undo, in `ASSIST_KINDS` order, `'undo'`
   * included. The record only grows: undoing a hint doesn't remove `'hint'`.
   */
  readonly assists: readonly AssistKind[];
};

/**
 * Undo by replay, as the local runner performs it (D-32): it returns to the start of the
 * human seat's previous decision, dropping the latest command from a human-controlled seat
 * and everything after it (the AI's replies, job outcomes), then replays the rest from the
 * seed. It refuses with `NothingToUndo` when no human command is left and with
 * `UndoBarrier` when any dropped input's transition set `undoBarrier`, so undo never steps
 * back past a barrier nor past anything before it. Barrier and assistance flags come from
 * replaying the log, never from a separate record. Undo policies and limits are the
 * runner's business, not this helper's.
 */
export const undoByReplay = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  replay: EngineReplay<Command, Config>,
): Result<UndoResult<State, Command, Config>> => {
  const full = replayEngine(engine, replay);
  if (!full.ok) return full;
  const cut = full.value.inputs.findLastIndex((input) => input.humanCommand);
  if (cut < 0) return err(gameError('NothingToUndo', 'There is nothing to undo.'));
  const barrier = full.value.inputs.findIndex((input, index) => index >= cut && input.barrier);
  if (barrier >= 0) return err(gameError('UndoBarrier', "That move can't be undone.", { index: barrier }));
  const shorter: EngineReplay<Command, Config> = { ...replay, inputs: replay.inputs.slice(0, cut) };
  const previous = replayEngine(engine, shorter);
  if (!previous.ok) return previous;
  const used = new Set<AssistKind>([
    'undo',
    ...full.value.inputs.flatMap((input) => (input.assist === null ? [] : [input.assist])),
  ]);
  return ok({
    replay: shorter,
    state: previous.value.state,
    dropped: replay.inputs.length - cut,
    assists: ASSIST_KINDS.filter((kind) => used.has(kind)),
  });
};

/** The end of a Layer 3 replay. */
export type SimulationReplayResult<State> = {
  readonly state: State;
  readonly outcome: Outcome | null;
};

/**
 * Replays a Layer 3 log: `init` with the seed, then `step` from tick 0 up to `endTick`
 * (exclusive), giving each tick the inputs assigned to it in array order.
 */
export const replaySimulation = <State extends Json, Input extends Json, View, Event extends Json, Config extends Json>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  replay: SimulationReplay<Input, Config>,
): Result<SimulationReplayResult<State>> => {
  const rng = restoreRng(replay.seed);
  const started = simulation.init(replay.config, rng);
  if (!started.ok) return err(gameError('ReplayInitFailed', 'The replay could not start.', { error: started.error }));
  const byTick = new Map<number, Input[]>();
  for (const { tick, input } of replay.inputs) byTick.set(tick, [...(byTick.get(tick) ?? []), input]);
  let state = started.value;
  for (let tick = 0; tick < replay.endTick; tick += 1) {
    state = simulation.step(state, byTick.get(tick) ?? [], rng).state;
  }
  return ok({ state, outcome: simulation.outcome(state) });
};
