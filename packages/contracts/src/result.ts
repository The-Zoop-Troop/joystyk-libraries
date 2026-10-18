import type { Json } from './json.ts';

/**
 * A rule violation or other expected failure, worded for players. Engines return it inside a
 * failed `Result`; they never throw for a rule violation.
 */
export type GameError = {
  /** Stable, game-defined tag, e.g. "NotYourTurn". Used by tests and logs. */
  readonly code: string;
  /** Player-facing explanation, already worded for the UI. */
  readonly message: string;
  readonly detail?: Json;
};

/** A successful outcome carrying a value. */
export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
};

/** A failed outcome carrying a typed error. */
export type Err<E> = {
  readonly ok: false;
  readonly error: E;
};

/**
 * The outcome of an operation that can fail in an expected way, such as an engine rejecting
 * an illegal move. Check `ok` to narrow it: `value` exists only on success and `error` only
 * on failure. Unexpected failures (bugs) still throw. The error defaults to `GameError`.
 */
export type Result<T, E = GameError> = Ok<T> | Err<E>;

/** Wraps a value as a successful result. */
export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

/** Wraps an error as a failed result. */
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/**
 * Builds a `GameError`. An absent `detail` is left out rather than set to `undefined`, so
 * the error stays JSON.
 */
export const gameError = (code: string, message: string, detail?: Json): GameError =>
  detail === undefined ? { code, message } : { code, message, detail };

/** True when `value` has the shape of a `GameError` (a string `code` and `message`). */
export const isGameError = (value: unknown): value is GameError =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { code?: unknown }).code === 'string' &&
  typeof (value as { message?: unknown }).message === 'string';
