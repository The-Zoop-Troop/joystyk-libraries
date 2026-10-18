import { isIP } from 'node:net';

/** Canonical rate-limit key: IPv4 per address, IPv6 per /64, mapped IPv4 as IPv4. */
export function rateLimitKey(address: string): string {
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return 'unknown';
  // WHATWG parsing canonicalizes compressed, mixed-case and dotted-tail forms without IO.
  const host = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const [head = '', tail] = host.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const words = (
    tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  ).map((word) => parseInt(word, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return [words[6]! >>> 8, words[6]! & 255, words[7]! >>> 8, words[7]! & 255].join('.');
  }
  return `${words
    .slice(0, 4)
    .map((word) => word.toString(16))
    .join(':')}::/64`;
}
