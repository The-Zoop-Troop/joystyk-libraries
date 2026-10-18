// Standard Schemas (Zod 4 mini, D-22) for everything daily that crosses a boundary: the
// puzzle file and the game index the site serves, and the result a player keeps
// (content-pipeline.md, "Delivery" and "Results and streaks").

import {
  err,
  isGameId,
  isJson,
  ok,
  type Json,
  type Result,
  type StandardSchemaV1,
  type Validator,
} from '@joystyk/contracts';
import { isIsoDate } from '@joystyk/kit';
import * as z from 'zod/mini';
import { parsePuzzleId } from './ids.ts';

/** One validation problem, flattened for logs: `path: message`. */
export type Issue = string;

const describe = (issue: StandardSchemaV1.Issue, prefix: readonly PropertyKey[] = []): Issue => {
  const path = [
    ...prefix,
    ...(issue.path ?? []).map((segment) => (typeof segment === 'object' ? segment.key : segment)),
  ]
    .map(String)
    .join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
};

/** Runs any Standard Schema, sync or async, and returns its output or its issues. */
export const decode = async <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<Result<Output, readonly Issue[]>> => {
  const result = await schema['~standard'].validate(value);
  return result.issues === undefined ? ok(result.value) : err(result.issues.map((issue) => describe(issue)));
};

/** Any JSON value, checked with the contracts' `isJson`. */
export const json = z.custom<Json>(isJson, { error: 'Expected a JSON value' });

const isoDate = z.string().check(z.refine(isIsoDate, 'Expected a real date written yyyy-mm-dd'));

/** A content hash: the first 12 hex digits of SHA-256 over the canonical JSON of the puzzle. */
export const CONTENT_HASH = /^[0-9a-f]{12}$/;
const contentHash = z.string().check(z.regex(CONTENT_HASH, 'Expected 12 lowercase hex digits'));

/** A variant name such as "quick" or "standard": lowercase kebab-case, at most 32 characters. */
export const VARIANT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const variant = z.string().check(z.maxLength(32), z.regex(VARIANT, 'Expected a kebab-case variant name'));

/** The current version of the puzzle file and index formats. */
export const DAILY_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// The puzzle file: /daily/<game>/<date>.<hash>.json

/**
 * One day's puzzle file as the site serves it: the game's `Config` for the day (every variant)
 * wrapped with its id, date, hash and format version. `config` is still untrusted JSON here;
 * `dailyEnvelope` decodes it with the game's own schema.
 */
export type DailyFile = {
  readonly schemaVersion: typeof DAILY_SCHEMA_VERSION;
  readonly puzzleId: string;
  readonly date: string;
  readonly contentHash: string;
  readonly config: Json;
};

/** A puzzle file whose `config` has passed the game's `schemas.config`. */
export type DailyEnvelope<Config> = Omit<DailyFile, 'config'> & { readonly config: Config };

/** Decodes the puzzle file's wrapper. The id's date must match `date`. */
export const dailyFile: z.ZodMiniType<DailyFile> = z
  .object({
    schemaVersion: z.literal(DAILY_SCHEMA_VERSION),
    puzzleId: z
      .string()
      .check(z.refine((id) => parsePuzzleId(id) !== null, 'Expected an id like daily-word:2026-10-08')),
    date: isoDate,
    contentHash,
    config: json,
  })
  .check(
    z.refine((file) => parsePuzzleId(file.puzzleId)?.date === file.date, {
      message: "The puzzle id's date doesn't match the file's date",
      path: ['puzzleId'],
    }),
  );

/** What the caller knows before decoding a puzzle file, from the URL it asked for. */
export type EnvelopeExpectations = {
  readonly gameId?: string;
  readonly date?: string;
  readonly contentHash?: string;
};

const mismatch = (field: keyof DailyFile, expected: string, actual: string): StandardSchemaV1.Issue => ({
  message: `Expected ${expected}, got ${actual}`,
  path: [field],
});

/**
 * A Standard Schema for one game's puzzle file: the wrapper, then `config` through the game's
 * own `schemas.config` (any Standard Schema, sync or async). With `expected`, it also refuses
 * a file for another game, date or hash than the one requested. Issue paths inside the config
 * start with `config`.
 */
export const dailyEnvelope = <Config>(
  config: Validator<Config>,
  expected: EnvelopeExpectations = {},
): StandardSchemaV1<unknown, DailyEnvelope<Config>> => ({
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: async (value) => {
      const file = await dailyFile['~standard'].validate(value);
      if (file.issues !== undefined) return { issues: file.issues };
      const { puzzleId: id, date, contentHash: hash } = file.value;
      const issues: StandardSchemaV1.Issue[] = [];
      const ref = parsePuzzleId(id);
      if (expected.gameId !== undefined && ref?.gameId !== expected.gameId) {
        issues.push(mismatch('puzzleId', `a puzzle for ${expected.gameId}`, id));
      }
      if (expected.date !== undefined && date !== expected.date) issues.push(mismatch('date', expected.date, date));
      if (expected.contentHash !== undefined && hash !== expected.contentHash) {
        issues.push(mismatch('contentHash', expected.contentHash, hash));
      }
      if (issues.length > 0) return { issues };
      const decoded = await config['~standard'].validate(file.value.config);
      if (decoded.issues !== undefined) {
        return {
          issues: decoded.issues.map((issue) => ({ message: issue.message, path: ['config', ...(issue.path ?? [])] })),
        };
      }
      return { value: { ...file.value, config: decoded.value } };
    },
  },
});

