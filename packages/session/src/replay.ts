// Replaying a discrete engine or a simulation from its seed. The local runner rebuilds its
// state this way for undo and restore, and tests use it to prove replay equality.
import {
  err,
  gameError,
  ok,
  type DiscreteEngine,
  type EngineAssist,
  type EngineInput,
  type EngineReplay,
  type FixedStepSimulation,
  type GameError,
  type JobOutcome,
  type JobRequest,
  type Json,
  type Result,
  type Rng,
  type RngState,
  type SeatInfo,
  type SimulationReplay,
  type Transition,
  type Validator,
} from '@joystyk/contracts';
import type { RngFactory } from './ports.ts';
import { defaultRestoreRng } from './rngs.ts';
import { compact, decode, isRecord } from './values.ts';

/** One accepted input and what its transition reported. */
export type InputRecord<Command> = {
  readonly input: EngineInput<Command>;
  /** Jobs the transition requested. */
  readonly jobs: readonly JobRequest[];
  readonly barrier: boolean;
  /** The assistance the transition flagged, if any. */
  readonly assist: EngineAssist | null;
  /** The transition set `startsClock`. */
  readonly startsClock: boolean;
  readonly restartsGame: boolean;
  /** The seats as they were when the input arrived, to tell human commands from AI ones. */
  readonly seatsBefore: readonly SeatInfo[];
};

const ENGINE_ASSISTS: readonly unknown[] = ['hint', 'check', 'reveal', 'shuffle'];

/** The assistance a transition flagged. Anything but a kind an engine may report is ignored. */
export const assistOf = (transition: { readonly assist?: EngineAssist }): EngineAssist | null =>
  ENGINE_ASSISTS.includes(transition.assist) ? (transition.assist as EngineAssist) : null;

/** What the runner keeps of one accepted input and its transition. */
export const recordOf = <Command, State, Event>(
  input: EngineInput<Command>,
  transition: Transition<State, Event>,
  seatsBefore: readonly SeatInfo[],
): InputRecord<Command> => ({
  input,
  jobs: transition.jobs ?? [],
  barrier: transition.undoBarrier === true,
  assist: assistOf(transition),
  startsClock: transition.startsClock === true,
  restartsGame: transition.restartsGame === true,
  seatsBefore,
});

/** Applies a seat change to the seat list, as the runner shows it in `meta.seats`. */
export const applySeatChange = <Command>(
  seats: readonly SeatInfo[],
  input: EngineInput<Command>,
): readonly SeatInfo[] => {
  if (input.kind !== 'seat' || input.change.type !== 'controller') return seats;
  const { change } = input;
  return seats.map((seat) =>
    seat.id === input.seat
      ? compact({ id: seat.id, name: change.name, controller: change.controller, aiLevel: change.aiLevel })
      : seat,
  );
};

/**
 * Calls `apply` the way a runner must: a throw becomes an `EngineThrew` error, and on any
 * failure the random source is restored, so a rejected input never consumes randomness that
 * a replay (which skips rejected inputs) would not.
 */
export const safeApply = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  state: State,
  input: EngineInput<Command>,
  rng: Rng,
  restoreRng: RngFactory,
): { readonly result: Result<Transition<State, Event>>; readonly rng: Rng; readonly thrown?: unknown } => {
  const before = rng.save();
  try {
    const result = engine.apply(state, input, rng);
    if (
      result.ok &&
      result.value.restartsGame === true &&
      (input.kind !== 'command' || result.value.undoBarrier !== true || engine.outcome(result.value.state) !== null)
    )
      return {
        result: err(
          gameError('BadRestart', 'A new game needs a setup command, an undo barrier and an unfinished state.'),
        ),
        rng: restoreRng(before),
      };
    return result.ok ? { result, rng } : { result, rng: restoreRng(before) };
  } catch (thrown) {
    return {
      result: err(gameError('EngineThrew', 'Something went wrong. Your last action was not applied.')),
      rng: restoreRng(before),
      thrown,
    };
  }
};

export type Rebuilt<State, Command> = {
  readonly state: State;
  readonly rng: Rng;
  readonly seats: readonly SeatInfo[];
  readonly records: readonly InputRecord<Command>[];
};

/** Runs `init` with the seed, then every input. Any rejection fails the whole replay. */
export const rebuild = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  start: { readonly config: Config; readonly seats: readonly SeatInfo[]; readonly seed: RngState },
  inputs: readonly EngineInput<Command>[],
  restoreRng: RngFactory,
): Result<Rebuilt<State, Command>, GameError> => {
  let rng = restoreRng(start.seed);
  let initialized: Result<State>;
  try {
    initialized = engine.init(start.config, start.seats, rng);
  } catch {
    return err(gameError('EngineThrew', 'The game could not be set up.'));
  }
  if (!initialized.ok) return initialized;
  let state = initialized.value;
  let seats = start.seats;
  const records: InputRecord<Command>[] = [];
  for (const [index, input] of inputs.entries()) {
    const applied = safeApply(engine, state, input, rng, restoreRng);
    rng = applied.rng;
    if (!applied.result.ok) {
      return err(
        gameError('ReplayDiverged', 'The saved moves no longer replay.', { index, code: applied.result.error.code }),
      );
    }
    const transition = applied.result.value;
    records.push(recordOf(input, transition, seats));
    seats = applySeatChange(seats, input);
    state = transition.state;
  }
  return ok({ state, rng, seats, records });
};

