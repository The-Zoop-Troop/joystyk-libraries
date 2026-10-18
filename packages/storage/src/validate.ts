import { err, isJson, ok, type Json, type Result, type StandardSchemaV1 } from '@joystyk/contracts';
import * as z from 'zod/mini';

/** One validation problem, flattened for notices and logs: `path: message`. */
export type Issue = string;

const describe = (issue: StandardSchemaV1.Issue): Issue => {
  const path = (issue.path ?? [])
    .map((segment) => String(typeof segment === 'object' ? segment.key : segment))
    .join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
};

/**
 * Runs any Standard Schema (D-18) and returns its output or its issues. Works with sync and
 * async validators alike.
 */
export const validate = async <Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<Result<Output, readonly Issue[]>> => {
  const result = await schema['~standard'].validate(value);
  return result.issues === undefined ? ok(result.value) : err(result.issues.map(describe));
};

/**
 * Any JSON value, checked with the contracts' `isJson`: no `undefined`, `NaN`, `Infinity`,
 * `-0`, class instances or cycles.
 */
export const json = z.custom<Json>(isJson, { error: 'Expected a JSON value' });
