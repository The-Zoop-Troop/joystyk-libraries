import type { Json } from '@joystyk/contracts';
import { canonicalJson } from '../schemas.ts';

/**
 * The content hash of a puzzle's `config`: the first 12 hex digits of SHA-256 over its
 * canonical JSON. Null where Web Crypto's `subtle` is missing (an insecure context).
 */
export const contentHashOf = async (config: Json): Promise<string | null> => {
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  if (subtle === undefined) return null;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(config)));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('');
};