// ---------------------------------------------------------------------------------------------
// The game index: /daily/<game>/index.json

/** One published date in a game's index. */
export type DailyIndexEntry = {
  readonly date: string;
  readonly hash: string;
  /** The file's size in bytes. */
  readonly size: number;
};

/**
 * The dates a game has published, served `no-cache`. It lists dates up to tomorrow's UTC date
 * (`latestListedDate`), each with its content hash, which names the file.
 */
export type DailyIndex = {
  readonly schemaVersion: typeof DAILY_SCHEMA_VERSION;
  readonly gameId: string;
  readonly dates: readonly DailyIndexEntry[];
};

/** Decodes a game index. Each date appears once. */
export const dailyIndex: z.ZodMiniType<DailyIndex> = z.object({
  schemaVersion: z.literal(DAILY_SCHEMA_VERSION),
  gameId: z.string().check(z.refine(isGameId, 'Expected a kebab-case game id')),
  dates: z
    .array(z.object({ date: isoDate, hash: contentHash, size: z.int().check(z.nonnegative()) }))
    .check(
      z.refine((dates) => new Set(dates.map((d) => d.date)).size === dates.length, 'Each date may appear only once'),
    ),
});

// ---------------------------------------------------------------------------------------------
// Results

/** How a daily puzzle ended. Finishing means the engine reached an outcome. */
export type DailyOutcome = 'won' | 'lost' | 'completed';

/** One finished daily puzzle, kept per puzzle id and variant (content-pipeline.md). */
export type DailyResult = {
  /** "daily-word:2026-10-08". Its date is the date the result counts for. */
  readonly puzzleId: string;
  /** "quick", "standard", … or null for a game without variants. */
  readonly variant: string | null;
  readonly contentHash: string;
  readonly outcome: DailyOutcome;
  /** Hints, checks or reveals were used, as each game defines them. */
  readonly assisted: boolean;
  /** The outcome's summary, e.g. "4/6". */
  readonly summary: string;
  readonly stats: Readonly<Record<string, number>>;
  /** Spoiler-free symbol rows from the game, e.g. "⬜🟨⬜⬜⬜". */
  readonly shareRows: readonly string[];
  /** The same rows in words, for *Copy as text*: "Guess 1: 1 wrong place". Absent in older results. */
  readonly shareWords?: readonly string[];
  /** Separate validated annotations; absent in legacy records. */
  readonly shareDetails?: readonly (number | 'found' | null)[];
  /** The UTC date when it finished, `yyyy-mm-dd`. May be after the puzzle's date. */
  readonly finishedOn: string;
};

/** Decodes a `DailyResult`. */
export const dailyResult: z.ZodMiniType<DailyResult> = z.object({
  puzzleId: z.string().check(z.refine((id) => parsePuzzleId(id) !== null, 'Expected an id like daily-word:2026-10-08')),
  variant: z.nullable(variant),
  contentHash,
  outcome: z.enum(['won', 'lost', 'completed']),
  assisted: z.boolean(),
  summary: z.string().check(z.maxLength(200)),
  stats: z.record(z.string(), z.number().check(z.refine(Number.isFinite, 'Expected a finite number'))),
  shareRows: z.array(z.string().check(z.maxLength(200))).check(z.maxLength(50)),
  shareDetails: z.optional(
    z
      .array(z.nullable(z.union([z.int().check(z.minimum(0), z.maximum(100)), z.literal('found')])))
      .check(z.maxLength(50)),
  ),
  // Spoken move histories may describe 25 swaps or nine golf holes in one row.
  shareWords: z.optional(z.array(z.string().check(z.maxLength(1000))).check(z.maxLength(50))),
  finishedOn: isoDate,
});

/**
 * The date a result counts for: its puzzle's own date, even when it was finished after the
 * next puzzle came out (a puzzle started is a puzzle kept).
 */
export const creditDate = (result: Pick<DailyResult, 'puzzleId'>): string => {
  const ref = parsePuzzleId(result.puzzleId);
  if (ref === null) throw new RangeError(`Not a daily puzzle id: ${JSON.stringify(result.puzzleId)}.`);
  return ref.date;
};

// ---------------------------------------------------------------------------------------------
// Canonical JSON for content hashes

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * JSON with object keys sorted by UTF-16 code unit and no whitespace. The content hash is the
 * first 12 hex digits of SHA-256 over the canonical JSON of a puzzle file's `config`.
 */
export const canonicalJson = (value: Json): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, Json>>)[key] as Json)}`);
  return `{${entries.join(',')}}`;
};
