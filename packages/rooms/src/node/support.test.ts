import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  clientAddress,
  hashToken,
  newRoomCode,
  newSeatToken,
  parseTrustedProxy,
  TokenBucket,
  WindowCounter,
} from './support.ts';

const request = (peer: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

describe('client addresses', () => {
  it('ignores forwarding headers from anyone but the trusted proxy', () => {
    const trusted = parseTrustedProxy('172.18.0.0/16');
    expect(clientAddress(request('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }), trusted, null)).toBe('203.0.113.9');
    expect(clientAddress(request('::ffff:172.18.0.3', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), trusted, null)).toBe(
      '1.2.3.4',
    );
    expect(clientAddress(request('172.18.0.3', { 'x-real-ip': '5.6.7.8' }), trusted, 'X-Real-IP')).toBe('5.6.7.8');
    expect(clientAddress(request('172.18.0.3', { 'x-forwarded-for': 'garbage' }), trusted, null)).toBe('172.18.0.3');
    expect(clientAddress(request('10.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), null, null)).toBe('10.0.0.1');
  });

  it('accepts one address or a CIDR range, and nothing else', () => {
    expect(parseTrustedProxy('10.0.0.2').check('10.0.0.2', 'ipv4')).toBe(true);
    expect(parseTrustedProxy('fd00::/8').check('fd12::1', 'ipv6')).toBe(true);
    expect(() => parseTrustedProxy('traefik')).toThrow();
    expect(() => parseTrustedProxy('10.0.0.0/40')).toThrow();
  });
});

describe('secrets and limits', () => {
  it('makes 32-character tokens, hashes them, and makes valid room codes', () => {
    const token = newSeatToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(newRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('counts per key in a window and refills a bucket over time', () => {
    const counter = new WindowCounter(1_000, 2);
    expect([counter.allow('a', 0), counter.allow('a', 1), counter.allow('a', 2), counter.allow('b', 2)]).toEqual([
      true,
      true,
      false,
      true,
    ]);
    expect(counter.allow('a', 1_001)).toBe(true);
    const bucket = new TokenBucket(10, 2, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, false]);
    expect(bucket.take(100)).toBe(true);
  });
});
