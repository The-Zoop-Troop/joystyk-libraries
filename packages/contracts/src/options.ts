import type { JsonObject } from './json.ts';
import type { Mode } from './manifest.ts';
import type { Validator } from './schema.ts';

export type OptionValue = string | number | boolean;
export type GameOption = {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
  readonly modes?: readonly Mode[];
} & (
  | { readonly kind: 'toggle'; readonly default: boolean }
  | {
      readonly kind: 'select';
      readonly default: string | number;
      readonly choices: readonly { readonly label: string; readonly value: string | number }[];
    }
);
const modes = ['solo', 'ai', 'pass-and-play', 'server', 'p2p', 'daily'];
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const label = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
const scalar = (v: unknown): v is string | number =>
  (typeof v === 'string' && v.length <= 500) || (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0));

export const isGameOptions = (input: unknown): input is readonly GameOption[] => {
  if (!Array.isArray(input) || input.length > 30) return false;
  const keys = new Set<string>();
  return input.every((o: unknown) => {
    if (
      !record(o) ||
      typeof o['key'] !== 'string' ||
      !/^[a-z][A-Za-z0-9]{0,49}$/.test(o['key']) ||
      ['constructor', 'prototype'].includes(o['key']) ||
      keys.has(o['key']) ||
      !label(o['label'])
    )
      return false;
    keys.add(o['key']);
    if (o['help'] !== undefined && !label(o['help'])) return false;
    if (
      o['modes'] !== undefined &&
      (!Array.isArray(o['modes']) || !o['modes'].every((m) => typeof m === 'string' && modes.includes(m)))
    )
      return false;
    if (o['kind'] === 'toggle') return typeof o['default'] === 'boolean';
    if (
      o['kind'] !== 'select' ||
      !scalar(o['default']) ||
      !Array.isArray(o['choices']) ||
      o['choices'].length === 0 ||
      o['choices'].length > 50
    )
      return false;
    const values = new Set<string>();
    return (
      o['choices'].every((c: unknown) => {
        if (!record(c) || !label(c['label']) || !scalar(c['value'])) return false;
        const key = String(c['value']);
        if (values.has(key)) return false;
        values.add(key);
        return true;
      }) && o['choices'].some((c) => record(c) && c['value'] === o['default'])
    );
  });
};

export const optionsForMode = (options: readonly GameOption[], mode: Mode): readonly GameOption[] =>
  options.filter((o) =>
    mode === 'daily' ? o.modes?.includes('daily') === true : o.modes === undefined || o.modes.includes(mode),
  );

/** A Standard Schema boundary for untrusted setup values. Reject unknown keys; defaults
 * come from the manifest and mode-specific fields never leak across modes. */
export const setupOptions = (options: readonly GameOption[], mode: Mode): Validator<JsonObject> => ({
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate(input) {
      if (!record(input)) return { issues: [{ message: 'Game options must be an object.' }] };
      const active = optionsForMode(options, mode);
      const out: Record<string, OptionValue> = {};
      for (const key of Object.keys(input))
        if (!active.some((o) => o.key === key)) return { issues: [{ message: `Unknown game option: ${key}.` }] };
      for (const o of active) {
        const value = Object.hasOwn(input, o.key) ? input[o.key] : o.default;
        if (o.kind === 'toggle' ? typeof value !== 'boolean' : !o.choices.some((c) => c.value === value))
          return { issues: [{ message: `Choose a valid ${o.label.toLowerCase()}.`, path: [o.key] }] };
        out[o.key] = value as OptionValue;
      }
      return { value: out };
    },
  },
});
