// The generic daily pipeline (content-pipeline.md): for each game and date, schedule the
// slot's deterministic inputs, generate with the model, then parse, judge and publish.
//
//   schedule ─▶ generate ─▶ schema ─▶ game validators ─▶ blocklist + sensitive list ─▶ model screen ─▶ validated
//                  ▲                                                                                     │
//                  └──────────── up to 3 attempts per item per run, with backoff and feedback ───────────┤
//                                                                                                         ▼
//                         past the deadline and still not validated ─▶ bank item          publish (≤ today + 1)
//
// Runs are idempotent: a slot that is validated or published is left alone, so rerunning a
// day changes nothing, and a run cut short resumes where it stopped. Nothing waits for a
// person (D-44). Every attempt's calls, issues and filter outcomes go into the item's
// report, which is its provenance.
import { err, ok, type Json, type Result, type StandardSchemaV1 } from '@joystyk/contracts';
import { addDays, puzzleId as makePuzzleId, releaseInstant, utcDate } from '@joystyk/daily';
import type { FieldText, FilterHit, WordFilter } from './filter.ts';
import { contentHash, stableIndex } from './hash.ts';
import { silentLogger, type Logger } from './log.ts';
import { ENDPOINT_ERRORS, type CallInfo, type CompletionFailure, type ModelClient } from './model.ts';
import type { Publisher } from './publish.ts';
import { modelScreen, SCREEN_PROMPT_VERSION } from './screen.ts';
import type { ContentStore, ItemRow, WithdrawReason } from './store.ts';

// ---------------------------------------------------------------------------------------------
// What a game supplies

export interface ScheduleContext {
  readonly date: string;
  readonly puzzleId: string;
  /** Answers used or reserved within the requested history window, withdrawn ones included. */
  readonly used: readonly { readonly date: string; readonly answer: string }[];
}

export interface Scheduled<Inputs extends Json> {
  readonly inputs: Inputs;
  readonly seed: string;
  /** The answer key the inputs commit to, if the schedule picks it (Word of the Day's word). */
  readonly answer: string | null;
}

export interface GenerateContext<Inputs extends Json> {
  readonly date: string;
  readonly puzzleId: string;
  readonly inputs: Inputs;
  readonly seed: string;
  /** 1-based, within this run. */
  readonly attempt: number;
  /** What was wrong with the previous attempt, in words the prompt can repeat. Empty on the first. */
  readonly feedback: readonly string[];
  readonly model: ModelClient;
  /** Normalized text keys used on nearby dates, withdrawn content included. */
  readonly recentKeys?: readonly { readonly date: string; readonly key: string }[];
  /** Published reusable catalogs for this game; each generator decodes its own schema. */
  readonly catalogs?: readonly Json[];
  readonly signal?: AbortSignal;
  /**
   * Keeps a game's own check results (for example Crossword's fact-check verdicts) in the
   * attempt's report, under `checks[name]`, whether the attempt passes or fails. A later
   * call with the same name replaces the earlier one. Absent when a test calls `generate`
   * directly.
   */
  readonly record?: (name: string, detail: Json) => void;
}

export type GenerateFailure =
  /** A model call failed: the endpoint, or a reply that didn't parse or match its schema. */
  | { readonly kind: 'model'; readonly error: CompletionFailure }
  /** The game's own model checks refused the draft (for example a blind answer check). */
  | { readonly kind: 'rejected'; readonly issues: readonly string[] };

