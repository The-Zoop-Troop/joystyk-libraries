// The Layer 3 conformance suite (game-contract.md, "Conformance tests", Layer 3). It runs
// fixed-step simulations from fixed seeds with generated tick inputs and checks determinism,
// replay, checkpoints, JSON safety, schemas, step purity, invariants and outcomes.

import {
  isJson,
  type FixedStepSimulation,
  type Json,
  type Outcome,
  type Rng,
  type RngState,
  type StepResult,
  type TickInput,
  type Validator,
} from '@joystyk/contracts';
import { restoreRng } from '@joystyk/kit';
import { replaySimulation as runnerReplaySimulation } from '@joystyk/session';
import { simulationReplay } from './builders.ts';
import { deepEqual, deepFreeze, errorMessage, firstDifference, jsonProblem, jsonRoundTrip, show } from './deep.ts';
import type { InvariantResult } from './engine-conformance.ts';
import { replaySimulation } from './replay.ts';
import { Recorder, type ConformanceReport, type Failure } from './report.ts';
import { cloneRng, testRng, testSeed } from './rng.ts';
import { formatIssues, validate } from './schema.ts';

/** Options for `checkSimulation` and `runSimulationConformance`. */
export type SimulationConformanceOptions<State, Input, Config> = {
  /** A name for reports and the vitest `describe` block. */
  readonly name?: string;
  /** The game id written into replays. Default "test-game". */
  readonly gameId?: string;
  /** The configs to start from; each runs `runs` times with different seeds. */
  readonly configs: readonly Config[];
  /** Runs per config. Default 4. */
  readonly runs?: number;
  /** Ticks per run (a run also stops at its outcome). Default 1000. */
  readonly ticks?: number;
  /** The base seed. Run `r` of config `c` uses the seed string `${seed}/${c}/${r}`. Default "conformance". */
  readonly seed?: string;
  /** Scripted inputs for a tick. Draw any randomness from `rng`. Default: no inputs. */
  readonly inputs?: (state: State, tick: number, rng: Rng) => readonly Input[];
  /** Called on every state the simulation reaches. */
  readonly invariants?: (state: State) => InvariantResult;
  /** Fail a run that has no outcome after `ticks` ticks. Default false. */
  readonly requireOutcome?: boolean;
  /** The tick of the checkpoint in the checkpoint-equivalence check. Default half the run. */
  readonly checkpointAt?: number;
  /** Fail when the mean step takes longer than this many milliseconds. Off by default. */
  readonly stepBudgetMs?: number;
  /** Run only one run, to reproduce a reported failure (`setup` is the config index). */
  readonly only?: { readonly setup: number; readonly game: number };
  /** Failures kept per check in the report. Default 3. */
  readonly maxFailuresPerCheck?: number;
};

/** The checks this suite runs, in report order. */
export const SIMULATION_CHECKS = [
  { id: 'determinism', title: 'Determinism: the same seed and tick inputs give the same states and events' },
  { id: 'replay', title: 'Replay: the recorded tick log reproduces the final state' },
  { id: 'checkpoint', title: 'Checkpoints: saving, restoring and continuing equals running straight through' },
  { id: 'json', title: 'JSON safety of configs, states, inputs, events and outcomes' },
  { id: 'schemas', title: "Schema agreement: every value passes the simulation's own schemas" },
  {
    id: 'purity',
    title: 'Step purity: the same state, inputs and generator give the same next state, without mutation',
  },
  { id: 'invariants', title: 'Invariants hold on every state the simulation reaches' },
  { id: 'outcome', title: 'Outcomes are valid and detected in time' },
  { id: 'budget', title: 'Step-time budget' },
] as const;

/** The id of one simulation check. */
export type SimulationCheckId = (typeof SIMULATION_CHECKS)[number]['id'];

const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? 0;

