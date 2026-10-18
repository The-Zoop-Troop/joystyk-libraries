// Non-daily items: packs keyed by a curated slot, such as a theme, instead of a date
// (content-pipeline.md, "Implemented"; Letter Drop's word packs are the first). The checks
// are the daily pipeline's: parse, game validators, the all-ages word lists, the model screen.
//
//   slots ─▶ generate ─▶ schema ─▶ game validators ─▶ blocklist + sensitive list ─▶ model screen ─▶ validated ─▶ publish
//               ▲                                                                                       │
//               └──────── up to 3 attempts per slot per run; each retry hears what was wrong ───────────┘
//                         still failing and the slot has nothing published: the slot's bank pack
//
// Each slot holds one current item, `<game>:pack:<slug>`, that stays published until staff
// withdraw it. A slot that fell back to its bank pack tries the model again on every run, and a
// validated pack replaces the bank one. Published files go next to the daily files:
//
//   <dir>/<game>/packs/index.json             { schemaVersion: 1, gameId, packs: [{ slug, hash, size }] }
//   <dir>/<game>/packs/<slug>.<hash>.json     { schemaVersion: 1, itemId, slug, contentHash, config }
//
// The site serves them at /content/<game>/index.json and /content/<game>/<slug>.<hash>.json.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withPackBank } from './banks.ts';
import type { Json, Result, StandardSchemaV1 } from '@joystyk/contracts';
import { utcDate } from '@joystyk/daily';
import type { FieldText, WordFilter } from './filter.ts';
import { contentHash } from './hash.ts';
import { silentLogger, type Logger } from './log.ts';
import type { ModelClient } from './model.ts';
import {
  decodeConfig,
  defaultSleep,
  issuesOf,
  outcomeOf,
  recording,
  type AttemptOutcome,
  type AttemptReport,
  type CallReport,
  type GenerateFailure,
} from './pipeline.ts';
import type { PublishedFile } from './publish.ts';
import { modelScreen, SCREEN_PROMPT_VERSION } from './screen.ts';
import type { ContentStore, ItemRow, WithdrawReason } from './store.ts';

export const PACK_SCHEMA_VERSION = 1;

/** One slot a game keeps filled, such as a theme. Slugs are stable: they name files and items. */
export interface PackSlot<Inputs extends Json = Json> {
  readonly slug: string;
  readonly inputs: Inputs;
}

export interface PackGenerateContext<Inputs extends Json> {
  readonly itemId: string;
  readonly slug: string;
  readonly inputs: Inputs;
  /** Deterministic per item: the generator draws any randomness (gap positions) from it. */
  readonly seed: string;
  /** 1-based, within this run. */
  readonly attempt: number;
  /** What was wrong with the previous attempt, in words the prompt can repeat. Empty on the first. */
  readonly feedback: readonly string[];
  readonly model: ModelClient;
  readonly signal?: AbortSignal;
}

export interface PackGenerator<Config extends Json = Json, Inputs extends Json = Json> {
  readonly gameId: string;
  /** Recorded with every item, e.g. "letter-drop-v1". */
  readonly promptVersion: string;
  /** The game's pack schema: every pack is decoded through it before anything else. */
  readonly configSchema: StandardSchemaV1<unknown, Config>;
  /** The curated slots to keep filled. Deterministic: no player text ever reaches a prompt. */
  slots(): readonly PackSlot<Inputs>[];
  generate(context: PackGenerateContext<Inputs>): Promise<Result<Config, GenerateFailure>>;
  /** The game validators: pure; an empty list means the pack passes. */
  validate(
    config: Config,
    context: { readonly itemId: string; readonly slug: string; readonly inputs: Inputs | null },
  ): readonly string[];
  /** Every player-visible text, for the all-ages filter and the model screen. */
  texts(config: Config): readonly FieldText[];
  /** The reviewed fallback pack for a slot, or null when the bank has none. */
  bank(slot: PackSlot<Inputs>, itemId: string): Config | null;
}

export const packItemId = (gameId: string, slug: string): string => `${gameId}:pack:${slug}`;

/** The slug of a pack item id, or null when the id is not a pack's. */
export const packSlugOf = (gameId: string, itemId: string): string | null => {
  const prefix = `${gameId}:pack:`;
  return itemId.startsWith(prefix) ? itemId.slice(prefix.length) : null;
};

