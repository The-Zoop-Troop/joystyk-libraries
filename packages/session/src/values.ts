// Small value helpers the runners share: schema decoding, deep freezing, JSON equality.
import { err, gameError, ok, type GameError, type Json, type Result, type Validator } from '@joystyk/contracts';

/**
 * Decodes `value` with a Standard Schema. Runners decode on their ordered input path, so the
 * schema must validate synchronously; an asynchronous schema fails with `AsyncSchema`.
 */
export const decode = <T>(schema: Validator<T>, value: unknown, what: string): Result<T, GameError> => {
  let result: ReturnType<Validator<T>['~standard']['validate']>;
  try {
    result = schema['~standard'].validate(value);
  } catch (error) {
    return err(gameError('InvalidInput', `The ${what} could not be read.`, { reason: String(error) }));
  }
  if (result instanceof Promise) {
    // Keep an unhandled rejection from surfacing; the value is rejected either way.
    result.catch(() => {});
    return err(gameError('AsyncSchema', `The ${what} schema must validate synchronously.`));
  }
  if (result.issues !== undefined) {
    const messages = result.issues.map((issue) => issue.message);
    return err(gameError('InvalidInput', `The ${what} is not valid.`, { issues: messages }));
  }
  return ok(result.value);
};

const isPlain = (value: object): boolean => {
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Freezes plain objects and arrays all the way down, so an accidental mutation throws.
 * Anything else (typed arrays, class instances in a simulation's view) is left alone:
 * freezing a typed array with elements throws.
 */
export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value) || !isPlain(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  return value;
};

/** Deep equality for JSON values, ignoring key order. */
export const jsonEqual = (a: Json | undefined, b: Json | undefined): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, (b as readonly Json[])[i]));
  }
  const ao = a as { readonly [key: string]: Json };
  const bo = b as { readonly [key: string]: Json };
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((key) => Object.hasOwn(bo, key) && jsonEqual(ao[key], bo[key]));
};

/** A deep copy through JSON, as a value would arrive from a worker or a socket. */
export const jsonClone = <T extends Json>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Builds an object without the keys whose value is undefined, so it stays JSON. */
export const compact = <T extends Record<string, unknown>>(value: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = item;
  return out as T;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
