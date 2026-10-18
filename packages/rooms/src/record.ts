// The stored room record's schema and its migrations (room-server.md sections 6.4 and 6.5).
// A stored row is decoded through `decodeRecord` before the core ever sees it; anything that
// fails is quarantined, never repaired by guesswork (core belief 9).
import type { Json, Result } from '@joystyk/contracts';
import { err, ok } from '@joystyk/contracts';
import * as z from 'zod/mini';
import { GamePinSchema, JsonValue, RoomPhaseSchema } from './protocol/index.ts';
import type { RoomRecord } from './types.ts';

/** The record format this build writes. */
export const RECORD_FORMAT = 1;

const Int = z.int();
const NonNegative = z.int().check(z.nonnegative());
const Seat = z.int().check(z.nonnegative(), z.maximum(63));
const RngStateSchema = z.object({ algorithm: z.string(), words: z.array(z.number()) });
const Time = z.number();

const OutcomeSchema = z.object({
  result: z.enum(['won', 'lost', 'draw', 'completed', 'abandoned']),
  placements: z.array(z.object({ seat: Seat, place: Int, score: z.optional(z.number()) })),
  summary: z.string(),
  stats: z.optional(z.record(z.string(), z.number())),
  elapsedMs: z.optional(z.number()),
});

const SeatInfoSchema = z.object({
  id: Seat,
  name: z.string(),
  controller: z.enum(['human', 'ai']),
  aiLevel: z.optional(z.string()),
});

const MatchSchema = z.object({
  number: z.int().check(z.positive()),
  game: GamePinSchema,
  config: JsonValue,
  seats: z.array(SeatInfoSchema),
  seed: RngStateSchema,
  state: JsonValue,
  rng: RngStateSchema,
  aiRng: RngStateSchema,
  decisionRevision: z.array(NonNegative),
  clocks: z.array(
    z.object({
      seat: Seat,
      at: Time,
      decisionRevision: NonNegative,
      startsAt: z.optional(Time),
      onBank: z.optional(z.boolean()),
    }),
  ),
  banks: z.optional(z.array(z.number().check(z.nonnegative()))),
  jobs: z.array(
    z.object({ request: z.object({ id: z.string(), kind: z.string(), payload: JsonValue }), revision: NonNegative }),
  ),
  presentation: z.nullable(JsonValue),
  log: z.array(JsonValue),
  outcome: z.nullable(OutcomeSchema),
  startedAt: Time,
  pausedAt: z.optional(Time),
});

const OfferSchema = z.object({
  id: NonNegative,
  kind: z.enum(['rematch', 'end']),
  by: Seat,
  status: z.enum(['open', 'declined', 'withdrawn']),
  accepted: z.array(Seat),
  declinedBy: z.nullable(Seat),
  endsAt: z.nullable(Time),
});

export const RoomRecordSchema = z.object({
  format: z.literal(RECORD_FORMAT),
  code: z.string(),
  epoch: NonNegative,
  writes: NonNegative,
  policy: z.object({
    seats: z.object({ min: Int, max: Int }),
    start: z.enum(['host', 'immediate']),
    lateJoin: z.enum(['spectate', 'take-ai-seat']),
    absent: z.enum(['ai', 'timeout', 'wait']),
    graceMs: NonNegative,
    decisionMs: z.nullable(z.int().check(z.positive())),
    bank: z.optional(z.nullable(z.object({ initialMs: z.int().check(z.positive()), incrementMs: NonNegative }))),
    maxSpectators: NonNegative,
    retainMs: z.int().check(z.positive()),
  }),
  phase: RoomPhaseSchema,
  revision: NonNegative,
  game: GamePinSchema,
  config: JsonValue,
  aiLevel: z.nullable(z.string()),
  seats: z.array(
    z.object({
      id: Seat,
      claim: z.nullable(z.object({ tokenHash: z.string(), name: z.string() })),
      controller: z.enum(['human', 'ai']),
      aiLevel: z.nullable(z.string()),
      ready: z.boolean(),
    }),
  ),
  host: z.nullable(Seat),
  match: z.nullable(MatchSchema),
  offer: z.optional(z.nullable(OfferSchema)),
  receipts: z.array(z.object({ seat: Seat, id: z.string(), fingerprint: z.string(), revision: NonNegative })),
  createdAt: Time,
  updatedAt: Time,
});

/**
 * Pure migrations from format n to n + 1, applied on load. There are none yet; the first
 * change to `RoomRecord` adds `1: (record) => …` here and bumps RECORD_FORMAT.
 */
const MIGRATIONS: {
  readonly [from: number]: (record: { readonly [key: string]: Json }) => { readonly [key: string]: Json };
} = {};

export type DecodeError = { readonly code: 'newer-format' | 'invalid'; readonly message: string };

/**
 * Decodes a stored record: migrates older formats, then validates. `migrated` tells the
 * store to archive the original row before rewriting it.
 */
export const decodeRecord = (
  raw: unknown,
): Result<{ readonly record: RoomRecord; readonly migrated: boolean }, DecodeError> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return err({ code: 'invalid', message: 'The record is not an object.' });
  let value = raw as { readonly [key: string]: Json };
  const format = value['format'];
  if (typeof format !== 'number' || !Number.isInteger(format))
    return err({ code: 'invalid', message: 'The record has no format.' });
  if (format > RECORD_FORMAT)
    return err({
      code: 'newer-format',
      message: `Record format ${format} is newer than this build's ${RECORD_FORMAT}.`,
    });
  for (let from = format; from < RECORD_FORMAT; from += 1) {
    const migrate = MIGRATIONS[from];
    if (migrate === undefined) return err({ code: 'invalid', message: `No migration from record format ${from}.` });
    value = migrate(value);
  }
  const parsed = RoomRecordSchema.safeParse(value);
  if (!parsed.success)
    return err({
      code: 'invalid',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  return ok({ record: parsed.data as RoomRecord, migrated: format !== RECORD_FORMAT });
};