export interface DailyGenerator<Config extends Json = Json, Inputs extends Json = Json> {
  readonly gameId: string;
  /** Recorded with every item, e.g. "wotd-v1". */
  readonly promptVersion: string;
  /** Scheduling history on either side of the date; defaults to 365 days. */
  readonly historyDays?: number;
  /** Numeric/card/grid configurations with no generated player-visible text. They can
   * publish without a model endpoint; `texts` must be empty. */
  readonly modelFree?: boolean;
  /** Optional additional no-repeat rule, independent of the answer schedule. */
  readonly repeatWindowDays?: number;
  readonly reusesCatalogs?: boolean;
  repeatKeys?(config: Config): readonly string[];
  /** The game's `schemas.config`: every config is decoded through it before anything else. */
  readonly configSchema: StandardSchemaV1<unknown, Config>;
  /** Deterministic inputs for a slot: the same date and history always give the same inputs. */
  schedule(context: ScheduleContext): Scheduled<Inputs>;
  generate(context: GenerateContext<Inputs>): Promise<Result<Config, GenerateFailure>>;
  /** The game validators: pure; an empty list means the config passes. */
  validate(
    config: Config,
    context: { readonly date: string; readonly puzzleId: string; readonly inputs: Inputs | null },
  ): readonly string[];
  /** Every player-visible text, for the all-ages filter and the model screen. */
  texts(config: Config): readonly FieldText[];
  /** The answer key for duplicate checks. */
  answerOf(config: Config): string | null;
  /** The reviewed fallback bank: `size` complete items, each turned into a config for a date. */
  readonly bank: { readonly size: number; config(index: number, puzzleId: string): Config };
}

// ---------------------------------------------------------------------------------------------
// Reports

export interface CallReport {
  readonly name: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly latencyMs: number;
  readonly requests: number;
  readonly mode: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

export type AttemptOutcome =
  | 'validated'
  | 'endpoint'
  | 'reply'
  | 'schema'
  | 'rejected'
  | 'invalid'
  | 'duplicate'
  | 'filtered'
  | 'screened'
  | 'aborted';

export interface AttemptReport {
  readonly attempt: number;
  readonly outcome: AttemptOutcome;
  readonly issues: readonly string[];
  readonly calls: readonly CallReport[];
  /** Null when the attempt never reached the filter. */
  readonly filter: { readonly ok: boolean; readonly hits: readonly FilterHit[] } | null;
  /** Null when the attempt never reached the screen (or screening is off). */
  readonly screen: { readonly safe: boolean; readonly reasons: readonly string[] } | null;
  /** What the game's own checks recorded (`GenerateContext.record`); absent when nothing was. */
  readonly checks?: Readonly<Record<string, Json>>;
}

export type SlotAction = 'existing' | 'generated' | 'bank' | 'failed' | 'deferred' | 'aborted';

export interface SlotReport {
  readonly gameId: string;
  readonly date: string;
  readonly puzzleId: string;
  readonly action: SlotAction;
  readonly status: string;
  readonly source: string | null;
  readonly answer: string | null;
  /** The slot's scheduled inputs (a bank item may replace what they asked for). */
  readonly inputs: Json | null;
  readonly attempts: readonly AttemptReport[];
  readonly contentHash: string | null;
  readonly config: Json | null;
}

export interface PublishReport {
  readonly gameId: string;
  readonly date: string;
  readonly file: string;
  readonly hash: string;
  readonly size: number;
}

export interface RunReport {
  readonly runId: number;
  readonly status: 'ok' | 'partial' | 'failed' | 'aborted';
  readonly today: string;
  readonly slots: readonly SlotReport[];
  readonly published: readonly PublishReport[];
  readonly breakerOpen: boolean;
}

// ---------------------------------------------------------------------------------------------
// The run

export interface PipelineOptions {
  readonly store: ContentStore;
  readonly generators: readonly DailyGenerator[];
  /** Null runs without a model: existing items publish and late slots take bank items. */
  readonly model: ModelClient | null;
  readonly filter: WordFilter;
  /** Null for a dry run: nothing is written to the published-files folder. */
  readonly publisher: Publisher | null;
  readonly now?: () => number;
  /** The dates to fill. Default: today and the next `daysAhead` days. */
  readonly dates?: readonly string[];
  /** Default 1: today and tomorrow (D-46). */
  readonly daysAhead?: number;
  /** Only these games. */
  readonly games?: readonly string[];
  readonly maxAttempts?: number;
  /** Consecutive endpoint errors that end generation for the run. Default 5. */
  readonly breakerThreshold?: number;
  /** A slot not validated this long before its release takes a bank item. Default 48 hours. */
  readonly deadlineHours?: number;
  /** Give a late slot a bank item (default true). `content bank`, which grows the banks, turns it off. */
  readonly bankFallback?: boolean;
  /** The newest date published and listed, as days after today. Default 1 (D-46). */
  readonly listAheadDays?: number;
  /** How many past days the index keeps listing. Default 14. */
  readonly indexBackDays?: number;
  /** Run the model screen (layer 3). Default true. */
  readonly screen?: boolean;
  /** Pause before attempt n + 1 is `backoffMs * 2^(n-1)`. Default 2000. */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  /** Recorded on the run: "schedule", "manual", "live-validation"… */
  readonly trigger?: string;
}

/** @internal Shared with packs.ts. */
export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

/** @internal Shared with packs.ts. */
export const callReport = (call: CallInfo, error: CompletionFailure | null): CallReport => ({
  name: call.name,
  ok: error === null,
  error: error === null ? null : `${error.kind}: ${error.message}`,
  latencyMs: call.latencyMs,
  requests: call.requests,
  mode: call.mode,
  promptTokens: call.usage?.promptTokens ?? null,
  completionTokens: call.usage?.completionTokens ?? null,
  totalTokens: call.usage?.totalTokens ?? null,
});

/** Wraps a model client so every call, successful or not, lands in `calls`. */
/** @internal Shared with packs.ts. */
export const recording = (model: ModelClient, calls: CallReport[]): ModelClient => ({
  model: model.model,
  complete: async (request) => {
    const result = await model.complete(request);
    calls.push(result.ok ? callReport(result.value.call, null) : callReport(result.error.call, result.error));
    return result;
  },
});

/** @internal Shared with packs.ts. */
export const outcomeOf = (error: CompletionFailure): AttemptOutcome =>
  error.kind === 'aborted'
    ? 'aborted'
    : ENDPOINT_ERRORS.has(error.kind)
      ? 'endpoint'
      : error.kind === 'schema'
        ? 'schema'
        : 'reply';

/** @internal Shared with packs.ts. */
export const issuesOf = (error: CompletionFailure): string[] => [error.message, ...(error.issues ?? [])];

/** @internal Shared with packs.ts. */
export const decodeConfig = async <Config>(
  schema: StandardSchemaV1<unknown, Config>,
  value: unknown,
): Promise<Result<Config, string[]>> => {
  const result = await schema['~standard'].validate(value);
  if (result.issues === undefined) return ok(result.value);
  return err(
    result.issues.map((issue) => {
      const path = (issue.path ?? [])
        .map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)))
        .join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    }),
  );
};

