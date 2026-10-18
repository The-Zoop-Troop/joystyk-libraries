// Structural helpers for comparing and protecting values the suites pass around.

const describeValue = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' && Object.is(value, -0)) return '-0';
  if (typeof value === 'function') return 'a function';
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  } catch {
    return String(value);
  }
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const pathKey = (path: string, key: string): string =>
  /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

/**
 * The first place where `a` and `b` differ, as a readable path with both values, or null when
 * they are structurally equal. Numbers compare with `Object.is`, so `0` and `-0` differ, and
 * a missing key differs from a key holding `undefined`.
 */
export const firstDifference = (a: unknown, b: unknown, path = '$'): string | null => {
  if (Object.is(a, b)) return null;
  if (!isObject(a) || !isObject(b)) return `${path}: ${describeValue(a)} vs ${describeValue(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: ${describeValue(a)} vs ${describeValue(b)}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d !== null) return d;
    }
    return null;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return `${pathKey(path, key)}: ${describeValue(a[key])} vs (missing)`;
  }
  for (const key of keysB) {
    if (!Object.hasOwn(a, key)) return `${pathKey(path, key)}: (missing) vs ${describeValue(b[key])}`;
  }
  for (const key of keysA) {
    const d = firstDifference(a[key], b[key], pathKey(path, key));
    if (d !== null) return d;
  }
  return null;
};

/** True when `a` and `b` are structurally equal (see `firstDifference`). */
export const deepEqual = (a: unknown, b: unknown): boolean => firstDifference(a, b) === null;

/**
 * Freezes `value` and everything reachable from it, then returns it. The suites freeze every
 * state, command and input they hand to an engine, so an engine that mutates its input
 * throws instead of silently corrupting the game.
 */
export const deepFreeze = <T>(value: T): T => {
  if (isObject(value) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

/**
 * Why `value` isn't JSON, with the path to the first offending part, or null when it is.
 * The contract's `isJson` answers yes or no; failure messages need the where and why.
 */
export const jsonProblem = (value: unknown, path = '$', seen: Set<object> = new Set()): string | null => {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      if (Object.is(value, -0)) return `-0 at ${path} (JSON turns it into 0)`;
      return Number.isFinite(value) ? null : `${value} at ${path}`;
    case 'object': {
      if (value === null) return null;
      if (seen.has(value)) return `a cycle at ${path}`;
      const proto: unknown = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
        return `a ${(value as object).constructor?.name ?? 'class'} instance at ${path}`;
      }
      if (Object.getOwnPropertySymbols(value).length > 0) return `a symbol key at ${path}`;
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i += 1) {
            if (!(i in value)) return `a hole at ${path}[${i}]`;
            const problem = jsonProblem(value[i], `${path}[${i}]`, seen);
            if (problem !== null) return problem;
          }
          return null;
        }
        for (const key of Object.keys(value)) {
          const problem = jsonProblem((value as Record<string, unknown>)[key], pathKey(path, key), seen);
          if (problem !== null) return problem;
        }
        return null;
      } finally {
        seen.delete(value);
      }
    }
    default:
      return `${value === undefined ? 'undefined' : typeof value} at ${path}`;
  }
};

/** A JSON round trip: what a value looks like after a socket, a save or a replay file. */
export const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A short, single-line rendering of any value for failure messages. */
export const show = describeValue;

/** The message of anything thrown. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `thrown value ${describeValue(error)}`;