/**
 * Replays a recorded Layer 2 game and returns its final state and random state. The
 * conformance tests compare these with the recorded game's.
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
  restoreRng: RngFactory = defaultRestoreRng,
): Result<{ readonly state: State; readonly rng: RngState; readonly barriers: readonly number[] }, GameError> => {
  if (replay.rulesVersion !== engine.rulesVersion) {
    return err(gameError('RulesChanged', 'This replay was recorded under different rules.'));
  }
  const rebuilt = rebuild(engine, replay, replay.inputs, restoreRng);
  if (!rebuilt.ok) return rebuilt;
  const barriers = rebuilt.value.records.flatMap((record, i) => (record.barrier ? [i] : []));
  return ok({ state: rebuilt.value.state, rng: rebuilt.value.rng.save(), barriers });
};

/**
 * Replays a recorded Layer 3 game: `init` with the seed, then `step` up to `endTick`, feeding
 * each tick its inputs in array order.
 */
export const replaySimulation = <State extends Json, Input extends Json, View, Event extends Json, Config extends Json>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  replay: SimulationReplay<Input, Config>,
  restoreRng: RngFactory = defaultRestoreRng,
): Result<{ readonly state: State; readonly rng: RngState }, GameError> => {
  if (replay.rulesVersion !== simulation.rulesVersion) {
    return err(gameError('RulesChanged', 'This replay was recorded under different rules.'));
  }
  const rng = restoreRng(replay.seed);
  const initialized = simulation.init(replay.config, rng);
  if (!initialized.ok) return initialized;
  let state = initialized.value;
  let next = 0;
  for (let tick = 0; tick < replay.endTick; tick += 1) {
    const inputs: Input[] = [];
    while (next < replay.inputs.length && replay.inputs[next]!.tick === tick) {
      inputs.push(replay.inputs[next]!.input);
      next += 1;
    }
    state = simulation.step(state, inputs, rng).state;
  }
  return ok({ state, rng: rng.save() });
};

const isSeat = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const parseJobOutcome = (value: unknown): JobOutcome | null => {
  if (!isRecord(value)) return null;
  if (value['ok'] === true && Object.hasOwn(value, 'value')) return { ok: true, value: value['value'] as Json };
  if (value['ok'] === false && (value['reason'] === 'timeout' || value['reason'] === 'failed')) {
    return { ok: false, reason: value['reason'] };
  }
  return null;
};

/** Parses one input from a stored replay; commands go through the engine's schema. */
export const parseEngineInput = <Command>(
  value: unknown,
  command: Validator<Command>,
): Result<EngineInput<Command>, GameError> => {
  const bad = err(gameError('SaveUnreadable', 'This saved game could not be read.', { why: 'replay input' }));
  if (!isRecord(value)) return bad;
  switch (value['kind']) {
    case 'command': {
      if (!isSeat(value['seat'])) return bad;
      const decoded = decode(command, value['command'], 'saved command');
      return decoded.ok ? ok({ kind: 'command', seat: value['seat'], command: decoded.value }) : decoded;
    }
    case 'seat': {
      const change = value['change'];
      if (!isSeat(value['seat']) || !isRecord(change)) return bad;
      if (change['type'] === 'left') return ok({ kind: 'seat', seat: value['seat'], change: { type: 'left' } });
      if (
        change['type'] !== 'controller' ||
        (change['controller'] !== 'human' && change['controller'] !== 'ai') ||
        typeof change['name'] !== 'string' ||
        (change['aiLevel'] !== undefined && typeof change['aiLevel'] !== 'string')
      ) {
        return bad;
      }
      return ok({
        kind: 'seat',
        seat: value['seat'],
        change: compact({
          type: 'controller',
          controller: change['controller'],
          name: change['name'],
          aiLevel: change['aiLevel'],
        }),
      });
    }
    case 'timeout':
    case 'resign':
      return isSeat(value['seat']) ? ok({ kind: value['kind'], seat: value['seat'] }) : bad;
    case 'job': {
      const outcome = parseJobOutcome(value['outcome']);
      return typeof value['jobId'] === 'string' && outcome !== null
        ? ok({ kind: 'job', jobId: value['jobId'], outcome })
        : bad;
    }
    default:
      return bad;
  }
};