/** Answers within the generator’s window, other than this slot’s non-withdrawn item. */
const usedNear = (store: ContentStore, gameId: string, date: string, puzzleId: string, days = 365) =>
  store
    .usedAnswers(gameId, addDays(date, -days), addDays(date, days))
    .filter((row) => makePuzzleId(gameId, row.date) !== puzzleId || row.status === 'withdrawn');

/** Nearby text keys decoded through the game schema; corrections on the same date may retain clues. */
export const recentContentKeys = async (
  store: ContentStore,
  generator: DailyGenerator,
  date: string,
): Promise<{ date: string; key: string }[]> => {
  if (generator.repeatKeys === undefined || generator.repeatWindowDays === undefined) return [];
  const out: { date: string; key: string }[] = [];
  for (const row of store.versions(
    generator.gameId,
    addDays(date, -generator.repeatWindowDays),
    addDays(date, generator.repeatWindowDays),
  )) {
    if (row.date === date || row.config === null) continue;
    const config = await decodeConfig(generator.configSchema, row.config);
    if (!config.ok)
      throw new Error(`Cannot check repeat history: stored ${row.puzzleId} version ${String(row.id)} is malformed.`);
    for (const key of generator.repeatKeys(config.value)) out.push({ date: row.date, key });
  }
  return out;
};

/**
 * Checks a config the way every item is checked: the schema, the game validators, the
 * duplicate rule and the word lists. The model screen is separate (it needs the endpoint).
 */
