// Small Node-side helpers: structured logs, the clock, secrets and client addresses.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Json } from '@joystyk/contracts';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH } from '../protocol/index.ts';

// ── Logs ────────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * One JSON object per line (section 9). Callers never pass tokens, token hashes, display
 * names, IP addresses or game state: every visitor may be a child (D-26).
 */
export interface Logger {
  write(level: LogLevel, event: string, fields?: { readonly [k: string]: Json }): void;
}

export const createLogger = (
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  now: () => number = Date.now,
): Logger => ({
  write: (level, event, fields = {}) =>
    sink(JSON.stringify({ ts: new Date(now()).toISOString(), level, event, ...fields })),
});

/** A logger that keeps lines in memory, for tests. */
export const memoryLogger = (): Logger & {
  readonly lines: { level: LogLevel; event: string; fields: { readonly [k: string]: Json } }[];
} => {
  const lines: { level: LogLevel; event: string; fields: { readonly [k: string]: Json } }[] = [];
  return { lines, write: (level, event, fields = {}) => void lines.push({ level, event, fields }) };
};

// ── Clock ───────────────────────────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  /** Calls `fire` at `at` (epoch ms). Firing early, late or twice is harmless to the core. */
  setTimer(at: number, fire: () => void): { cancel(): void };
}

/** Node's timers cap a delay at about 24.8 days; longer waits re-arm. */
const MAX_DELAY = 2 ** 31 - 1;

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (at, fire) => {
    let handle: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      const delay = Math.max(0, at - Date.now());
      handle = setTimeout(delay > MAX_DELAY ? arm : fire, Math.min(delay, MAX_DELAY));
      handle.unref?.();
    };
    arm();
    return { cancel: () => clearTimeout(handle) };
  },
};

// ── Secrets ─────────────────────────────────────────────────────────────────────────────

/** A seat token: 24 random bytes, base64url (32 characters). Never logged or stored. */
export const newSeatToken = (): string => randomBytes(24).toString('base64url');

/** The SHA-256 hex digest the room stores in place of a token. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A fresh invite code from the room alphabet. */
export const newRoomCode = (): string =>
  Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');

/** `count` uniformly random 32-bit words from the CSPRNG, for seeding a match's rng. */
export const randomWords = (count: number): number[] => {
  const bytes = randomBytes(count * 4);
  return Array.from({ length: count }, (_, i) => bytes.readUInt32LE(i * 4));
};

// ── Client addresses ────────────────────────────────────────────────────────────────────

const normalize = (address: string): string => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

/** Parses `TRUSTED_PROXY`: one address or a CIDR range. Throws on anything else. */
export const parseTrustedProxy = (value: string): BlockList => {
  const list = new BlockList();
  const [address = '', prefix] = value.split('/');
  const family = isIP(address);
  if (family === 0) throw new Error('TRUSTED_PROXY must be an IP address or a CIDR range such as 172.18.0.0/16.');
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (prefix === undefined) {
    list.addAddress(address, type);
  } else {
    const bits = Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128))
      throw new Error('TRUSTED_PROXY has an invalid prefix length.');
    list.addSubnet(address, bits, type);
  }
  return list;
};

/**
 * The visitor's address. Only a trusted proxy (Traefik) may report it, through the configured
 * header or else the last `X-Forwarded-For` entry; anyone else is taken at their socket's word.
 */
export const clientAddress = (request: IncomingMessage, trusted: BlockList | null, header: string | null): string => {
  const peer = normalize(request.socket.remoteAddress ?? 'unknown');
  const family = isIP(peer);
  if (trusted === null || family === 0 || !trusted.check(peer, family === 4 ? 'ipv4' : 'ipv6')) return peer;
  const raw =
    header === null
      ? String(request.headers['x-forwarded-for'] ?? '')
          .split(',')
          .at(-1)
      : request.headers[header.toLowerCase()];
  const reported = normalize(String(Array.isArray(raw) ? raw.at(-1) : (raw ?? '')).trim());
  return isIP(reported) === 0 ? peer : reported;
};

// ── Rate limits ─────────────────────────────────────────────────────────────────────────

/** Counts events per key in a sliding window, in memory only (section 8). */
export class WindowCounter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly max: number;

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  /** True if `key` is still under the limit; records the hit when `record` is set. */
  allow(key: string, now: number, record = true): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.max;
    if (ok && record) recent.push(now);
    this.hits.set(key, recent);
    return ok;
  }

  hit(key: string, now: number): void {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.hits.set(key, recent);
  }

  prune(now: number): void {
    for (const [key, times] of this.hits) if (!times.some((t) => now - t < this.windowMs)) this.hits.delete(key);
  }
}

/** A token bucket: `rate` per second, holding at most `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;

  constructor(rate: number, burst: number, now: number) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
