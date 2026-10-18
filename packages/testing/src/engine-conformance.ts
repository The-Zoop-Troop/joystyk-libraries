// The Layer 2 conformance suite (game-contract.md, "Conformance tests"). It plays many random
// games from fixed seeds and checks every rule a discrete engine must keep, collecting
// reproducible failures instead of stopping at the first.

import {
  isGameError,
  isJson,
  runMigrations,
  type DiscreteEngine,
  type EngineAssist,
  type EngineInput,
  type EngineReplay,
  type Json,
  type Migration,
  type Outcome,
  type Rng,
  type RngState,
  type SeatId,
  type SeatInfo,
  type Transition,
  type Validator,
} from '@joystyk/contracts';
import { restoreRng } from '@joystyk/kit';
import { replayEngine as runnerReplayEngine } from '@joystyk/session';
import { engineReplay, seats as makeSeats, type SaveFixture } from './builders.ts';
import { deepEqual, deepFreeze, errorMessage, firstDifference, jsonProblem, jsonRoundTrip, show } from './deep.ts';
import { replayEngine, undoByReplay } from './replay.ts';
import { Recorder, type ConformanceReport, type Failure } from './report.ts';
import { cloneRng, testRng, testSeed } from './rng.ts';
import { formatIssues, validate } from './schema.ts';

/** One way to start a game: a config and the seats (a count, or explicit `SeatInfo`s). */
export type EngineSetup<Config> = {
  readonly config: Config;
  readonly seats: number | readonly SeatInfo[];
  readonly label?: string;
};

/**
 * What an invariant hook returns: nothing or `true` when the state is fine; `false` or a
 * message when it isn't. Throwing (for example from `expect`) also counts as a violation.
 */
export type InvariantResult = void | boolean | string;

/** Save-related inputs for the `saves` check. */
export type SaveOptions = {
  /** The current save version (`GameVersions.save`). */
  readonly version: number;
  /** The oldest save version that was ever shipped. Default 1. */
  readonly firstVersion?: number;
  readonly migrations: readonly Migration[];
  /** At least one stored state for every shipped save version, the current one included. */
  readonly fixtures: readonly SaveFixture[];
};

/** Original successor snapshots: preserve what the viewer legitimately learns in them. */
export type HiddenTransition<State, Command> = {
  readonly input: EngineInput<Command>;
  readonly states: readonly State[];
};

/** Options for `checkEngine` and `runEngineConformance`. */
export type EngineConformanceOptions<State, Command, Config> = {
  /** A name for reports and the vitest `describe` block. */
  readonly name?: string;
  /** The game id written into replays and saves. Default "test-game". */
  readonly gameId?: string;
  /** How to start games. Or give `configs` and `seatCounts`, and every pair is used. */
  readonly setups?: readonly EngineSetup<Config>[];
  readonly configs?: readonly Config[];
  readonly seatCounts?: readonly number[];
  /** Random games per setup. Default 12. */
  readonly games?: number;
  /** The base seed. Game `g` of setup `s` uses the seed string `${seed}/${s}/${g}`. Default "conformance". */
  readonly seed?: string;
  /** The most inputs one game may take. Default 400. */
  readonly maxSteps?: number;
  /** Fail a game that has no outcome after `maxSteps` inputs. Default true. */
  readonly requireOutcome?: boolean;
  /**
   * Candidate commands for `seat` in `state`: every legal command, or a sample of them.
   * Illegal candidates are fine; the engine's answer decides. Without it, the suite asks
   * `engine.ai` for one command per pending seat.
   */
  readonly commands?: (state: State, seat: SeatId, rng: Rng) => readonly Command[];
  /**
   * Changes only what `viewer` may not see (other hands, the deck, a solution), usually with
   * the kit's `perturbHidden`. Without it the no-leak check is skipped, which is right only
   * for games whose state is entirely public.
   */
  readonly perturbHidden?: (state: State, viewer: SeatId | null, rng: Rng) => State;
  /**
   * Optional event-check retry: preserve the viewer's current and newly learned facts,
   * including the input's required cards, while varying information that stays hidden.
   * Separate from perturbHidden so legacy position helpers never receive transition work.
   */
  readonly perturbTransition?: (
    state: State,
    viewer: SeatId | null,
    rng: Rng,
    transition: HiddenTransition<State, Command>,
  ) => State;
  /** Perturbations per viewer per position. Default 2. */
  readonly perturbations?: number;
  /** Called on every state the game reaches (after `init` and after every applied input). */
  readonly invariants?: (state: State) => InvariantResult;
  /**
   * Which platform inputs the random games send. `resign` (default true) is accepted by every
   * engine while the game is in progress; turn on `timeout` and `seatChanges` for engines
   * that support clocks and seat hand-overs.
   */
  readonly platformInputs?: { readonly resign?: boolean; readonly timeout?: boolean; readonly seatChanges?: boolean };
  /** Fake job runners by job kind: they return the outcome's `value`. */
  readonly jobs?: { readonly [kind: string]: (payload: Json, rng: Rng) => Json };
  /** How often a job fails instead (`{ ok: false }`). Default 0.1. */
  readonly jobFailureRate?: number;
  /**
   * Which inputs the game's spec makes undo barriers. When given, every transition's
   * `undoBarrier` must match it.
   */
  readonly undoBarrier?: (input: EngineInput<Command>, before: State, after: State) => boolean;
  /**
   * Which inputs the game's spec counts as assistance (a hint, a check, a reveal). When
   * given, every transition's `assist` must match it.
   */
  readonly assist?: (input: EngineInput<Command>, before: State, after: State) => EngineAssist | null;
  /** Save fixtures and migrations. Without them only the save round trip is checked. */
  readonly saves?: SaveOptions;
  /** Run only one game, to reproduce a reported failure. */
  readonly only?: { readonly setup: number; readonly game: number };
  /** Failures kept per check in the report. Default 3. */
  readonly maxFailuresPerCheck?: number;
};

/** The checks this suite runs, in report order. */
export const ENGINE_CHECKS = [
  {
    id: 'determinism',
    title: 'Determinism: the same seed and inputs give the same states, beats, barriers and outcomes',
  },
  { id: 'replay', title: 'Replay: the recorded log reproduces the final state' },
  { id: 'json', title: 'JSON safety of configs, states, views, events, commands, jobs and decision keys' },
  { id: 'schemas', title: "Schema agreement: every value passes the engine's own schemas" },
  { id: 'no-leak', title: 'No leaks: viewFor, eventFor and decisionKey ignore what the viewer may not see' },
  {
    id: 'rejections',
    title: 'Rejected inputs change nothing: apply never throws or mutates, and rejects with a GameError',
  },
  { id: 'turns', title: 'Turn discipline: only pending decisions and declared untimed side commands are allowed' },
  { id: 'resign', title: 'Resignation is accepted from any seat, in turn or not, while the game is in progress' },
  { id: 'invariants', title: 'Invariants hold on every state the game reaches' },
  { id: 'ai', title: 'AI legality: ai.choose never returns a rejected command' },
  { id: 'saves', title: 'Saves: round trip, restore and continue, and the migration chain from fixtures' },
  { id: 'jobs', title: 'Job hygiene: job outcomes are accepted only while their job is awaited' },
  { id: 'stale', title: "Staleness: while a seat's decisionKey is unchanged, the commands it may send are unchanged" },
  { id: 'undo', title: "Undo by replay returns to the human's previous decision and never steps back past a barrier" },
  { id: 'assist', title: 'Assistance: transitions flag hints, checks and reveals, and replay reproduces the flags' },
  {
    id: 'session-hooks',
    title: 'Session hooks: startsClock is declared and set at most once a game, and worthSaving is pure',
  },
  {
    id: 'outcome',
    title: 'Every game reaches a valid outcome in time, and a finished game rejects commands and resignations',
  },
] as const;