// ---------------------------------------------------------------------------------------------
// Publishing

export interface PackIndexEntry {
  readonly slug: string;
  readonly hash: string;
  readonly size: number;
}

export interface PackIndex {
  readonly schemaVersion: typeof PACK_SCHEMA_VERSION;
  readonly gameId: string;
  readonly packs: readonly PackIndexEntry[];
}

export interface PackFile {
  readonly schemaVersion: typeof PACK_SCHEMA_VERSION;
  readonly itemId: string;
  readonly slug: string;
  readonly contentHash: string;
  readonly config: Json;
}

export interface PackPublisher {
  readonly dir: string;
  /** Writes one pack file (if it isn't there already) and returns its hash and size. */
  writePack(gameId: string, slug: string, config: Json): PublishedFile;
  /** Replaces a game's pack index. */
  writeIndex(gameId: string, packs: readonly PackIndexEntry[]): void;
}

let counter = 0;
const writeAtomic = (path: string, body: string): void => {
  const temporary = `${path}.${String(process.pid)}.${String(++counter)}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, path);
};

/** The pack file body for a config: the envelope, as compact JSON. */
export const packFileBody = (gameId: string, slug: string, config: Json): { body: string; hash: string } => {
  const hash = contentHash(config);
  const file: PackFile = {
    schemaVersion: PACK_SCHEMA_VERSION,
    itemId: packItemId(gameId, slug),
    slug,
    contentHash: hash,
    config,
  };
  return { body: JSON.stringify(file), hash };
};

/** Pack files under `<dir>/<game>/packs/`, written atomically; a file named by its hash is never rewritten. */
export const createPackPublisher = (dir: string): PackPublisher => ({
  dir,
  writePack: (gameId, slug, config) => {
    const { body, hash } = packFileBody(gameId, slug, config);
    const folder = join(dir, gameId, 'packs');
    mkdirSync(folder, { recursive: true });
    const name = `${slug}.${hash}.json`;
    const path = join(folder, name);
    if (!existsSync(path)) writeAtomic(path, body);
    return { hash, size: Buffer.byteLength(body), file: `${gameId}/packs/${name}` };
  },
  writeIndex: (gameId, packs) => {
    const folder = join(dir, gameId, 'packs');
    mkdirSync(folder, { recursive: true });
    const index: PackIndex = {
      schemaVersion: PACK_SCHEMA_VERSION,
      gameId,
      packs: [...packs].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    };
    writeAtomic(join(folder, 'index.json'), `${JSON.stringify(index)}\n`);
  },
});

/** The current published packs of a game, from the store. */
const publishedPacks = (store: ContentStore, gameId: string): ItemRow[] =>
  store
    .items(gameId, '0000-01-01', '9999-12-31')
    .filter((row) => row.status === 'published' && packSlugOf(gameId, row.puzzleId) !== null);

/** Rewrites a game's pack index from the store: every current published pack. */
export const rebuildPackIndex = (store: ContentStore, publisher: PackPublisher, gameId: string): void => {
  publisher.writeIndex(
    gameId,
    publishedPacks(store, gameId).flatMap((row) => {
      const slug = packSlugOf(gameId, row.puzzleId);
      return slug === null || row.contentHash === null || row.size === null
        ? []
        : [{ slug, hash: row.contentHash, size: row.size }];
    }),
  );
};

// ---------------------------------------------------------------------------------------------
// The run

export type PackAction = 'existing' | 'generated' | 'replaced-bank' | 'bank' | 'failed' | 'aborted';

export interface PackSlotReport {
  readonly gameId: string;
  readonly slug: string;
  readonly itemId: string;
  readonly action: PackAction;
  readonly status: string;
  readonly source: string | null;
  readonly attempts: readonly AttemptReport[];
  readonly contentHash: string | null;
  readonly config: Json | null;
}

export interface PackRunReport {
  readonly runId: number;
  readonly status: 'ok' | 'partial' | 'failed' | 'aborted';
  readonly slots: readonly PackSlotReport[];
  readonly published: readonly (PublishedFile & { readonly gameId: string; readonly slug: string })[];
  readonly breakerOpen: boolean;
}

export interface PackPipelineOptions {
  readonly store: ContentStore;
  readonly generators: readonly PackGenerator[];
  /** Null runs without a model: validated packs publish and empty slots take bank packs. */
  readonly model: ModelClient | null;
  readonly filter: WordFilter;
  /** Null for a dry run: nothing is written. */
  readonly publisher: PackPublisher | null;
  readonly now?: () => number;
  /** Only these games, and only these slugs. */
  readonly games?: readonly string[];
  readonly slugs?: readonly string[];
  /** Publish a failed slot's bank pack (default true). `content bank`, which grows the banks, turns it off. */
  readonly bankFallback?: boolean;
  readonly maxAttempts?: number;
  readonly breakerThreshold?: number;
  /** Run the model screen (layer 3). Default true. */
  readonly screen?: boolean;
  readonly backoffMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly log?: Logger;
  readonly trigger?: string;
}

const done = (row: ItemRow | null): boolean =>
  row !== null && (row.status === 'validated' || row.status === 'published');

export const runPackPipeline = async (options: PackPipelineOptions): Promise<PackRunReport> => {
  const { store, filter, publisher } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? silentLogger;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const breakerThreshold = options.breakerThreshold ?? 5;
  const backoffMs = options.backoffMs ?? 2000;
  const screenOn = options.screen ?? true;
  const signal = options.signal;
  const generators = options.generators
    .filter((g) => options.games === undefined || options.games.includes(g.gameId))
    .map((generator) => withPackBank(store, generator));
  const runId = store.startRun(options.trigger ?? 'manual-packs', now());
  log.info('pack_run_started', {
    runId,
    games: generators.map((g) => g.gameId),
    model: options.model?.model ?? null,
    dryRun: publisher === null,
  });

  let consecutiveEndpointErrors = 0;
  let breakerOpen = false;
  let aborted = false;
  const slots: PackSlotReport[] = [];
  const published: PackRunReport['published'][number][] = [];

  const report = (
    generator: PackGenerator,
    slot: PackSlot,
    row: ItemRow | null,
    action: PackAction,
    attempts: readonly AttemptReport[],
  ): PackSlotReport => ({
    gameId: generator.gameId,
    slug: slot.slug,
    itemId: packItemId(generator.gameId, slot.slug),
    action,
    status: row?.status ?? 'none',
    source: row?.source ?? null,
    attempts,
    contentHash: row?.contentHash ?? null,
    config: row?.config ?? null,
  });

  /** The schema, the game validators and the word lists. */
  const judge = async (
    generator: PackGenerator,
    value: unknown,
    itemId: string,
    slot: PackSlot,
    inputs: Json | null,
  ) => {
    const decoded = await decodeConfig(generator.configSchema, value);
    if (!decoded.ok) return { outcome: 'schema' as AttemptOutcome, issues: decoded.error, config: null, filter: null };
    const config = decoded.value;
    const issues = [...generator.validate(config, { itemId, slug: slot.slug, inputs })];
    if (issues.length > 0) return { outcome: 'invalid' as AttemptOutcome, issues, config, filter: null };
    const filtered = filter.check(generator.texts(config));
    if (!filtered.ok) {
      const words = [...new Set(filtered.hits.map((hit) => hit.term))].join(', ');
      return {
        outcome: 'filtered' as AttemptOutcome,
        issues: [
          `Text in ${[...new Set(filtered.hits.map((hit) => hit.path))].join(', ')} touches a topic or word that isn't allowed (${words}).`,
        ],
        config,
        filter: filtered,
      };
    }
    return { outcome: 'validated' as AttemptOutcome, issues: [] as string[], config, filter: filtered };
  };

  /** Generates with retries; the validated config, or null with every attempt reported. */
  const generate = async (
    generator: PackGenerator,
    slot: PackSlot,
    itemId: string,
    model: ModelClient,
    attempts: AttemptReport[],
  ): Promise<Json | null> => {
    let feedback: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted === true) {
        aborted = true;
        return null;
      }
      if (attempt > 1) await sleep(backoffMs * 2 ** (attempt - 2), signal);
      const calls: CallReport[] = [];
      const recorded = recording(model, calls);
      const finish = (result: Omit<AttemptReport, 'attempt' | 'calls'>) => {
        attempts.push({ attempt, calls, ...result });
        log.info('pack_attempt', {
          itemId,
          attempt,
          outcome: result.outcome,
          issues: result.issues.slice(0, 8),
          calls: calls.map((c) => ({ name: c.name, ok: c.ok, ms: c.latencyMs, tokens: c.totalTokens })),
        });
      };
      const generated = await generator.generate({
        itemId,
        slug: slot.slug,
        inputs: slot.inputs,
        seed: itemId,
        attempt,
        feedback,
        model: recorded,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!generated.ok) {
        const failure = generated.error;
        const outcome = failure.kind === 'model' ? outcomeOf(failure.error) : 'rejected';
        const issues = failure.kind === 'model' ? issuesOf(failure.error) : [...failure.issues];
        finish({ outcome, issues, filter: null, screen: null });
        if (outcome === 'aborted') {
          aborted = true;
          return null;
        }
        if (outcome === 'endpoint') {
          if (++consecutiveEndpointErrors >= breakerThreshold) {
            breakerOpen = true;
            log.error('circuit_breaker_open', { consecutiveEndpointErrors });
            return null;
          }
        } else {
          consecutiveEndpointErrors = 0;
          feedback = issues;
        }
        continue;
      }
      consecutiveEndpointErrors = 0;
      const verdict = await judge(generator, generated.value, itemId, slot, slot.inputs);
      if (verdict.outcome !== 'validated' || verdict.config === null) {
        finish({ outcome: verdict.outcome, issues: verdict.issues, filter: verdict.filter, screen: null });
        feedback = verdict.issues;
        continue;
      }
      let screen: AttemptReport['screen'] = null;
      if (screenOn) {
        const screened = await modelScreen(recorded, generator.texts(verdict.config), signal);
        if (!screened.ok) {
          const outcome = outcomeOf(screened.error);
          finish({ outcome, issues: issuesOf(screened.error), filter: verdict.filter, screen: null });
          if (outcome === 'aborted') {
            aborted = true;
            return null;
          }
          if (outcome === 'endpoint' && ++consecutiveEndpointErrors >= breakerThreshold) {
            breakerOpen = true;
            return null;
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
      finish({ outcome: 'validated', issues: [], filter: verdict.filter, screen });
      return verdict.config;
    }
    return null;
  };

  const fillSlot = async (generator: PackGenerator, slot: PackSlot): Promise<PackSlotReport> => {
    const itemId = packItemId(generator.gameId, slot.slug);
    let row = store.current(itemId);
    const holdsBank = done(row) && row?.source === 'bank';
    if (done(row) && !holdsBank) return report(generator, slot, row, 'existing', []);
    const attempts: AttemptReport[] = [];
    const model = options.model;
    const history = (base: ItemRow | null) => [
      ...((base?.report as Json[] | null) ?? []),
      ...attempts.map((a) => a as unknown as Json),
    ];

    if (model !== null && !breakerOpen) {
      if (row === null)
        row = store.createItem({
          gameId: generator.gameId,
          puzzleId: itemId,
          date: utcDate(now()),
          inputs: slot.inputs,
          seed: itemId,
          answer: null,
          now: now(),
        });
      if (!holdsBank)
        row = store.updateItem(
          row.id,
          { status: 'generating', model: model.model, promptVersion: generator.promptVersion },
          now(),
        );
      const config = await generate(generator, slot, itemId, model, attempts);
      if (config !== null) {
        let action: PackAction = 'generated';
        if (holdsBank) {
          // A generated pack replaces the bank pack: the bank item steps aside, recorded as such.
          store.withdraw(itemId, 'other', 'content', now(), 'Replaced by a generated pack.');
          row = store.createItem({
            gameId: generator.gameId,
            puzzleId: itemId,
            date: utcDate(now()),
            inputs: slot.inputs,
            seed: itemId,
            answer: null,
            now: now(),
          });
          action = 'replaced-bank';
        }
        row = store.updateItem(
          row.id,
          {
            status: 'validated',
            source: 'generated',
            model: model.model,
            promptVersion: generator.promptVersion,
            config,
            contentHash: contentHash(config),
            attempts: row.attempts + attempts.length,
            report: history(row),
          },
          now(),
          { kind: 'validated', detail: { attempt: attempts.length, screen: screenOn ? SCREEN_PROMPT_VERSION : null } },
        );
        return report(generator, slot, row, action, attempts);
      }
    }
    if (holdsBank) return report(generator, slot, row, aborted ? 'aborted' : 'existing', attempts);
    if (aborted) {
      if (row !== null)
        row = store.updateItem(
          row.id,
          { status: 'scheduled', attempts: row.attempts + attempts.length, report: history(row) },
          now(),
          { kind: 'interrupted' },
        );
      return report(generator, slot, row, 'aborted', attempts);
    }
    row ??= store.createItem({
      gameId: generator.gameId,
      puzzleId: itemId,
      date: utcDate(now()),
      inputs: slot.inputs,
      seed: itemId,
      answer: null,
      now: now(),
    });
    row = store.updateItem(
      row.id,
      { status: 'failed', attempts: row.attempts + attempts.length, report: history(row) },
      now(),
      attempts.length > 0 ? { kind: 'failed', detail: { attempts: attempts.length } } : undefined,
    );
    const bank = options.bankFallback === false ? null : generator.bank(slot, itemId);
    if (bank === null) return report(generator, slot, row, 'failed', attempts);
    const verdict = await judge(generator, bank, itemId, slot, null);
    if (verdict.outcome !== 'validated' || verdict.config === null) {
      log.error('bank_pack_rejected', { itemId, outcome: verdict.outcome, issues: verdict.issues });
      return report(generator, slot, row, 'failed', attempts);
    }
    log.warn('bank_used', { itemId });
    row = store.updateItem(
      row.id,
      {
        status: 'validated',
        source: 'bank',
        config: verdict.config,
        contentHash: contentHash(verdict.config),
        model: null,
        promptVersion: 'bank',
      },
      now(),
      { kind: 'bank' },
    );
    return report(generator, slot, row, 'bank', attempts);
  };

  for (const generator of generators) {
    for (const slot of generator.slots()) {
      if (options.slugs !== undefined && !options.slugs.includes(slot.slug)) continue;
      if (signal?.aborted === true) aborted = true;
      if (aborted) break;
      const result = await fillSlot(generator, slot);
      slots.push(result);
      log.info('pack_slot', {
        itemId: result.itemId,
        action: result.action,
        status: result.status,
        source: result.source,
        attempts: result.attempts.length,
      });
    }
    if (aborted) break;
  }

  if (publisher !== null) {
    for (const generator of generators) {
      for (const slot of generator.slots()) {
        const row = store.current(packItemId(generator.gameId, slot.slug));
        if (row === null || row.status !== 'validated' || row.config === null) continue;
        const file = publisher.writePack(generator.gameId, slot.slug, row.config);
        store.updateItem(
          row.id,
          { status: 'published', contentHash: file.hash, size: file.size, publishedAt: new Date(now()).toISOString() },
          now(),
          { kind: 'published', detail: { file: file.file } },
        );
        published.push({ ...file, gameId: generator.gameId, slug: slot.slug });
        log.info('published', { itemId: row.puzzleId, file: file.file, size: file.size });
      }
      rebuildPackIndex(store, publisher, generator.gameId);
    }
  }

  const unfinished = slots.filter((slot) => slot.status !== 'validated' && slot.status !== 'published');
  const status: PackRunReport['status'] = aborted
    ? 'aborted'
    : unfinished.length === 0
      ? 'ok'
      : unfinished.length === slots.length
        ? 'failed'
        : 'partial';
  const summary = {
    status,
    breakerOpen,
    slots: slots.map((s) => ({
      itemId: s.itemId,
      action: s.action,
      status: s.status,
      source: s.source,
      attempts: s.attempts.length,
    })),
    published: published.map((p) => p.file),
  };
  store.finishRun(runId, status, summary, now());
  log.info('pack_run_finished', { runId, ...summary });
  return { runId, status, slots, published, breakerOpen };
};

/**
 * Takes a pack down (content-pipeline.md, "Corrections"): withdrawn with a reason code and
 * actor, dropped from the index at once; the next run fills the slot again. Games already
 * started on the old pack keep it, because the pack travels in their config.
 */
export const withdrawPack = (options: {
  readonly store: ContentStore;
  readonly publisher: PackPublisher | null;
  readonly gameId: string;
  readonly slug: string;
  readonly reason: WithdrawReason;
  readonly actor: string;
  readonly note?: string;
  readonly now?: number;
}): ItemRow | null => {
  const row = options.store.withdraw(
    packItemId(options.gameId, options.slug),
    options.reason,
    options.actor,
    options.now ?? Date.now(),
    options.note,
  );
  if (row !== null && options.publisher !== null) rebuildPackIndex(options.store, options.publisher, options.gameId);
  return row;
};