export const checkDailyConfig = async (
  generator: DailyGenerator,
  value: unknown,
  context: {
    date: string;
    puzzleId: string;
    inputs: Json | null;
    used: readonly { date: string; answer: string }[];
    filter: WordFilter;
    recentKeys?: readonly { date: string; key: string }[];
  },
): Promise<{ outcome: AttemptOutcome; issues: string[]; config: Json | null; filter: AttemptReport['filter'] }> => {
  const decoded = await decodeConfig(generator.configSchema, value);
  if (!decoded.ok) return { outcome: 'schema', issues: decoded.error, config: null, filter: null };
  const config = decoded.value;
  if (generator.modelFree === true && generator.texts(config).length > 0)
    return {
      outcome: 'invalid',
      issues: ['A model-free generator must contain no generated player-visible text.'],
      config,
      filter: null,
    };
  const issues = [
    ...generator.validate(config, { date: context.date, puzzleId: context.puzzleId, inputs: context.inputs }),
  ];
  if (issues.length > 0) return { outcome: 'invalid', issues, config, filter: null };
  const answer = generator.answerOf(config);
  const clash = answer === null ? undefined : context.used.find((row) => row.answer === answer);
  if (clash !== undefined)
    return { outcome: 'duplicate', issues: [`The answer was already used on ${clash.date}.`], config, filter: null };
  const repeat = generator
    .repeatKeys?.(config)
    .map((key) => context.recentKeys?.find((row) => row.key === key))
    .find((row) => row !== undefined);
  if (repeat !== undefined)
    return {
      outcome: 'duplicate',
      issues: [`Puzzle text was already used on ${repeat.date}: "${repeat.key}".`],
      config,
      filter: null,
    };
  const filtered = context.filter.check(generator.texts(config));
  if (!filtered.ok) {
    const words = [...new Set(filtered.hits.map((hit) => hit.term))].join(', ');
    return {
      outcome: 'filtered',
      issues: [
        `Text in ${[...new Set(filtered.hits.map((hit) => hit.path))].join(', ')} touches a topic or word that isn't allowed (${words}).`,
      ],
      config,
      filter: filtered,
    };
  }
  return { outcome: 'validated', issues: [], config, filter: filtered };
};