/** The id of one engine check. */
export type EngineCheckId = (typeof ENGINE_CHECKS)[number]['id'];

/** The engine's answer to one tried input. */
type Attempt<State, Event> =
  | { readonly kind: 'accepted'; readonly transition: Transition<State, Event>; readonly rngAfter: RngState }
  | { readonly kind: 'rejected'; readonly code: string }
  | { readonly kind: 'threw'; readonly message: string };

/** One state the game reached. */
type Position<State, Command> = {
  readonly state: State;
  /** The generator's state before the next input. */
  readonly rng: RngState;
  readonly pending: readonly SeatId[];
  readonly keys: readonly Json[];
  /** Accepted candidate commands per pending seat. */
  readonly accepted: ReadonlyMap<SeatId, readonly Command[]>;
};

type Step<State, Command, Event> = {
  readonly input: EngineInput<Command>;
  readonly transition: Transition<State, Event>;
  readonly rngAfter: RngState;
};

const ENGINE_ASSISTS: readonly unknown[] = ['hint', 'check', 'reveal', 'shuffle'];

const DEFAULTS = { games: 12, maxSteps: 400, perturbations: 2, jobFailureRate: 0.1, maxFailures: 3 };
const CANDIDATE_CAP = 12;

/** Builds the setups from `setups`, or from every `configs` × `seatCounts` pair. */
const resolveSetups = <Config>(
  options: Pick<EngineConformanceOptions<unknown, unknown, Config>, 'setups' | 'configs' | 'seatCounts'>,
): EngineSetup<Config>[] => {
  if (options.setups !== undefined && options.setups.length > 0) return [...options.setups];
  const configs = options.configs ?? [];
  const counts = options.seatCounts ?? [];
  const setups = configs.flatMap((config) => counts.map((seats) => ({ config, seats })));
  if (setups.length === 0)
    throw new TypeError('Engine conformance needs `setups`, or both `configs` and `seatCounts`.');
  return setups;
};

const safely = <T>(make: () => readonly T[]): readonly T[] => {
  try {
    return make();
  } catch {
    return [];
  }
};

const sample = <T>(items: readonly T[], count: number, rng: Rng): T[] =>
  items.length <= count ? [...items] : rng.shuffle(items).slice(0, count);

const invariantMessage = (result: InvariantResult): string | null => {
  if (result === undefined || result === true) return null;
  if (result === false) return 'the invariant hook returned false';
  return result;
};

const outcomeProblem = (outcome: Outcome, seats: readonly SeatInfo[]): string | null => {
  if (!['won', 'lost', 'draw', 'completed', 'abandoned'].includes(outcome.result))
    return `unknown result ${show(outcome.result)}`;
  if (typeof outcome.summary !== 'string') return 'summary must be a string';
  if (outcome.elapsedMs !== undefined || outcome.undosUsed !== undefined || outcome.assists !== undefined) {
    return 'engines never set elapsedMs, undosUsed or assists; the runner adds them';
  }
  const placed = outcome.placements.map((p) => p.seat);
  for (const p of outcome.placements) {
    if (!seats.some((s) => s.id === p.seat)) return `placement for unknown seat ${show(p.seat)}`;
    if (!Number.isInteger(p.place) || p.place < 1)
      return `seat ${p.seat} has place ${show(p.place)}; places start at 1`;
  }
  if (new Set(placed).size !== placed.length) return 'a seat is placed twice';
  if (placed.length !== seats.length) {
    return `placements cover ${placed.length} of ${seats.length} seats; every seat gets exactly one placing`;
  }
  return null;
};

/**
 * Runs the Layer 2 conformance suite against `engine` and returns a report. It never throws
 * for a failing check; it throws only for unusable options. Use `runEngineConformance` to get
 * one vitest case per check instead.
 */