const outcomeProblem = (outcome: Outcome): string | null => {
  if (!['won', 'lost', 'draw', 'completed', 'abandoned'].includes(outcome.result))
    return `unknown result ${show(outcome.result)}`;
  if (typeof outcome.summary !== 'string') return 'summary must be a string';
  if (outcome.elapsedMs !== undefined || outcome.undosUsed !== undefined || outcome.assists !== undefined) {
    return 'simulations never set elapsedMs, undosUsed or assists; the scheduler adds them';
  }
  if (outcome.placements.length === 0) return 'placements is empty; a solo game has one entry';
  for (const p of outcome.placements) {
    if (!Number.isInteger(p.place) || p.place < 1)
      return `seat ${p.seat} has place ${show(p.place)}; places start at 1`;
  }
  if (new Set(outcome.placements.map((p) => p.seat)).size !== outcome.placements.length)
    return 'a seat is placed twice';
  return null;
};

/**
 * Runs the Layer 3 conformance suite against `simulation` and returns a report. It never
 * throws for a failing check. Use `runSimulationConformance` to get one vitest case per check.
 */
export const checkSimulation = async <
  State extends Json,
  Input extends Json,
  View,
  Event extends Json,
  Config extends Json,
>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  options: SimulationConformanceOptions<State, Input, Config>,
): Promise<ConformanceReport> => {
  if (options.configs.length === 0) throw new TypeError('Simulation conformance needs at least one config.');
  const rec = new Recorder(SIMULATION_CHECKS, options.maxFailuresPerCheck ?? 3);
  const runs = options.runs ?? 4;
  const ticks = options.ticks ?? 1000;
  const baseSeed = options.seed ?? 'conformance';
  const gameId = options.gameId ?? 'test-game';
  if (options.invariants === undefined) rec.skip('invariants', 'no invariants hook given');
  if (options.stepBudgetMs === undefined) rec.skip('budget', 'no stepBudgetMs given');

  const validations: Promise<void>[] = [];
  const checkSchema = (
    schema: Validator<unknown>,
    value: unknown,
    what: string,
    fail: (message: string) => void,
  ): void => {
    rec.ran('schemas');
    validations.push(
      validate(schema, value).then(
        (result) => {
          if (!result.ok) fail(`${what} fails its schema: ${formatIssues(result.issues)}; value ${show(value)}`);
        },
        (error: unknown) => fail(`${what}: the schema threw ${errorMessage(error)}`),
      ),
    );
  };

  let totalRuns = 0;
  let totalTicks = 0;
  let stepTime = 0;
  let stepCount = 0;

  for (const [configIndex, config] of options.configs.entries()) {
    rec.ran('json');
    if (!isJson(config))
      rec.fail('json', { message: `config ${configIndex} isn't JSON: ${jsonProblem(config)}`, setup: configIndex });
    checkSchema(simulation.schemas.config, config, `config ${configIndex}`, (message) =>
      rec.fail('schemas', { message, setup: configIndex }),
    );

    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      if (options.only !== undefined && (options.only.setup !== configIndex || options.only.game !== runIndex))
        continue;
      totalRuns += 1;
      const seed = `${baseSeed}/${configIndex}/${runIndex}`;
      const seedState = testSeed(seed, 'engine');
      const driver = testRng(seed, 'driver');
      const log: TickInput<Input>[] = [];
      const states: State[] = [];
      const rngs: RngState[] = [];
      const results: StepResult<State, Event>[] = [];

      const replayUpTo = (endTick: number) =>
        simulationReplay({
          gameId,
          rulesVersion: simulation.rulesVersion,
          config,
          seed: seedState,
          inputs: log.filter((entry) => entry.tick < endTick),
          endTick,
        });
      const fail = (id: SimulationCheckId, message: string, tick: number, input?: unknown): void => {
        const failure: Failure = {
          message,
          setup: configIndex,
          game: runIndex,
          seed,
          step: tick,
          replay: replayUpTo(tick),
          ...(input === undefined ? {} : { input }),
        };
        rec.fail(id, failure);
      };

      const rng = restoreRng(seedState);
      let started: ReturnType<typeof simulation.init>;
      try {
        started = simulation.init(config, rng);
      } catch (error) {
        fail('purity', `init threw: ${errorMessage(error)}`, 0);
        continue;
      }
      if (!started.ok) {
        fail('outcome', `init rejected config ${configIndex}: ${show(started.error)}`, 0);
        continue;
      }
      let state = deepFreeze(started.value);
      let outcome: Outcome | null = null;
      let tick = 0;

      const checkState = (value: State, at: number): void => {
        rec.ran('json');
        if (!isJson(value)) fail('json', `the state isn't JSON: ${jsonProblem(value)}`, at);
        checkSchema(simulation.schemas.state, value, 'the state', (m) => fail('schemas', m, at));
        if (options.invariants !== undefined) {
          rec.ran('invariants');
          try {
            const result = options.invariants(value);
            if (result === false || typeof result === 'string') {
              fail(
                'invariants',
                `invariant violated: ${result === false ? 'the invariant hook returned false' : result}`,
                at,
              );
            }
          } catch (error) {
            fail('invariants', `invariant violated: ${errorMessage(error)}`, at);
          }
        }
      };
      const findOutcome = (value: State, at: number): Outcome | null => {
        const found = simulation.outcome(value);
        if (found !== null) {
          rec.ran('outcome');
          if (!isJson(found)) fail('json', `the outcome isn't JSON: ${jsonProblem(found)}`, at);
          const problem = outcomeProblem(found);
          if (problem !== null) fail('outcome', `invalid outcome: ${problem}; outcome ${show(found)}`, at);
        }
        return found;
      };

      checkState(state, 0);
      outcome = findOutcome(state, 0);
      let broken = false;
      for (; tick < ticks && outcome === null; tick += 1) {
        states.push(state);
        rngs.push(rng.save());
        let inputs: readonly Input[] = [];
        try {
          inputs = deepFreeze([...(options.inputs?.(state, tick, driver) ?? [])]);
        } catch (error) {
          fail('purity', `the inputs generator threw: ${errorMessage(error)}`, tick);
        }
        for (const input of inputs) {
          rec.ran('json');
          if (!isJson(input)) fail('json', `an input isn't JSON: ${jsonProblem(input)}`, tick, input);
          checkSchema(simulation.schemas.input, input, 'an input', (m) => fail('schemas', m, tick, input));
          log.push({ tick, input });
        }

        // Purity: a trial step on a copy of the generator, then the real one; they must agree.
        let trial: StepResult<State, Event> | null = null;
        const trialRng = cloneRng(rng);
        try {
          trial = simulation.step(state, inputs, trialRng);
        } catch (error) {
          const message = errorMessage(error);
          const mutation = /read[- ]only|not extensible|frozen|Cannot (assign|add|delete|define)/i.test(message);
          fail(
            'purity',
            mutation ? `step mutated its input (states and inputs are frozen): ${message}` : `step threw: ${message}`,
            tick,
          );
          broken = true;
          break;
        }
        let result: StepResult<State, Event>;
        const t0 = now();
        try {
          result = deepFreeze(simulation.step(state, inputs, rng));
        } catch (error) {
          fail('purity', `step threw on a second call with the same arguments: ${errorMessage(error)}`, tick);
          broken = true;
          break;
        }
        stepTime += now() - t0;
        stepCount += 1;
        rec.ran('purity');
        const diff = firstDifference(trial, result) ?? firstDifference(trialRng.save(), rng.save());
        if (diff !== null)
          fail('purity', `step gave two different answers for the same state, inputs and generator: ${diff}`, tick);

        rec.ran('json');
        if (!isJson(result)) fail('json', `a step result isn't JSON: ${jsonProblem(result)}`, tick);
        for (const event of result.events ?? [])
          checkSchema(simulation.schemas.event, event, 'an event', (m) => fail('schemas', m, tick));
        results.push(result);
        state = result.state;
        checkState(state, tick + 1);
        outcome = findOutcome(state, tick + 1);
      }
      totalTicks += tick;
      if (broken) continue;
      states.push(state);
      rngs.push(rng.save());
      if (outcome === null && options.requireOutcome === true) {
        rec.ran('outcome');
        fail('outcome', `no outcome after ${ticks} ticks (raise ticks, or drop requireOutcome)`, tick);
      }
      const endTick = tick;
      const final = state;
      const inputsAt = (t: number): Input[] => log.filter((entry) => entry.tick === t).map((entry) => entry.input);

      // Determinism: a second run from the same seed with the recorded inputs.
      {
        rec.ran('determinism');
        try {
          const again = restoreRng(seedState);
          const init = simulation.init(config, again);
          let current = init.ok ? init.value : null;
          const initDiff = init.ok ? firstDifference(states[0], init.value) : 'init rejected';
          if (initDiff !== null) fail('determinism', `init gave a different state for the same seed: ${initDiff}`, 0);
          for (let t = 0; t < endTick && current !== null && initDiff === null; t += 1) {
            const result = simulation.step(current, inputsAt(t), again);
            const d = firstDifference(results[t], result) ?? firstDifference(rngs[t + 1], again.save());
            if (d !== null) {
              fail('determinism', `a second run from the same seed diverged at tick ${t}: ${d}`, t);
              break;
            }
            current = result.state;
          }
        } catch (error) {
          fail('determinism', `a second run threw: ${errorMessage(error)}`, 0);
        }
      }

      // Replay through the replay format, after a JSON round trip.
      {
        rec.ran('replay');
        const replay = replayUpTo(endTick);
        if (!isJson(replay)) fail('replay', "the replay isn't JSON", endTick);
        else {
          try {
            const result = replaySimulation(simulation, jsonRoundTrip(replay));
            if (!result.ok) fail('replay', `the replay doesn't start: ${show(result.error)}`, endTick);
            else {
              const d = firstDifference(final, result.value.state) ?? firstDifference(outcome, result.value.outcome);
              if (d !== null) fail('replay', `the replay ends somewhere else: ${d}`, endTick);
            }
            // The session scheduler's own replay.
            const runner = runnerReplaySimulation(simulation, jsonRoundTrip(replay));
            if (!runner.ok) fail('replay', `the session runner's replay doesn't start: ${show(runner.error)}`, endTick);
            else {
              const d = firstDifference(final, runner.value.state) ?? firstDifference(rngs[endTick], runner.value.rng);
              if (d !== null) fail('replay', `the session runner's replay ends somewhere else: ${d}`, endTick);
            }
          } catch (error) {
            fail('replay', `replaying threw: ${errorMessage(error)}`, endTick);
          }
        }
      }

      // Checkpoint equivalence: save at a tick, restore after JSON, run the rest.
      {
        rec.ran('checkpoint');
        const k = Math.min(options.checkpointAt ?? Math.floor(endTick / 2), endTick);
        const checkpoint = { state: states[k], rng: rngs[k], tick: k };
        if (!isJson(checkpoint)) fail('checkpoint', "the checkpoint isn't JSON", k);
        else {
          const restored = jsonRoundTrip(checkpoint);
          const decoded = await validate(simulation.schemas.state, restored.state);
          if (!decoded.ok)
            fail('checkpoint', `a checkpoint state fails schemas.state: ${formatIssues(decoded.issues)}`, k);
          else if (!deepEqual(decoded.value, states[k])) {
            fail(
              'checkpoint',
              `schemas.state changed a valid checkpoint state: ${firstDifference(states[k], decoded.value)}`,
              k,
            );
          } else {
            try {
              const resumed = restoreRng(restored.rng as RngState);
              let current = decoded.value;
              for (let t = k; t < endTick; t += 1) {
                current = simulation.step(current, inputsAt(t), resumed).state;
              }
              const d = firstDifference(final, current);
              if (d !== null)
                fail('checkpoint', `resuming from the checkpoint at tick ${k} ended differently: ${d}`, k);
            } catch (error) {
              fail('checkpoint', `resuming from a checkpoint threw: ${errorMessage(error)}`, k);
            }
          }
        }
      }
    }
  }

  await Promise.all(validations);
  if (options.stepBudgetMs !== undefined && stepCount > 0) {
    rec.ran('budget');
    const mean = stepTime / stepCount;
    if (mean > options.stepBudgetMs) {
      rec.fail('budget', {
        message: `the mean step took ${mean.toFixed(3)} ms, over the ${options.stepBudgetMs} ms budget`,
      });
    } else {
      rec.note('budget', `mean step ${mean.toFixed(3)} ms`);
    }
  }
  return rec.report(options.name ?? 'simulation', totalRuns, totalTicks);
};
