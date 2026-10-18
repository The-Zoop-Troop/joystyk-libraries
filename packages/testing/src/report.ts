// Conformance reports: what was checked, what failed, and how to reproduce each failure.

import type { Replay } from '@joystyk/contracts';

/** One reproducible failure. */
export type Failure = {
  readonly message: string;
  /** Which generated game failed: rerun just it with `only: { setup, game }`. */
  readonly setup?: number;
  readonly game?: number;
  /** The game's seed string; the engine's generator is `testRng(seed, 'engine')`. */
  readonly seed?: string;
  /** The number of inputs applied before the failure (0: right after `init`). */
  readonly step?: number;
  /** The replay of the accepted inputs up to the failure; `replayEngine` reproduces it. */
  readonly replay?: Replay;
  /** The input being checked when the failure happened, if any. */
  readonly input?: unknown;
};

export type CheckStatus = 'passed' | 'failed' | 'skipped';

/** The result of one check across every generated game. */
export type CheckResult = {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** Why the check was skipped, or a note on what it covered. */
  readonly note?: string;
  /** How many times the check ran (positions, transitions, games …). */
  readonly runs: number;
  /** The first few failures; `failureCount` has the total. */
  readonly failures: readonly Failure[];
  readonly failureCount: number;
};

/** Everything a suite found. */
export type ConformanceReport = {
  readonly subject: string;
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  /** Games generated and inputs applied, for a sense of coverage. */
  readonly games: number;
  readonly steps: number;
};

/** The failed checks' ids. */
export const failedChecks = (report: ConformanceReport): string[] =>
  report.checks.filter((c) => c.status === 'failed').map((c) => c.id);

/** One check by id; throws if the suite has no such check. */
export const checkById = (report: ConformanceReport, id: string): CheckResult => {
  const check = report.checks.find((c) => c.id === id);
  if (check === undefined) throw new Error(`No check "${id}" in the report for ${report.subject}.`);
  return check;
};

/** A failure as text a person can act on: what broke, the seed, and the input sequence. */
export const formatFailure = (failure: Failure): string => {
  const lines = [failure.message];
  const where: string[] = [];
  if (failure.setup !== undefined) where.push(`setup ${failure.setup}`);
  if (failure.game !== undefined) where.push(`game ${failure.game}`);
  if (failure.seed !== undefined) where.push(`seed "${failure.seed}"`);
  if (failure.step !== undefined) where.push(`after ${failure.step} input${failure.step === 1 ? '' : 's'}`);
  if (where.length > 0) lines.push(`  at: ${where.join(', ')}`);
  if (failure.setup !== undefined && failure.game !== undefined) {
    lines.push(
      `  rerun only this game: add \`only: { setup: ${failure.setup}, game: ${failure.game} }\` to the options`,
    );
  }
  if (failure.input !== undefined) lines.push(`  input: ${JSON.stringify(failure.input)}`);
  if (failure.replay !== undefined) lines.push(`  replay: ${JSON.stringify(failure.replay)}`);
  return lines.join('\n');
};

/** A check as text: its title, status and failures. */
export const formatCheck = (check: CheckResult): string => {
  const head = `[${check.id}] ${check.title}: ${check.status}${check.note === undefined ? '' : ` (${check.note})`}`;
  if (check.status !== 'failed') return head;
  const more = check.failureCount - check.failures.length;
  return [
    `${head}, ${check.failureCount} failure${check.failureCount === 1 ? '' : 's'}`,
    ...check.failures.map((f, i) => `\n#${i + 1} ${formatFailure(f)}`),
    ...(more > 0 ? [`\n… and ${more} more`] : []),
  ].join('\n');
};

/** The whole report as text. */
export const formatReport = (report: ConformanceReport): string =>
  [
    `${report.subject}: ${report.ok ? 'conforms' : 'FAILS'} (${report.games} games, ${report.steps} inputs)`,
    ...report.checks.map(formatCheck),
  ].join('\n');

/** Collects failures per check while a suite runs. */
export class Recorder {
  readonly #limit: number;
  readonly #checks = new Map<
    string,
    { title: string; runs: number; failures: Failure[]; count: number; skip?: string; note?: string }
  >();

  constructor(definitions: readonly { readonly id: string; readonly title: string }[], limit: number) {
    this.#limit = limit;
    for (const { id, title } of definitions) this.#checks.set(id, { title, runs: 0, failures: [], count: 0 });
  }

  #get(id: string) {
    const check = this.#checks.get(id);
    if (check === undefined) throw new Error(`Unknown check "${id}".`);
    return check;
  }

  /** Counts one run of a check. */
  ran(id: string, times = 1): void {
    this.#get(id).runs += times;
  }

  /** Records a failure of a check. */
  fail(id: string, failure: Failure): void {
    const check = this.#get(id);
    check.count += 1;
    if (check.failures.length < this.#limit) check.failures.push(failure);
  }

  /** How many failures a check has so far. */
  failures(id: string): number {
    return this.#get(id).count;
  }

  /** Marks a check as skipped, with the reason. */
  skip(id: string, reason: string): void {
    this.#get(id).skip = reason;
  }

  /** Adds a note to a check's result. */
  note(id: string, note: string): void {
    this.#get(id).note = note;
  }

  report(subject: string, games: number, steps: number): ConformanceReport {
    const checks: CheckResult[] = [...this.#checks].map(([id, c]) => {
      const skip = c.skip ?? (c.runs === 0 ? 'nothing to check in the generated games' : undefined);
      const status: CheckStatus = c.count > 0 ? 'failed' : skip !== undefined ? 'skipped' : 'passed';
      const note = status === 'skipped' ? skip : c.note;
      return {
        id,
        title: c.title,
        status,
        ...(note === undefined ? {} : { note }),
        runs: c.runs,
        failures: c.failures,
        failureCount: c.count,
      };
    });
    return { subject, ok: checks.every((c) => c.status !== 'failed'), checks, games, steps };
  }
}
