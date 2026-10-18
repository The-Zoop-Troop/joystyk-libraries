/** A JSON primitive. Numbers must be finite and never `-0`. */
export type JsonPrimitive = null | boolean | number | string;

/** A JSON array. Mutable arrays are accepted too. */
export type JsonArray = readonly Json[];

/** A JSON object. Optional keys are fine; a key whose value is `undefined` is not. */
export type JsonObject = { readonly [key: string]: Json };

/**
 * A value that survives `JSON.parse(JSON.stringify(value))` unchanged. Everything that crosses
 * a boundary is JSON: state, commands, views, events, configuration, saves and job payloads.
 *
 * Declare a type you want to pass where `Json` is expected with `type`, not `interface`.
 * TypeScript gives interfaces no implicit index signature, so an interface never satisfies
 * `JsonObject`, even when every property is JSON. That is why the data shapes in this
 * package are all type aliases.
 *
 * The type can't rule out `NaN`, `Infinity` or `-0`, which are numbers; `isJson` does.
 */
export type Json = JsonPrimitive | JsonArray | JsonObject;

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const check = (value: unknown, ancestors: Set<object>): boolean => {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return true;
    case 'number':
      // NaN and ±Infinity become null; -0 becomes 0.
      return Number.isFinite(value) && !Object.is(value, -0);
    case 'object': {
      if (value === null) return true;
      // A cycle can't be serialized at all.
      if (ancestors.has(value)) return false;
      ancestors.add(value);
      const ok = Array.isArray(value)
        ? checkArray(value, ancestors)
        : isPlainObject(value) && checkObject(value, ancestors);
      ancestors.delete(value);
      return ok;
    }
    default:
      // undefined, functions, symbols and bigints.
      return false;
  }
};

const checkArray = (value: readonly unknown[], ancestors: Set<object>): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    // A hole in a sparse array becomes null.
    if (!(i in value) || !check(value[i], ancestors)) return false;
  }
  return true;
};

const checkObject = (value: object, ancestors: Set<object>): boolean => {
  // Symbol keys are dropped by JSON.stringify, so a value carrying one doesn't round-trip.
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  for (const key of Object.keys(value)) {
    if (!check((value as Record<string, unknown>)[key], ancestors)) return false;
  }
  return true;
};

/**
 * True when `value` is JSON that survives a round trip unchanged: plain objects and arrays
 * of finite numbers (not `-0`), strings, booleans and null, with no `undefined`, holes,
 * cycles, symbol keys, class instances (`Date`, `Map`, …) or functions.
 */
export const isJson = (value: unknown): value is Json => check(value, new Set());