export const checkEngine = async <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  options: EngineConformanceOptions<State, Command, Config>,
): Promise<ConformanceReport> => {
  const setups = resolveSetups(options);
  if (options.commands === undefined && engine.ai === undefined) {
    throw new TypeError(
      'Engine conformance needs a `commands` generator, or an engine with `ai`, to play random games.',
    );
  }
  const rec = new Recorder(ENGINE_CHECKS, options.maxFailuresPerCheck ?? DEFAULTS.maxFailures);
  const gameCount = options.games ?? DEFAULTS.games;
  const maxSteps = options.maxSteps ?? DEFAULTS.maxSteps;
  const requireOutcome = options.requireOutcome ?? true;
  const perturbations = options.perturbations ?? DEFAULTS.perturbations;
  const resignOn = options.platformInputs?.resign ?? true;
  const timeoutOn = options.platformInputs?.timeout ?? false;
  const seatChangesOn = options.platformInputs?.seatChanges ?? false;
  const failureRate = options.jobFailureRate ?? DEFAULTS.jobFailureRate;
  const baseSeed = options.seed ?? 'conformance';
  const gameId = options.gameId ?? 'test-game';
  const keyOf = (state: State, seat: SeatId): Json =>
    engine.decisionKey === undefined ? engine.viewFor(state, seat) : engine.decisionKey(state, seat);

  if (options.perturbHidden === undefined)
    rec.skip('no-leak', 'no perturbHidden given; only right when all state is public');
  if (engine.ai === undefined) rec.skip('ai', 'the engine has no runner-driven ai');
  if (options.invariants === undefined) rec.skip('invariants', 'no invariants hook given');
  if (!resignOn) rec.skip('resign', 'resign is turned off in platformInputs');
  if (engine.clockStart === undefined && engine.worthSaving === undefined) {
    rec.skip('session-hooks', 'the engine declares neither clockStart nor worthSaving');
  }
  if (engine.clockStart !== undefined && engine.clockStart !== 'first-input' && engine.clockStart !== 'transition') {
    rec.fail('session-hooks', {
      message: `clockStart must be 'first-input' or 'transition', got ${show(engine.clockStart)}`,
    });
  }

  const validations: Promise<void>[] = [];
  // Runners validate commands, states, configs and job data on their ordered input path, so
  // those schemas must answer synchronously (game-contract.md, "Schemas at every boundary").
  const asyncAllowed = new Set<unknown>([engine.schemas.view, engine.schemas.event]);
  const checkSchema = (
    schema: Validator<unknown> | undefined,
    value: unknown,
    what: string,
    fail: (message: string) => void,
  ): void => {
    if (schema === undefined) return;
    rec.ran('schemas');
    if (!asyncAllowed.has(schema)) {
      let answer: unknown;
      try {
        answer = schema['~standard'].validate(value);
      } catch {
        answer = null;
      }
      if (typeof (answer as { then?: unknown } | null)?.then === 'function') {
        fail(
          `${what}: the schema validates asynchronously; runners need synchronous command, state, config and job schemas`,
        );
      }
    }
    validations.push(
      validate(schema, value).then(
        (result) => {
          if (!result.ok) fail(`${what} fails its schema: ${formatIssues(result.issues)}; value ${show(value)}`);
        },
        (error: unknown) => fail(`${what}: the schema threw ${errorMessage(error)}`),
      ),
    );
  };

  let totalGames = 0;
  let totalSteps = 0;
  let perturbedChanged = 0;
  let perturbedTotal = 0;

  // Config schemas, once per setup.
  for (const [index, setup] of setups.entries()) {
    rec.ran('json');
    if (!isJson(setup.config))
      rec.fail('json', {
        message: `setup ${index}: the config isn't JSON: ${jsonProblem(setup.config)}`,
        setup: index,
      });
    checkSchema(engine.schemas.config, setup.config, `setup ${index}: the config`, (message) =>
      rec.fail('schemas', { message, setup: index }),
    );
  }

  for (const [setupIndex, setup] of setups.entries()) {
    const seatList: readonly SeatInfo[] = typeof setup.seats === 'number' ? makeSeats(setup.seats) : setup.seats;
    const viewers: readonly (SeatId | null)[] = [...seatList.map((s) => s.id), null];
    for (let gameIndex = 0; gameIndex < gameCount; gameIndex += 1) {
      if (options.only !== undefined && (options.only.setup !== setupIndex || options.only.game !== gameIndex))
        continue;
      totalGames += 1;
      const seed = `${baseSeed}/${setupIndex}/${gameIndex}`;
      const seedState = testSeed(seed, 'engine');
      const driver = testRng(seed, 'driver');
      const perturbRng = testRng(seed, 'perturb');
      const positions: Position<State, Command>[] = [];
      const steps: Step<State, Command, Event>[] = [];

      const replayUpTo = (count: number): EngineReplay<Command, Config> =>
        engineReplay({
          gameId,
          rulesVersion: engine.rulesVersion,
          config: setup.config,
          seats: seatList,
          seed: seedState,
          inputs: steps.slice(0, count).map((s) => s.input),
        });
      const failure = (message: string, step: number, input?: unknown): Failure => ({
        message,
        setup: setupIndex,
        game: gameIndex,
        seed,
        step,
        replay: replayUpTo(step),
        ...(input === undefined ? {} : { input }),
      });
      const fail = (id: EngineCheckId, message: string, step: number, input?: unknown): void =>
        rec.fail(id, failure(message, step, input));

      /** Tries `input` on `state` with a copy of the generator at `rng`; nothing is committed. */
      const attempt = (
        state: State,
        input: EngineInput<Command>,
        rng: RngState,
        step: number,
      ): Attempt<State, Event> => {
        deepFreeze(input);
        let result: ReturnType<typeof engine.apply>;
        try {
          result = engine.apply(state, input, restoreRng(rng));
        } catch (error) {
          const message = errorMessage(error);
          const mutation = /read[- ]only|not extensible|frozen|Cannot (assign|add|delete|define)/i.test(message);
          fail(
            'rejections',
            mutation
              ? `apply mutated its input state or input (states are frozen): ${message}`
              : `apply threw instead of returning a result: ${message}`,
            step,
            input,
          );
          return { kind: 'threw', message };
        }
        rec.ran('rejections');
        if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') {
          fail('rejections', `apply returned ${show(result)}, not a Result`, step, input);
          return { kind: 'threw', message: 'not a result' };
        }
        if (!result.ok) {
          if (!isGameError(result.error) || !isJson(result.error)) {
            fail(
              'rejections',
              `a rejection must carry a JSON GameError with a code and a message, got ${show(result.error)}`,
              step,
              input,
            );
          }
          return { kind: 'rejected', code: String((result.error as { code?: unknown }).code) };
        }
        const transition = deepFreeze(result.value);
        return { kind: 'accepted', transition, rngAfter: rngAfterApply(state, input, rng, transition, step) };
      };

      /**
       * The generator's state after applying an input. Applying twice from the same state also
       * checks that `apply` is a function of (state, input, generator): the second answer must
       * equal the first.
       */
      const rngAfterApply = (
        state: State,
        input: EngineInput<Command>,
        rng: RngState,
        first: Transition<State, Event>,
        step: number,
      ): RngState => {
        const again = restoreRng(rng);
        try {
          const second = engine.apply(state, input, again);
          rec.ran('determinism');
          const diff = second.ok ? firstDifference(first, second.value) : 'the second try was rejected';
          if (diff !== null) {
            fail(
              'determinism',
              `apply gave two different answers for the same state, input and generator: ${diff}`,
              step,
              input,
            );
          }
        } catch (error) {
          fail(
            'determinism',
            `apply threw on a second try with the same arguments: ${errorMessage(error)}`,
            step,
            input,
          );
        }
        return again.save();
      };

      const outsideCommand = (state: State, seat: SeatId, command: Command, rng: RngState, step: number): void => {
        const input = { kind: 'command' as const, seat, command };
        if (engine.sideCommand?.(state, seat, command) !== true) {
          mustReject('turns', state, input, rng, step, `a command from seat ${seat}, which isn't pending`);
          return;
        }
        const tried = attempt(state, input, rng, step);
        rec.ran('turns');
        if (tried.kind !== 'accepted') {
          fail('turns', 'declared side command was rejected', step, input);
          return;
        }
        const after = tried.transition.state,
          pendingBefore = engine.pending(state);
        if (JSON.stringify(engine.pending(after)) !== JSON.stringify(pendingBefore))
          fail('turns', 'side command changed pending decisions', step, input);
        for (const actor of pendingBefore)
          if (
            JSON.stringify(engine.decisionKey?.(state, actor) ?? engine.viewFor(state, actor)) !==
            JSON.stringify(engine.decisionKey?.(after, actor) ?? engine.viewFor(after, actor))
          )
            fail('turns', 'side command changed a pending decision key', step, input);
      };

      const mustReject = (
        id: EngineCheckId,
        state: State,
        input: EngineInput<Command>,
        rng: RngState,
        step: number,
        why: string,
      ): void => {
        rec.ran(id);
        const tried = attempt(state, input, rng, step);
        if (tried.kind === 'accepted') fail(id, `${why}, but the engine accepted it`, step, input);
      };

      // init
      let started: ReturnType<typeof engine.init>;
      const initRng = restoreRng(seedState);
      try {
        started = engine.init(setup.config, seatList, initRng);
      } catch (error) {
        fail('rejections', `init threw: ${errorMessage(error)}`, 0);
        continue;
      }
      if (!started.ok) {
        fail('outcome', `init rejected setup ${setupIndex}: ${show(started.error)}`, 0);
        continue;
      }
      let state = deepFreeze(started.value);
      let rngState = initRng.save();
      /** Requested jobs with no accepted outcome yet, each with its planned outcome. */
      const awaited = new Map<string, { kind: string; value: Json; fails: boolean }>();
      /** Jobs answered, or superseded (the engine stopped awaiting them): their outcomes must be refused. */
      const closed: string[] = [];
      const requested = new Set<string>();
      const resignAt = resignOn && gameIndex % 3 === 2 ? driver.int(0, 24) : -1;
      /** The inputs whose transitions set `startsClock`. */
      const clockStarts: number[] = [];

      /** `startsClock` needs `clockStart: 'transition'`, and starts the clock at most once a game. */
      const checkClockStart = (
        transition: Transition<State, Event>,
        step: number,
        input: EngineInput<Command>,
      ): void => {
        if (transition.restartsGame !== undefined) {
          rec.ran('session-hooks');
          if (typeof transition.restartsGame !== 'boolean')
            fail('session-hooks', 'restartsGame must be a boolean', step, input);
          if (transition.restartsGame) {
            if (!transition.undoBarrier || engine.outcome(transition.state) !== null)
              fail('session-hooks', 'restart requires an undo barrier and an unfinished state', step, input);
            clockStarts.length = 0;
          }
        }
        const flag: unknown = transition.startsClock;
        if (flag === undefined) return;
        rec.ran('session-hooks');
        if (typeof flag !== 'boolean')
          return fail('session-hooks', `startsClock must be a boolean, got ${show(flag)}`, step, input);
        if (!flag) return;
        if (engine.clockStart !== 'transition') {
          return fail(
            'session-hooks',
            "a transition sets startsClock, but the engine doesn't declare clockStart: 'transition', so runners ignore it",
            step,
            input,
          );
        }
        if (clockStarts.length > 0) {
          fail(
            'session-hooks',
            `startsClock is set again, after input ${clockStarts[0]} set it; it starts the clock at most once a game`,
            step,
            input,
          );
        }
        clockStarts.push(step);
      };

      /** `worthSaving` answers a boolean, the same one every time, for the state and for its JSON copy. */
      const checkWorthSaving = (state: State, step: number): void => {
        const hook = engine.worthSaving;
        if (hook === undefined) return;
        rec.ran('session-hooks');
        try {
          const first: unknown = hook(state);
          if (typeof first !== 'boolean')
            return fail('session-hooks', `worthSaving returned ${show(first)}, not a boolean`, step);
          const again: unknown = hook(state);
          const copy: unknown = hook(deepFreeze(jsonRoundTrip(state)));
          if (again !== first || copy !== first) {
            fail(
              'session-hooks',
              `worthSaving answered ${String(first)}, then ${show(again)}, then ${show(copy)} for a JSON copy of the same state; it must be pure`,
              step,
            );
          }
        } catch (error) {
          const message = errorMessage(error);
          const mutation = /read[- ]only|not extensible|frozen|Cannot (assign|add|delete|define)/i.test(message);
          fail(
            'session-hooks',
            mutation
              ? `worthSaving mutated its state (states are frozen): ${message}`
              : `worthSaving threw: ${message}`,
            step,
          );
        }
      };

      /** Checks every transition the engine accepts for the game: JSON, schemas, events. */
      const checkTransition = (
        transition: Transition<State, Event>,
        step: number,
        input: EngineInput<Command>,
      ): void => {
        rec.ran('json');
        if (!isJson(transition)) fail('json', `a transition isn't JSON: ${jsonProblem(transition)}`, step, input);
        checkSchema(engine.schemas.state, transition.state, 'a transition state', (m) =>
          fail('schemas', m, step, input),
        );
        for (const beat of transition.beats) {
          checkSchema(engine.schemas.event, beat.event, 'an event', (m) => fail('schemas', m, step, input));
          if (beat.state !== undefined)
            checkSchema(engine.schemas.state, beat.state, 'a beat state', (m) => fail('schemas', m, step, input));
          for (const viewer of viewers) {
            const redacted = engine.eventFor(beat.event, viewer);
            if (redacted === null) continue;
            rec.ran('json');
            if (!isJson(redacted))
              fail('json', `eventFor(event, ${viewer}) isn't JSON: ${jsonProblem(redacted)}`, step, input);
            checkSchema(engine.schemas.event, redacted, `eventFor(event, ${viewer})`, (m) =>
              fail('schemas', m, step, input),
            );
          }
        }
      };

      /** Commits an input: the game moves on. Returns false if the engine refused it. */
      const commit = (input: EngineInput<Command>, expected?: Transition<State, Event>): boolean => {
        const step = steps.length;
        const tried = attempt(state, input, rngState, step);
        if (tried.kind !== 'accepted') return false;
        if (expected !== undefined) {
          const diff = firstDifference(expected, tried.transition);
          if (diff !== null)
            fail('determinism', `the same input gave a different transition when committed: ${diff}`, step, input);
        }
        checkTransition(tried.transition, step, input);
        checkClockStart(tried.transition, step, input);
        if (input.kind === 'command')
          checkSchema(engine.schemas.command, input.command, 'a command', (m) => fail('schemas', m, step, input));
        if (input.kind === 'job') {
          awaited.delete(input.jobId);
          closed.push(input.jobId);
        }
        for (const job of tried.transition.jobs ?? []) {
          rec.ran('jobs');
          if (requested.has(job.id))
            fail('jobs', `job id "${job.id}" was requested twice; ids must never repeat within a game`, step + 1);
          requested.add(job.id);
          const spec = engine.jobs?.[job.kind];
          if (spec === undefined) {
            fail('jobs', `a transition requested job kind "${job.kind}", which engine.jobs doesn't declare`, step + 1);
          } else {
            checkSchema(spec.payload, job.payload, `the payload of job "${job.id}"`, (m) =>
              fail('schemas', m, step + 1),
            );
          }
          rec.ran('json');
          if (!isJson(job)) fail('json', `a job request isn't JSON: ${jsonProblem(job)}`, step + 1);
          // Plan the job's outcome now, as a real runner would produce it later.
          const runner = options.jobs?.[job.kind];
          let value: Json = null;
          if (runner === undefined) {
            fail('jobs', `no fake runner for job kind "${job.kind}"; add it to the jobs option`, step + 1);
          } else {
            try {
              value = runner(job.payload, driver);
              if (spec !== undefined)
                checkSchema(spec.result, value, `the fake runner's value for job "${job.id}"`, (m) =>
                  fail('jobs', m, step + 1),
                );
            } catch (error) {
              fail('jobs', `the fake runner for "${job.kind}" threw: ${errorMessage(error)}`, step + 1);
            }
          }
          awaited.set(job.id, { kind: job.kind, value, fails: runner === undefined || driver.next() < failureRate });
        }
        steps.push({ input, transition: tried.transition, rngAfter: tried.rngAfter });
        state = tried.transition.state;
        rngState = tried.rngAfter;
        return true;
      };

      // Play.
      for (;;) {
        const step = steps.length;
        // Position checks.
        let pending: readonly SeatId[] = [];
        let outcome: Outcome | null = null;
        try {
          pending = engine.pending(state);
          outcome = engine.outcome(state);
        } catch (error) {
          fail('rejections', `pending or outcome threw: ${errorMessage(error)}`, step);
          break;
        }
        rec.ran('turns');
        const seatIds = seatList.map((s) => s.id);
        if (
          !Array.isArray(pending) ||
          pending.some((s) => !seatIds.includes(s)) ||
          new Set(pending).size !== pending.length
        ) {
          fail('turns', `pending() must list distinct seat ids, got ${show(pending)}`, step);
          pending = [];
        }
        if (outcome !== null && pending.length > 0)
          fail('turns', `pending() is ${show(pending)} although the game has an outcome`, step);

        rec.ran('json');
        if (!isJson(state)) fail('json', `the state isn't JSON: ${jsonProblem(state)}`, step);
        if (outcome !== null && !isJson(outcome)) fail('json', `the outcome isn't JSON: ${jsonProblem(outcome)}`, step);
        checkSchema(engine.schemas.state, state, 'the state', (m) => fail('schemas', m, step));
        const views = new Map<SeatId | null, View>();
        for (const viewer of viewers) {
          const view = engine.viewFor(state, viewer);
          views.set(viewer, view);
          rec.ran('json');
          if (!isJson(view)) fail('json', `viewFor(state, ${viewer}) isn't JSON: ${jsonProblem(view)}`, step);
          checkSchema(engine.schemas.view, view, `viewFor(state, ${viewer})`, (m) => fail('schemas', m, step));
        }
        const keys = seatList.map((s) => keyOf(state, s.id));
        for (const [i, key] of keys.entries()) {
          rec.ran('json');
          if (!isJson(key)) fail('json', `decisionKey(state, ${i}) isn't JSON: ${jsonProblem(key)}`, step);
        }
        if (options.invariants !== undefined) {
          rec.ran('invariants');
          try {
            const problem = invariantMessage(options.invariants(state));
            if (problem !== null) fail('invariants', `invariant violated: ${problem}`, step);
          } catch (error) {
            fail('invariants', `invariant violated: ${errorMessage(error)}`, step);
          }
        }
        checkWorthSaving(state, step);

        // Candidate commands for the pending seats.
        const accepted = new Map<SeatId, Command[]>();
        const acceptedTransitions = new Map<SeatId, Transition<State, Event>[]>();
        if (outcome === null) {
          for (const seat of pending) {
            let candidates: readonly Command[] = [];
            try {
              if (options.commands !== undefined) {
                candidates = sample(options.commands(state, seat, driver), CANDIDATE_CAP, driver);
              } else if (engine.ai !== undefined) {
                const level = driver.int(0, engine.ai.levels.length);
                candidates = [
                  engine.ai.choose(views.get(seat) as View, seat, engine.ai.levels[level] ?? '', cloneRng(driver)),
                ];
              }
            } catch (error) {
              fail(
                options.commands === undefined ? 'ai' : 'outcome',
                `generating commands threw: ${errorMessage(error)}`,
                step,
              );
            }
            const ok: Command[] = [];
            const okTransitions: Transition<State, Event>[] = [];
            for (const command of candidates) {
              rec.ran('json');
              if (!isJson(command)) fail('json', `a command isn't JSON: ${jsonProblem(command)}`, step);
              const tried = attempt(state, { kind: 'command', seat, command }, rngState, step);
              if (tried.kind === 'accepted') {
                ok.push(command);
                okTransitions.push(tried.transition);
              }
            }
            accepted.set(seat, ok);
            acceptedTransitions.set(seat, okTransitions);
          }
        }
        positions.push({ state, rng: rngState, pending, keys, accepted });

        if (outcome !== null) {
          // The game is over: validate the outcome and refuse late inputs.
          rec.ran('outcome');
          const problem = outcomeProblem(outcome, seatList);
          if (problem !== null) fail('outcome', `invalid outcome: ${problem}; outcome ${show(outcome)}`, step);
          const last = [...steps].reverse().find((s) => s.input.kind === 'command')?.input;
          for (const seat of seatList) {
            if (last !== undefined && last.kind === 'command') {
              mustReject(
                'outcome',
                state,
                { kind: 'command', seat: seat.id, command: last.command },
                rngState,
                step,
                `a command from seat ${seat.id} after the outcome`,
              );
            }
            if (options.commands !== undefined) {
              const generate = options.commands;
              for (const command of sample(
                safely(() => generate(state, seat.id, driver)),
                3,
                driver,
              )) {
                mustReject(
                  'outcome',
                  state,
                  { kind: 'command', seat: seat.id, command },
                  rngState,
                  step,
                  `a command from seat ${seat.id} after the outcome`,
                );
              }
            }
            mustReject(
              'outcome',
              state,
              { kind: 'resign', seat: seat.id },
              rngState,
              step,
              `a resign from seat ${seat.id} after the outcome`,
            );
          }
          break;
        }
        if (step >= maxSteps) {
          rec.ran('outcome');
          if (requireOutcome)
            fail('outcome', `no outcome after ${maxSteps} inputs (raise maxSteps, or set requireOutcome: false)`, step);
          break;
        }

        // Turn discipline: other seats' commands, re-addressed, and their own candidates.
        const pendingCommands = [...accepted.values()].flat();
        const outsiders = [...seatList.map((s) => s.id).filter((id) => !pending.includes(id)), -1, seatList.length];
        for (const seat of outsiders) {
          for (const command of sample(pendingCommands, 2, driver)) {
            outsideCommand(state, seat, command, rngState, step);
          }
          const generate = options.commands;
          if (generate !== undefined && seat >= 0 && seat < seatList.length) {
            for (const command of sample(
              safely(() => generate(state, seat, driver)),
              3,
              driver,
            )) {
              outsideCommand(state, seat, command, rngState, step);
            }
          }
        }

        // Resignation, in turn and out of turn.
        if (resignOn) {
          const notPending = seatList.filter((s) => !pending.includes(s.id));
          const probes = [
            ...sample(notPending, 1, driver),
            ...sample(
              seatList.filter((s) => pending.includes(s.id)),
              1,
              driver,
            ),
          ];
          for (const seat of probes) {
            rec.ran('resign');
            const input: EngineInput<Command> = { kind: 'resign', seat: seat.id };
            const tried = attempt(state, input, rngState, step);
            if (tried.kind === 'rejected') {
              const when = pending.includes(seat.id) ? 'in turn' : 'out of turn';
              fail('resign', `a resign from seat ${seat.id} (${when}) was rejected with "${tried.code}"`, step, input);
            } else if (tried.kind === 'accepted') {
              checkTransition(tried.transition, step, input);
            }
          }
        }

        // AI legality.
        if (engine.ai !== undefined) {
          for (const seat of pending) {
            for (const level of engine.ai.levels) {
              rec.ran('ai');
              let command: Command;
              try {
                command = engine.ai.choose(views.get(seat) as View, seat, level, cloneRng(driver));
              } catch (error) {
                fail('ai', `ai.choose threw for seat ${seat} at level "${level}": ${errorMessage(error)}`, step);
                continue;
              }
              const input: EngineInput<Command> = { kind: 'command', seat, command };
              const tried = attempt(state, input, rngState, step);
              if (tried.kind === 'rejected')
                fail(
                  'ai',
                  `ai.choose (level "${level}") chose a command the engine rejects with "${tried.code}"`,
                  step,
                  input,
                );
            }
          }
        }

        // Jobs: an unknown id and closed ids are refused. An awaited job accepts both a value and
        // a failure; when the engine refuses both, it has superseded the job, which stays closed.
        mustReject(
          'jobs',
          state,
          { kind: 'job', jobId: 'conformance:never-requested', outcome: { ok: true, value: null } },
          rngState,
          step,
          'a job outcome for an id no transition requested',
        );
        for (const jobId of closed.slice(-3)) {
          mustReject(
            'jobs',
            state,
            { kind: 'job', jobId, outcome: { ok: false, reason: 'timeout' } },
            rngState,
            step,
            `an outcome for job "${jobId}", which was already answered or superseded`,
          );
        }
        const answerable: string[] = [];
        for (const [jobId, job] of [...awaited]) {
          rec.ran('jobs');
          const success: EngineInput<Command> = { kind: 'job', jobId, outcome: { ok: true, value: job.value } };
          const failed: EngineInput<Command> = { kind: 'job', jobId, outcome: { ok: false, reason: 'timeout' } };
          const a = attempt(state, success, rngState, step).kind === 'accepted';
          const b = attempt(state, failed, rngState, step).kind === 'accepted';
          if (a && b) answerable.push(jobId);
          else if (a || b) {
            fail(
              'jobs',
              `the engine accepts a ${a ? 'successful' : 'failed'} outcome for job "${jobId}" but refuses a ${a ? 'failed' : 'successful'} one; while it awaits a job it must accept both (it decides what a failure means)`,
              step,
              a ? failed : success,
            );
            answerable.push(jobId);
          } else {
            awaited.delete(jobId);
            closed.push(jobId);
          }
        }

        // No leaks: perturb what each viewer can't see; views and keys must not move.
        const perturbed: { viewer: SeatId | null; state: State }[] = [];
        if (options.perturbHidden !== undefined) {
          for (const viewer of viewers) {
            for (let p = 0; p < perturbations; p += 1) {
              let other: State;
              try {
                other = deepFreeze(options.perturbHidden(state, viewer, perturbRng));
              } catch (error) {
                fail('no-leak', `perturbHidden threw for viewer ${viewer}: ${errorMessage(error)}`, step);
                continue;
              }
              rec.ran('no-leak');
              perturbedTotal += 1;
              if (!deepEqual(other, state)) perturbedChanged += 1;
              const diff = firstDifference(views.get(viewer), engine.viewFor(other, viewer));
              if (diff !== null) {
                fail(
                  'no-leak',
                  `viewFor(state, ${viewer}) changed when only hidden information changed: ${diff}`,
                  step,
                );
                continue;
              }
              if (viewer !== null) {
                const keyDiff = firstDifference(keys[viewer], keyOf(other, viewer));
                if (keyDiff !== null) {
                  fail(
                    'no-leak',
                    `decisionKey(state, ${viewer}) changed when only hidden information changed: ${keyDiff}`,
                    step,
                  );
                  continue;
                }
              }
              perturbed.push({ viewer, state: other });
            }
          }
        }

        // Choose the next input.
        const awaitedIds = answerable;
        const movable = pending.filter((seat) => (accepted.get(seat) ?? []).length > 0);
        let input: EngineInput<Command> | null = null;
        let expected: Transition<State, Event> | undefined;
        if (step === resignAt && seatList.length > 0) {
          const outside = seatList.filter((s) => !pending.includes(s.id));
          const seat = (outside.length > 0 ? outside : seatList)[
            driver.int(0, outside.length > 0 ? outside.length : seatList.length)
          ];
          if (seat !== undefined) input = { kind: 'resign', seat: seat.id };
        } else if (timeoutOn && pending.length > 0 && driver.next() < 0.1) {
          input = { kind: 'timeout', seat: pending[driver.int(0, pending.length)] ?? 0 };
        } else if (seatChangesOn && driver.next() < 0.05) {
          const seat = seatList[driver.int(0, seatList.length)];
          if (seat !== undefined) {
            const toAi = seat.controller === 'human';
            const level = engine.ai?.levels[0];
            input = {
              kind: 'seat',
              seat: seat.id,
              change: toAi
                ? {
                    type: 'controller',
                    controller: 'ai',
                    name: `${seat.name} (AI)`,
                    ...(level === undefined ? {} : { aiLevel: level }),
                  }
                : { type: 'controller', controller: 'human', name: seat.name },
            };
          }
        }
        if (input === null) {
          const choices = movable.length + awaitedIds.length;
          if (choices === 0) {
            rec.ran('outcome');
            fail(
              'outcome',
              pending.length === 0
                ? 'nobody can move: pending() is empty, no job is awaited, and there is no outcome'
                : `no candidate command was accepted for pending seats ${show(pending)}; check the commands generator or the engine`,
              step,
            );
            break;
          }
          const pick = driver.int(0, choices);
          if (pick < movable.length) {
            const seat = movable[pick] as SeatId;
            const options_ = accepted.get(seat) ?? [];
            const index = driver.int(0, options_.length);
            input = { kind: 'command', seat, command: options_[index] as Command };
            expected = acceptedTransitions.get(seat)?.[index];
          } else {
            const jobId = awaitedIds[pick - movable.length] as string;
            const job = awaited.get(jobId);
            input =
              job === undefined || job.fails
                ? { kind: 'job', jobId, outcome: { ok: false, reason: 'failed' } }
                : { kind: 'job', jobId, outcome: { ok: true, value: job.value } };
          }
        }

        const before = state;
        const beforeRng = rngState;
        if (!commit(input, expected)) {
          const id: EngineCheckId =
            input.kind === 'resign'
              ? 'resign'
              : input.kind === 'job'
                ? 'jobs'
                : input.kind === 'command'
                  ? 'determinism'
                  : 'turns';
          const why =
            input.kind === 'command'
              ? 'a command it had just accepted from the same state and generator'
              : `a ${input.kind} input, which is valid whenever the game is in progress`;
          fail(id, `the engine rejected ${why}`, step, input);
          break;
        }
        const committed = steps[steps.length - 1] as Step<State, Command, Event>;

        // Events: keep authorized new knowledge fixed while varying everything still hidden.
        for (const { viewer, state: other } of perturbed) {
          let tried = attempt(other, input, beforeRng, step);
          const trace = (t: Transition<State, Event>) => ({
            final: engine.viewFor(t.state, viewer),
            beats: t.beats
              .map((b) => ({
                event: engine.eventFor(b.event, viewer),
                view: b.state === undefined ? null : engine.viewFor(b.state, viewer),
              }))
              .filter((b) => b.event !== null),
          });
          const a = trace(committed.transition);
          const comparable = (b: ReturnType<typeof trace>): boolean =>
            deepEqual(a.final, b.final) &&
            (a.beats.length !== b.beats.length ||
              deepEqual(
                a.beats.map((x) => x.view),
                b.beats.map((x) => x.view),
              ));
          if (
            options.perturbTransition !== undefined &&
            (tried.kind !== 'accepted' || !comparable(trace(tried.transition)))
          ) {
            let kept: State;
            try {
              kept = deepFreeze(
                options.perturbTransition(before, viewer, cloneRng(perturbRng), {
                  input,
                  states: [
                    committed.transition.state,
                    ...committed.transition.beats.flatMap((beat) => (beat.state === undefined ? [] : [beat.state])),
                  ],
                }),
              );
              if (deepEqual(kept, before)) continue;
              if (
                !deepEqual(engine.viewFor(before, viewer), engine.viewFor(kept, viewer)) ||
                (viewer !== null && !deepEqual(keyOf(before, viewer), keyOf(kept, viewer)))
              ) {
                fail(
                  'no-leak',
                  `transition perturbation changed information already visible to viewer ${viewer}`,
                  step,
                  input,
                );
                continue;
              }
            } catch (error) {
              fail(
                'no-leak',
                `transition perturbation threw for viewer ${viewer}: ${errorMessage(error)}`,
                step,
                input,
              );
              continue;
            }
            tried = attempt(kept, input, beforeRng, step);
          }
          if (tried.kind !== 'accepted') continue;
          const b = trace(tried.transition);
          if (!deepEqual(a.final, b.final)) continue;
          if (
            a.beats.length === b.beats.length &&
            !deepEqual(
              a.beats.map((x) => x.view),
              b.beats.map((x) => x.view),
            )
          )
            continue;
          rec.ran('no-leak');
          const diff = firstDifference(a.beats, b.beats);
          if (diff !== null) {
            fail(
              'no-leak',
              `eventFor(event, ${viewer}) differs between two transitions that look identical to that viewer: ${diff}`,
              step,
              input,
            );
          }
        }

        // Assistance: a valid kind or nothing, and what the spec says when it says.
        {
          rec.ran('assist');
          const got = committed.transition.assist;
          if (got !== undefined && !ENGINE_ASSISTS.includes(got)) {
            fail(
              'assist',
              `assist must be 'hint', 'check' or 'reveal' (undo is the platform's own), got ${show(got)}`,
              step,
              input,
            );
          } else if (options.assist !== undefined) {
            const want = options.assist(input, before, committed.transition.state) ?? undefined;
            if (want !== got)
              fail(
                'assist',
                `the spec makes this input's assistance ${show(want ?? null)}, but the transition has assist: ${show(got ?? null)}`,
                step,
                input,
              );
          }
        }

        // Undo barrier oracle.
        if (options.undoBarrier !== undefined) {
          rec.ran('undo');
          const want = options.undoBarrier(input, before, committed.transition.state);
          const got = committed.transition.undoBarrier === true;
          if (want !== got) {
            fail(
              'undo',
              `the spec makes this input ${want ? 'an undo barrier' : 'undoable'}, but the transition has undoBarrier: ${String(committed.transition.undoBarrier)}`,
              step,
              input,
            );
          }
        }
      }
      totalSteps += steps.length;
      const final = positions[positions.length - 1];
      if (final === undefined) continue;

      // Determinism: replay the same inputs from the same seed and compare everything.
      {
        rec.ran('determinism');
        const rng = restoreRng(seedState);
        const again = engine.init(setup.config, seatList, rng);
        let ok = again.ok && deepEqual(again.value, positions[0]?.state);
        if (!ok)
          fail(
            'determinism',
            `init gave a different state for the same seed: ${again.ok ? firstDifference(positions[0]?.state, again.value) : 'rejected'}`,
            0,
          );
        let current = again.ok ? again.value : null;
        for (const [i, s] of steps.entries()) {
          if (!ok || current === null) break;
          try {
            const result = engine.apply(current, s.input, rng);
            if (!result.ok) {
              fail('determinism', `the same input was rejected on a second run: ${show(result.error)}`, i, s.input);
              ok = false;
              break;
            }
            const diff = firstDifference(s.transition, result.value) ?? firstDifference(s.rngAfter, rng.save());
            if (diff !== null) {
              fail('determinism', `a second run from the same seed diverged: ${diff}`, i, s.input);
              ok = false;
              break;
            }
            current = result.value.state;
            const outcomeDiff = firstDifference(
              engine.outcome(positions[i + 1]?.state as State),
              engine.outcome(current),
            );
            if (outcomeDiff !== null) fail('determinism', `outcome differs on a second run: ${outcomeDiff}`, i + 1);
          } catch (error) {
            fail('determinism', `apply threw on a second run: ${errorMessage(error)}`, i, s.input);
            ok = false;
          }
        }
      }

      // Replay through the replay format, after a JSON round trip.
      {
        rec.ran('replay');
        const replay = replayUpTo(steps.length);
        if (!isJson(replay)) {
          fail('replay', "the replay isn't JSON", steps.length);
        } else {
          try {
            const result = replayEngine(engine, jsonRoundTrip(replay));
            if (!result.ok) fail('replay', `the replay doesn't apply: ${show(result.error)}`, steps.length);
            else {
              const diff =
                firstDifference(final.state, result.value.state) ??
                firstDifference(engine.outcome(final.state), result.value.outcome) ??
                firstDifference(
                  steps.map((s) => s.transition.undoBarrier === true),
                  result.value.barriers,
                );
              if (diff !== null) fail('replay', `the replay ends somewhere else: ${diff}`, steps.length);
            }
            // The session runner's own replay, which undo and restore rely on in production.
            const runner = runnerReplayEngine(engine, jsonRoundTrip(replay));
            if (!runner.ok)
              fail('replay', `the session runner's replay doesn't apply: ${show(runner.error)}`, steps.length);
            else {
              const diff =
                firstDifference(final.state, runner.value.state) ?? firstDifference(final.rng, runner.value.rng);
              if (diff !== null)
                fail('replay', `the session runner's replay ends somewhere else: ${diff}`, steps.length);
            }
          } catch (error) {
            fail('replay', `replaying threw: ${errorMessage(error)}`, steps.length);
          }
        }
      }

      // Save round trip: save at a random position, restore after JSON, and continue.
      {
        rec.ran('saves');
        const k = driver.int(0, positions.length);
        const at = positions[k] as Position<State, Command>;
        const envelope = {
          gameId,
          build: '0.0.0-test',
          rulesVersion: engine.rulesVersion,
          saveVersion: options.saves?.version ?? 1,
          rng: at.rng,
          seats: seatList,
          state: at.state,
          replay: replayUpTo(k),
        };
        if (!isJson(envelope)) fail('saves', "the save envelope isn't JSON", k);
        else {
          const restored = jsonRoundTrip(envelope);
          const decoded = await validate(engine.schemas.state, restored.state);
          if (!decoded.ok) fail('saves', `a saved state fails schemas.state: ${formatIssues(decoded.issues)}`, k);
          else if (!deepEqual(decoded.value, at.state)) {
            fail('saves', `schemas.state changed a valid saved state: ${firstDifference(at.state, decoded.value)}`, k);
          } else {
            try {
              const rng = restoreRng(restored.rng);
              let current = decoded.value;
              for (const s of steps.slice(k)) {
                const result = engine.apply(current, s.input, rng);
                if (!result.ok) throw new Error(`input rejected after restoring: ${show(result.error)}`);
                current = result.value.state;
              }
              const diff = firstDifference(final.state, current);
              if (diff !== null)
                fail('saves', `a game restored from a save at input ${k} ended differently: ${diff}`, k);
            } catch (error) {
              fail('saves', `continuing a restored save failed: ${errorMessage(error)}`, k);
            }
          }
        }
      }

      // Staleness: within a run of equal decision keys, the seat's accepted commands stay the same.
      for (const seat of seatList.map((s) => s.id)) {
        let runStart = 0;
        for (let i = 1; i <= positions.length; i += 1) {
          const same = i < positions.length && deepEqual(positions[i]?.keys[seat], positions[i - 1]?.keys[seat]);
          if (same) continue;
          const run = positions.slice(runStart, i).map((p, offset) => ({ p, index: runStart + offset }));
          const turns = run.filter(({ p }) => p.pending.includes(seat) && engine.outcome(p.state) === null);
          const [base, ...later] = turns;
          if (base !== undefined) {
            for (const { p, index } of later.slice(0, 4)) {
              rec.ran('stale');
              const rejectedAt = (cmds: readonly Command[], pos: Position<State, Command>, where: number) =>
                cmds.filter(
                  (command) =>
                    attempt(pos.state, { kind: 'command', seat, command }, pos.rng, where).kind !== 'accepted',
                );
              const lost = rejectedAt(base.p.accepted.get(seat) ?? [], p, index);
              const gained = rejectedAt(p.accepted.get(seat) ?? [], base.p, base.index);
              if (lost.length > 0 || gained.length > 0) {
                const command = lost[0] ?? gained[0];
                fail(
                  'stale',
                  `decisionKey for seat ${seat} is the same after input ${base.index} and after input ${index}, but command ${show(command)} is ${lost.length > 0 ? 'accepted at the first and rejected at the second' : 'rejected at the first and accepted at the second'}; the room would let a stale command through`,
                  index,
                  { kind: 'command', seat, command },
                );
              }
            }
          }
          runStart = i;
        }
      }

      // Undo by replay, after every barrier and a few other inputs. What undo must do is
      // worked out from the recorded game; the helper works it out by replaying the log.
      {
        const humanAt: boolean[] = [];
        let seatsNow = seatList;
        for (const s of steps) {
          const input = s.input;
          humanAt.push(input.kind === 'command' && seatsNow.find((x) => x.id === input.seat)?.controller === 'human');
          if (input.kind === 'seat' && input.change.type === 'controller') {
            const { change } = input;
            seatsNow = seatsNow.map((x) =>
              x.id === input.seat ? { id: x.id, name: change.name, controller: change.controller } : x,
            );
          }
        }
        const barrierAt = steps.flatMap((s, i) => (s.transition.undoBarrier === true ? [i] : []));
        const assistAt = steps.flatMap((s, i) => (s.transition.assist === undefined ? [] : [i]));
        const others = sample(
          steps.map((_, i) => i).filter((i) => !barrierAt.includes(i)),
          4,
          driver,
        );
        for (const k of new Set([...barrierAt, ...assistAt, ...others])) {
          rec.ran('undo');
          const cut = humanAt.slice(0, k + 1).lastIndexOf(true);
          const blocked = cut >= 0 && steps.slice(cut, k + 1).some((s) => s.transition.undoBarrier === true);
          try {
            const result = undoByReplay(engine, replayUpTo(k + 1));
            if (cut < 0) {
              if (result.ok || result.error.code !== 'NothingToUndo')
                fail(
                  'undo',
                  `after input ${k} no human command is left to undo, but undo answered ${show(result.ok ? 'ok' : result.error.code)}`,
                  k + 1,
                );
            } else if (blocked) {
              if (result.ok)
                fail(
                  'undo',
                  `undo after input ${k} would step back past an undo barrier (replay doesn't reproduce the barrier)`,
                  k + 1,
                );
            } else if (!result.ok) {
              fail(
                'undo',
                `undo after input ${k} was refused with "${result.error.code}" although no barrier lies in the way`,
                k + 1,
              );
            } else {
              const diff = firstDifference(positions[cut]?.state, result.value.state);
              if (diff !== null)
                fail('undo', `undo after input ${k} didn't restore the state before input ${cut}: ${diff}`, k + 1);
              rec.ran('assist');
              const flagged = steps
                .slice(0, k + 1)
                .flatMap((s) => (s.transition.assist === undefined ? [] : [s.transition.assist]));
              const missing = flagged.filter((kind) => !result.value.assists.includes(kind));
              if (missing.length > 0)
                fail(
                  'assist',
                  `after an undo, replay no longer reports the assistance ${show(missing)} flagged during play`,
                  k + 1,
                );
            }
          } catch (error) {
            fail('undo', `undo by replay threw: ${errorMessage(error)}`, k + 1);
          }
        }
      }
    }
  }

  // Save fixtures and the migration chain.
  if (options.saves !== undefined) {
    const { version, migrations, fixtures } = options.saves;
    const first = options.saves.firstVersion ?? 1;
    for (const m of migrations) {
      rec.ran('saves');
      if (m.to !== m.from + 1)
        rec.fail('saves', { message: `migration ${m.from} → ${m.to} must step exactly one version` });
    }
    for (let v = first; v <= version; v += 1) {
      rec.ran('saves');
      if (!fixtures.some((f) => f.saveVersion === v)) {
        rec.fail('saves', {
          message: `no save fixture for save version ${v}; keep one for every version ever shipped`,
        });
      }
    }
    for (const fixture of fixtures) {
      rec.ran('saves');
      try {
        const migrated = runMigrations(migrations, fixture.state, fixture.saveVersion, version);
        if (!migrated.ok) {
          rec.fail('saves', {
            message: `save fixture "${fixture.name}" (v${fixture.saveVersion}) doesn't migrate: ${show(migrated.error)}`,
          });
          continue;
        }
        const decoded = await validate(engine.schemas.state, migrated.value);
        if (!decoded.ok) {
          rec.fail('saves', {
            message: `save fixture "${fixture.name}" (v${fixture.saveVersion}) migrates to a state that fails schemas.state: ${formatIssues(decoded.issues)}`,
          });
        }
      } catch (error) {
        rec.fail('saves', { message: `migrating save fixture "${fixture.name}" threw: ${errorMessage(error)}` });
      }
    }
  } else {
    rec.note('saves', 'round trip only; give saves.fixtures to check the migration chain');
  }

  await Promise.all(validations);
  if (options.perturbHidden !== undefined && perturbedTotal > 0 && perturbedChanged === 0) {
    rec.fail('no-leak', {
      message: `perturbHidden never changed a state in ${perturbedTotal} tries, so the no-leak check proved nothing; it must reshuffle what the viewer can't see`,
    });
  }
  return rec.report(options.name ?? 'engine', totalGames, totalSteps);
};
