// The vitest face of the suites: one `it` per check, each failing with a reproducible report.

import type { DiscreteEngine, FixedStepSimulation, Json } from '@joystyk/contracts';
import { describe, it } from 'vitest';
import { checkEngine, ENGINE_CHECKS, type EngineConformanceOptions } from './engine-conformance.ts';
import { checkById, formatCheck, formatReport, type ConformanceReport } from './report.ts';
import { checkSimulation, SIMULATION_CHECKS, type SimulationConformanceOptions } from './simulation-conformance.ts';

/** Options the vitest wrappers add. */
export type VitestOptions = {
  /**
   * Timeout for each case in milliseconds. The suite plays its games once, in the first case,
   * so that case takes all the time: over a minute for the heaviest games on a loaded machine.
   * Default 300 000.
   */
  readonly timeoutMs?: number;
};

const CASE_TIMEOUT_MS = 300_000;

/** Thrown by a failing conformance case; its message is the check's report. */
export class ConformanceError extends Error {
  override readonly name = 'ConformanceError';
}

/** Throws a `ConformanceError` with the whole report unless every check passed or was skipped. */
export const expectConformance = (report: ConformanceReport): void => {
  if (!report.ok) throw new ConformanceError(formatReport(report));
};

const register = (
  subject: string,
  checks: readonly { readonly id: string; readonly title: string }[],
  run: () => Promise<ConformanceReport>,
  timeoutMs: number,
): void => {
  describe(`conformance: ${subject}`, () => {
    let report: Promise<ConformanceReport> | undefined;
    for (const check of checks) {
      it(
        `[${check.id}] ${check.title}`,
        async (context) => {
          report ??= run();
          const result = checkById(await report, check.id);
          if (result.status === 'skipped') {
            context.skip(result.note);
            return;
          }
          if (result.status === 'failed') throw new ConformanceError(formatCheck(result));
        },
        timeoutMs,
      );
    }
  });
};

/**
 * Registers the Layer 2 conformance suite as vitest cases: a `describe` block with one `it`
 * per check. The suite plays its games once, in whichever case runs first; a failing case
 * prints the failures with their seeds and input sequences. Call it at the top level of a
 * test file:
 *
 * ```ts
 * runEngineConformance(engine, { configs: [{ heap: 10 }], seatCounts: [2], commands });
 * ```
 */
export const runEngineConformance = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  options: EngineConformanceOptions<State, Command, Config> & VitestOptions,
): void =>
  register(
    options.name ?? 'engine',
    ENGINE_CHECKS,
    () => checkEngine(engine, options),
    options.timeoutMs ?? CASE_TIMEOUT_MS,
  );

/** Registers the Layer 3 conformance suite as vitest cases, like `runEngineConformance`. */
export const runSimulationConformance = <
  State extends Json,
  Input extends Json,
  View,
  Event extends Json,
  Config extends Json,
>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  options: SimulationConformanceOptions<State, Input, Config> & VitestOptions,
): void =>
  register(
    options.name ?? 'simulation',
    SIMULATION_CHECKS,
    () => checkSimulation(simulation, options),
    options.timeoutMs ?? CASE_TIMEOUT_MS,
  );