export const runPipeline = async (options: PipelineOptions): Promise<RunReport> => {
  const { store, filter, publisher } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? silentLogger;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const breakerThreshold = options.breakerThreshold ?? 5;
  const deadlineMs = (options.deadlineHours ?? 48) * 3_600_000;
  const backoffMs = options.backoffMs ?? 2000;
  const screenOn = options.screen ?? true;
  const signal = options.signal;
  const today = utcDate(now());
  const listThrough = addDays(today, options.listAheadDays ?? 1);
  const dates = options.dates ?? Array.from({ length: (options.daysAhead ?? 1) + 1 }, (_, i) => addDays(today, i));
  const generators = options.generators
    .filter((g) => options.games === undefined || options.games.includes(g.gameId))
    .map((generator) => withDailyBank(store, generator));
  const runId = store.startRun(options.trigger ?? 'manual', now());
  log.info('run_started', {
    runId,
    today,
    dates,
    games: generators.map((g) => g.gameId),
    model: options.model?.model ?? null,
    dryRun: publisher === null,
  });

  let consecutiveEndpointErrors = 0;
  let breakerOpen = false;
  let aborted = false;
  const slots: SlotReport[] = [];
  const published: PublishReport[] = [];

  const slotReport = (
    row: ItemRow | null,
    base: { gameId: string; date: string; puzzleId: string },
    action: SlotAction,
    attempts: AttemptReport[],
  ): SlotReport => ({
    ...base,
    action,
    status: row?.status ?? 'none',
    source: row?.source ?? null,
    answer: row?.answer ?? null,
    inputs: row?.inputs ?? null,
    attempts,
    contentHash: row?.contentHash ?? null,
    config: row?.config ?? null,
  });

  const useBank = async (
    generator: DailyGenerator,
    row: ItemRow,
    base: { gameId: string; date: string; puzzleId: string },
  ): Promise<ItemRow | null> => {
    const used = usedNear(store, generator.gameId, base.date, base.puzzleId, generator.historyDays);
    const usedSet = new Set(used.map((u) => u.answer));
    const size = generator.bank.size;
    const start = stableIndex(base.puzzleId, size);
    for (let k = 0; k < size; k++) {
      const index = (start + k) % size;
      const candidate = generator.bank.config(index, base.puzzleId);
      const answer = generator.answerOf(candidate);
      if (answer !== null && usedSet.has(answer)) continue;
      const verdict = await checkDailyConfig(generator, candidate, {
        ...base,
        inputs: null,
        used,
        filter,
        recentKeys: await recentContentKeys(store, generator, base.date),
      });
      if (verdict.outcome !== 'validated' || verdict.config === null) {
        log.warn('bank_item_rejected', {
          puzzleId: base.puzzleId,
          index,
          outcome: verdict.outcome,
          issues: verdict.issues,
        });
        continue;
      }
      log.warn('bank_used', { puzzleId: base.puzzleId, index, answer });
      return store.updateItem(
        row.id,
        {
          status: 'validated',
          source: 'bank',
          answer,
          config: verdict.config,
          contentHash: contentHash(verdict.config),
          model: null,
          promptVersion: `bank:${String(index)}`,
        },
        now(),
        { kind: 'bank', detail: { index } },
      );
    }
    log.error('bank_exhausted', { puzzleId: base.puzzleId, size });
    return null;
  };

  const fillSlot = async (generator: DailyGenerator, date: string): Promise<SlotReport> => {
    const puzzleId = makePuzzleId(generator.gameId, date);
    const base = { gameId: generator.gameId, date, puzzleId };
    let row = store.current(puzzleId);
    if (row !== null && (row.status === 'validated' || row.status === 'published'))
      return slotReport(row, base, 'existing', []);

    if (row === null) {
      const scheduled = generator.schedule({
        date,
        puzzleId,
        used: usedNear(store, generator.gameId, date, puzzleId, generator.historyDays),
      });
      row = store.createItem({
        gameId: generator.gameId,
        puzzleId,
        date,
        inputs: scheduled.inputs,
        seed: scheduled.seed,
        answer: scheduled.answer,
        now: now(),
      });
    }
    const attempts: AttemptReport[] = [];
    const pastDeadline = now() >= releaseInstant(date) - deadlineMs;
    const model: ModelClient | null =
      generator.modelFree === true
        ? {
            model: 'deterministic',
            complete: async () =>
              err({
                kind: 'network',
                message: 'A model-free generator must not call a model.',
                call: {
                  name: 'forbidden',
                  latencyMs: 0,
                  requests: 0,
                  mode: 'json_schema',
                  finishReason: null,
                  usage: null,
                },
              }),
          }
        : options.model;

    if (model !== null && (!breakerOpen || generator.modelFree === true)) {
      row = store.updateItem(
        row.id,
        { status: 'generating', model: model.model, promptVersion: generator.promptVersion },
        now(),
      );
      let feedback: string[] = [];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (signal?.aborted === true) {
          aborted = true;
          break;
        }
        if (attempt > 1) await sleep(backoffMs * 2 ** (attempt - 2), signal);
        const calls: CallReport[] = [];
        const recorded = recording(model, calls);
        const checks: Record<string, Json> = {};
        const finish = (report: Omit<AttemptReport, 'attempt' | 'calls' | 'checks'>): AttemptReport => {
          const full: AttemptReport = {
            attempt,
            calls,
            ...report,
            ...(Object.keys(checks).length > 0 ? { checks } : {}),
          };
          attempts.push(full);
          log.info('attempt', {
            puzzleId,
            attempt,
            outcome: full.outcome,
            issues: full.issues.slice(0, 8),
            calls: calls.map((c) => ({ name: c.name, ok: c.ok, ms: c.latencyMs, tokens: c.totalTokens })),
          });
          return full;
        };
        const generated = await generator.generate({
          date,
          puzzleId,
          inputs: row.inputs ?? {},
          seed: row.seed ?? puzzleId,
          attempt,
          feedback,
          model: recorded,
          recentKeys: await recentContentKeys(store, generator, date),
          catalogs:
            generator.reusesCatalogs === true
              ? store
                  .versions(generator.gameId, '0000-01-01', '9999-12-31')
                  .filter(
                    (item) =>
                      item.status === 'published' &&
                      item.puzzleId.startsWith(`${generator.gameId}:pack:`) &&
                      item.config !== null,
                  )
                  .map((item) => item.config as Json)
              : [],
          record: (name, detail) => {
            checks[name] = detail;
          },
          ...(signal === undefined ? {} : { signal }),
        });
        if (!generated.ok) {
          const failure = generated.error;
          const outcome = failure.kind === 'model' ? outcomeOf(failure.error) : 'rejected';
          const issues = failure.kind === 'model' ? issuesOf(failure.error) : [...failure.issues];
          finish({ outcome, issues, filter: null, screen: null });
          if (outcome === 'aborted') {
            aborted = true;
            break;
          }
          if (outcome === 'endpoint') {
            consecutiveEndpointErrors++;
            if (consecutiveEndpointErrors >= breakerThreshold) {
              breakerOpen = true;
              log.error('circuit_breaker_open', { consecutiveEndpointErrors });
              break;
            }
          } else consecutiveEndpointErrors = 0;
          feedback = outcome === 'endpoint' ? feedback : issues;
          continue;
        }
        consecutiveEndpointErrors = 0;
        const used = usedNear(store, generator.gameId, date, puzzleId, generator.historyDays);
        const verdict = await checkDailyConfig(generator, generated.value, {
          date,
          puzzleId,
          inputs: row.inputs,
          used,
          filter,
          recentKeys: await recentContentKeys(store, generator, date),
        });
        if (verdict.outcome !== 'validated' || verdict.config === null) {
          finish({ outcome: verdict.outcome, issues: verdict.issues, filter: verdict.filter, screen: null });
          feedback = verdict.issues;
          continue;
        }
        let screen: AttemptReport['screen'] = null;
        if (screenOn && generator.texts(verdict.config).length > 0) {
          const screened = await modelScreen(recorded, generator.texts(verdict.config), signal);
          if (!screened.ok) {
            const outcome = outcomeOf(screened.error);
            finish({ outcome, issues: issuesOf(screened.error), filter: verdict.filter, screen: null });
            if (outcome === 'aborted') {
              aborted = true;
              break;
            }
            if (outcome === 'endpoint' && ++consecutiveEndpointErrors >= breakerThreshold) {
              breakerOpen = true;
              log.error('circuit_breaker_open', { consecutiveEndpointErrors });
              break;
            }
            continue;
          }
          screen = { safe: screened.value.verdict.safe, reasons: screened.value.verdict.reasons };
          if (!screen.safe) {
            const reasons = screen.reasons.length > 0 ? screen.reasons : ['The safety screen refused the text.'];
            finish({
              outcome: 'screened',
              issues: reasons.map((reason) => `Safety screen: ${reason}`),
              filter: verdict.filter,
              screen,
            });
            feedback = reasons.map((reason) => `A safety reviewer objected: ${reason}`);
            continue;
          }
        }
        const report = finish({ outcome: 'validated', issues: [], filter: verdict.filter, screen });
        row = store.updateItem(
          row.id,
          {
            status: 'validated',
            source: 'generated',
            answer: generator.answerOf(verdict.config),
            config: verdict.config,
            contentHash: contentHash(verdict.config),
            attempts: row.attempts + attempts.length,
            report: [...((row.report as Json[] | null) ?? []), ...attempts.map((a) => a as unknown as Json)],
          },
          now(),
          {
            kind: 'validated',
            detail: { attempt: report.attempt, screen: screen === null ? null : SCREEN_PROMPT_VERSION },
          },
        );
        return slotReport(row, base, 'generated', attempts);
      }
    }

    const history = [...((row.report as Json[] | null) ?? []), ...attempts.map((a) => a as unknown as Json)];
    if (aborted) {
      row = store.updateItem(
        row.id,
        { status: 'scheduled', attempts: row.attempts + attempts.length, report: history },
        now(),
        { kind: 'interrupted' },
      );
      return slotReport(row, base, 'aborted', attempts);
    }
    row = store.updateItem(
      row.id,
      { status: 'failed', attempts: row.attempts + attempts.length, report: history },
      now(),
      attempts.length > 0 ? { kind: 'failed', detail: { attempts: attempts.length } } : undefined,
    );
    if (!pastDeadline || options.bankFallback === false) {
      log.warn('slot_deferred', { puzzleId, attempts: attempts.length, breakerOpen });
      return slotReport(row, base, attempts.length > 0 ? 'failed' : 'deferred', attempts);
    }
    const banked = await useBank(generator, row, base);
    if (banked === null) return slotReport(row, base, 'failed', attempts);
    return slotReport(banked, base, 'bank', attempts);
  };

  for (const generator of generators) {
    for (const date of [...dates].sort()) {
      if (signal?.aborted === true) {
        aborted = true;
        break;
      }
      const report = await fillSlot(generator, date);
      slots.push(report);
      log.info('slot', {
        puzzleId: report.puzzleId,
        action: report.action,
        status: report.status,
        source: report.source,
        attempts: report.attempts.length,
      });
      if (aborted) break;
    }
    if (aborted) break;
  }

  // Publish what is due (even after an interruption: those items are already validated).
  if (publisher !== null) {
    for (const generator of generators) {
      for (const row of store.validatedThrough(generator.gameId, listThrough)) {
        if (row.config === null) continue;
        const file = publisher.writePuzzle(generator.gameId, row.date, row.config);
        store.updateItem(
          row.id,
          { status: 'published', contentHash: file.hash, size: file.size, publishedAt: new Date(now()).toISOString() },
          now(),
          {
            kind: 'published',
            detail: { file: file.file },
          },
        );
        published.push({ gameId: generator.gameId, date: row.date, file: file.file, hash: file.hash, size: file.size });
        log.info('published', { puzzleId: row.puzzleId, file: file.file, size: file.size });
      }
      rebuildIndex(store, publisher, generator.gameId, today, {
        listAheadDays: options.listAheadDays ?? 1,
        indexBackDays: options.indexBackDays ?? 14,
      });
    }
  }

  const unfinished = slots.filter((slot) => slot.status !== 'validated' && slot.status !== 'published');
  const status: RunReport['status'] = aborted
    ? 'aborted'
    : unfinished.some((slot) => slot.date <= listThrough)
      ? unfinished.length === slots.length
        ? 'failed'
        : 'partial'
      : 'ok';
  const summary = {
    today,
    status,
    breakerOpen,
    slots: slots.map((slot) => ({
      puzzleId: slot.puzzleId,
      action: slot.action,
      status: slot.status,
      source: slot.source,
      attempts: slot.attempts.length,
    })),
    published: published.map((p) => p.file),
  };
  store.finishRun(runId, status, summary, now());
  log.info('run_finished', { runId, ...summary });
  return { runId, status, today, slots, published, breakerOpen };
};

