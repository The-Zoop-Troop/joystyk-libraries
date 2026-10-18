// String hashing for seeds. Integer-only, so every JavaScript engine gives the same answer.

/**
 * Encodes a string as UTF-8 bytes. Hand-written rather than `TextEncoder`, which the kit's
 * ES2023-only type environment doesn't declare. A lone surrogate becomes U+FFFD, exactly as
 * `TextEncoder` does, so the result matches it for every string.
 */
export const utf8 = (text: string): Uint8Array => {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
};

const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));

/**
 * MurmurHash3, x86 32-bit variant (Austin Appleby, public domain), over the UTF-8 bytes of
 * `text`. Returns an unsigned 32-bit integer. It is well known, has published test vectors
 * and needs only `Math.imul`, shifts and xor, so it is exact everywhere. Not cryptographic:
 * it spreads seed strings over the RNG state; it doesn't hide them.
 */
export const murmur3 = (text: string, seed = 0): number => {
  const bytes = utf8(text);
  const length = bytes.length;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = length - (length % 4);
  for (let i = 0; i < blocks; i += 4) {
    let k = (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0;
    k = Math.imul(k, c1);
    k = rotl(k, 15);
    k = Math.imul(k, c2);
    h ^= k;
    h = rotl(h, 13);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const tail = length % 4;
  if (tail > 0) {
    let k = 0;
    if (tail === 3) k ^= bytes[blocks + 2]! << 16;
    if (tail >= 2) k ^= bytes[blocks + 1]! << 8;
    k ^= bytes[blocks]!;
    k = Math.imul(k, c1);
    k = rotl(k, 15);
    k = Math.imul(k, c2);
    h ^= k;
  }
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
