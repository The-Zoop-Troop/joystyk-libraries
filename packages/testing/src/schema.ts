// Running Standard Schemas from tests.

import type { StandardSchemaV1, Validator } from '@joystyk/contracts';

/** The outcome of validating one value. */
export type Validation<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly StandardSchemaV1.Issue[] };

/** Validates `value` with a Standard Schema, sync or async. */
export const validate = async <T>(schema: Validator<T>, value: unknown): Promise<Validation<T>> => {
  const result = await schema['~standard'].validate(value);
  return result.issues === undefined ? { ok: true, value: result.value } : { ok: false, issues: result.issues };
};

/** Issues as one line: "message at path; message". */
export const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string =>
  issues
    .slice(0, 3)
    .map((issue) => {
      const path = (issue.path ?? []).map((p) => String(typeof p === 'object' ? p.key : p)).join('.');
      return path === '' ? issue.message : `${issue.message} at ${path}`;
    })
    .join('; ') + (issues.length > 3 ? ` (+${issues.length - 3} more)` : '');
