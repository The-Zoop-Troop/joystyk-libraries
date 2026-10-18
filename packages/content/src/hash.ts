// The content hash, defined once with the daily package: the first 12 hex digits of SHA-256
// over `canonicalJson(config)` from @joystyk/daily (content-pipeline.md, "Puzzle IDs and
// variants"). The browser client checks the same digest with Web Crypto before caching a
// file, so both sides must use the daily package's canonical JSON; hash.test.ts proves they agree.
import { createHash } from 'node:crypto';
import type { Json } from '@joystyk/contracts';
import { canonicalJson } from '@joystyk/daily';

export const contentHash = (config: Json): string =>
  createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex').slice(0, 12);

/** A stable unsigned 32-bit number from a string (FNV-1a), for deterministic picks such as the bank's. */
export const stableIndex = (key: string, modulo: number): number => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return modulo <= 0 ? 0 : hash % modulo;
};
