// Standard Schemas for the contracts' save envelope (game-contract.md, "Saves"). The game's
// own state inside it stays `Json` here; the game's migrations and `schemas.state` decode it.
import {
  ASSIST_KINDS,
  type AssistKind,
  type EngineInput,
  type Json,
  type Replay,
  type SaveEnvelope,
} from '@joystyk/contracts';
import * as z from 'zod/mini';
import { json } from './validate.ts';

const count = z.int().check(z.nonnegative());
const version = z.int().check(z.positive());
const milliseconds = z.number().check(z.nonnegative());

const rngState = z.object({ algorithm: z.string(), words: z.array(z.number()) });

const controller = z.enum(['human', 'ai']);

const seatInfo = z.object({
  id: count,
  name: z.string(),
  controller,
  aiLevel: z.optional(z.string()),
});

const seatChange = z.discriminatedUnion('type', [
  z.object({ type: z.literal('controller'), controller, name: z.string(), aiLevel: z.optional(z.string()) }),
  z.object({ type: z.literal('left') }),
]);

const jobOutcome = z.union([
  z.object({ ok: z.literal(true), value: json, presentation: z.optional(json) }),
  z.object({ ok: z.literal(false), reason: z.enum(['timeout', 'failed']) }),
]);

const engineInput: z.ZodMiniType<EngineInput<Json>> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), seat: count, command: json }),
  z.object({ kind: z.literal('seat'), seat: count, change: seatChange }),
  z.object({ kind: z.literal('timeout'), seat: count }),
  z.object({ kind: z.literal('resign'), seat: count }),
  z.object({ kind: z.literal('job'), jobId: z.string(), outcome: jobOutcome }),
]);

const replay: z.ZodMiniType<Replay> = z.discriminatedUnion('layer', [
  z.object({
    layer: z.literal(2),
    gameId: z.string(),
    rulesVersion: version,
    config: json,
    seats: z.array(seatInfo),
    seed: rngState,
    inputs: z.array(engineInput),
  }),
  z.object({
    layer: z.literal(3),
    gameId: z.string(),
    rulesVersion: version,
    config: json,
    seed: rngState,
    inputs: z.array(z.object({ tick: count, input: json })),
    endTick: count,
  }),
]);

/** Decodes a `SaveEnvelope`. `state` is only checked to be JSON. */
export const saveEnvelope: z.ZodMiniType<SaveEnvelope> = z.object({
  gameId: z.string(),
  build: z.string(),
  rulesVersion: version,
  saveVersion: version,
  daily: z.optional(
    z.object({
      puzzleId: z.string().check(z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*:\d{4}-\d{2}-\d{2}$/)),
      contentHash: z.string().check(z.minLength(1)),
    }),
  ),
  rng: rngState,
  seats: z.array(seatInfo),
  state: json,
  tick: z.optional(count),
  elapsedMs: z.optional(milliseconds),
  clockStarted: z.optional(z.boolean()),
  replay: z.optional(replay),
  // The runner's records. The schema keeps them: an object schema drops keys it doesn't name.
  aiRng: z.optional(rngState),
  undosUsed: z.optional(count),
  assists: z.optional(z.array(z.enum(ASSIST_KINDS as readonly [AssistKind, ...AssistKind[]]))),
  assistCounts: z.optional(
    z.strictObject({
      undo: z.optional(count),
      hint: z.optional(count),
      check: z.optional(count),
      reveal: z.optional(count),
      shuffle: z.optional(count),
    }),
  ),
});