/** Rewrites a game's index from the store: published items from `indexBackDays` ago through today + `listAheadDays`. */
export const rebuildIndex = (
  store: ContentStore,
  publisher: Publisher,
  gameId: string,
  today: string,
  { listAheadDays = 1, indexBackDays = 14 }: { listAheadDays?: number; indexBackDays?: number } = {},
): void => {
  const rows = store.published(gameId, addDays(today, -indexBackDays), addDays(today, listAheadDays));
  publisher.writeIndex(
    gameId,
    rows
      .filter((row) => row.contentHash !== null && row.size !== null)
      .map((row) => ({ date: row.date, hash: row.contentHash as string, size: row.size as number })),
  );
};

/**
 * Takes an item down (content-pipeline.md, "Corrections"): the item is withdrawn with a
 * reason code and actor, the game's index drops it at once, and the next run fills the slot
 * again, from the model or the bank. The withdrawn answer counts as used, so the replacement
 * gets a different one. Returns the withdrawn item, or null if no item held the puzzle.
 */
export const withdrawItem = (options: {
  readonly store: ContentStore;
  readonly publisher: Publisher | null;
  readonly gameId: string;
  readonly date: string;
  readonly reason: WithdrawReason;
  readonly actor: string;
  readonly note?: string;
  readonly now?: number;
  readonly listAheadDays?: number;
}): ItemRow | null => {
  const at = options.now ?? Date.now();
  const row = options.store.withdraw(
    makePuzzleId(options.gameId, options.date),
    options.reason,
    options.actor,
    at,
    options.note,
  );
  if (row !== null && options.publisher !== null) {
    rebuildIndex(options.store, options.publisher, options.gameId, utcDate(at), {
      listAheadDays: options.listAheadDays ?? 1,
    });
  }
  return row;
};
import { withDailyBank } from './banks.ts';
