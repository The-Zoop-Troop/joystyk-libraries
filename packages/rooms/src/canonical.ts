// Canonical JSON and a small pure hash, for receipt fingerprints and change detection. Pure
// and deterministic in every JavaScript engine: integer arithmetic through Math.imul only.
import type { Json } from '@joystyk/contracts';

/** JSON with object keys sorted, so equal values always produce the same text. */
export const canonicalJson = (value: Json): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item: Json) => canonicalJson(item)).join(',')}]`;
  const object = value as { readonly [key: string]: Json };
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as Json)}`).join(',')}}`;
};

/**
 * A 64-bit hash of a string as 16 hex digits (two independent 32-bit FNV-1a style lanes).
 * Not cryptographic: it only tells a retried action from a different one with the same ID.
 */
export const hashText = (text: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 13;
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b);
};

/** The receipt fingerprint of an action: canonical JSON of what the client sent, hashed. */
export const fingerprint = (value: Json): string => hashText(canonicalJson(value));
