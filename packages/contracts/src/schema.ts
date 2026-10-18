import type { StandardSchemaV1 } from './standard-schema.ts';

/**
 * A Standard Schema (D-18) that decodes unknown input into `T`. Every boundary type in this
 * package uses it: the platform validates with it, and the game picks the library (Zod 4 by
 * default, D-22; Effect Schema through `Schema.standardSchemaV1`).
 *
 * The schema's input type is left open, so a schema that fills defaults or transforms its
 * input (its input type differs from its output) still fits.
 */
export type Validator<T> = StandardSchemaV1<unknown, T>;
