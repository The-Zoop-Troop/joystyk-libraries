// A tiny Standard Schema (D-18) for the two small files the worker and the offline page read:
// the kill-switch flag and a pin's record. A schema library would outweigh both scripts, and
// the worker has to stay small (Rule 5). The page decodes the larger asset manifest with Zod.
import type { Validator } from '@joystyk/contracts';

/** A synchronous Standard Schema validator from a check that reports issues by message. */
export const validator = <T>(check: (value: unknown, issues: string[]) => T | undefined): Validator<T> => ({
  '~standard': {
    version: 1,
    vendor: 'joystyk-pwa',
    validate: (value: unknown) => {
      const issues: string[] = [];
      const output = check(value, issues);
      return issues.length === 0 && output !== undefined
        ? { value: output }
        : { issues: (issues.length === 0 ? ['Invalid value'] : issues).map((message) => ({ message })) };
    },
  },
});

/** Decodes with a synchronous validator: the value, or null when it fails. */
export const decodeSync = <T>(schema: Validator<T>, value: unknown): T | null => {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) return null;
  return result.issues === undefined ? result.value : null;
};

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A same-origin path: starts with one slash. */
export const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
