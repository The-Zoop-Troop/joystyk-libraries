import type { Json } from './json.ts';
import type { Validator } from './schema.ts';

/**
 * A kind of asynchronous work an engine may request: slow, heavy or secret work that can't
 * run inside `apply`, such as Greed's physics dice throw. The platform performs it and feeds
 * the result back as a `job` input.
 */
export interface JobSpec<Payload extends Json = Json, Value extends Json = Json> {
  /** 'server' for secrets or authority; 'either' when local play may run it too. */
  readonly where: 'server' | 'either';
  readonly payload: Validator<Payload>;
  /** Validates the `value` of a successful outcome. */
  readonly result: Validator<Value>;
  readonly timeoutMs: number;
}

/** Work requested by a transition. */
export type JobRequest = {
  /** Deterministic: derived from the revision and position, so replays match. */
  readonly id: string;
  /** A key of the engine's `jobs`. */
  readonly kind: string;
  readonly payload: Json;
};

/**
 * How a job ended. The job runner produces it with `presentation`; the engine runner strips
 * `presentation` before the outcome reaches the engine or the replay log, and puts it in the
 * snapshot's `presentation` instead.
 */
export type JobOutcome =
  | {
      readonly ok: true;
      /** What the engine needs, e.g. the six die faces. Part of the replay log. */
      readonly value: Json;
      /** What only the presentation needs, e.g. recorded motion. Never seen by the engine. */
      readonly presentation?: Json;
    }
  | { readonly ok: false; readonly reason: 'timeout' | 'failed' };
