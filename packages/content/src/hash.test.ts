import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '@joystyk/contracts';
import { canonicalJson, dailyEnvelope, dailyIndex, decode } from '@joystyk/daily';
import { describe, expect, it } from 'vitest';
import { contentHash, stableIndex } from './hash.ts';
import { createPublisher } from './publish.ts';

const configs: Json[] = [
  { b: 1, a: [1, 2, { z: null, y: 'é' }] },
  { puzzleId: 'word-of-the-day:2026-10-08', entry: { word: 'brisk', options: ['a', 'b'] } },
  'plain',
  [],
];

/** The daily client's definition (daily/src/browser/hash.ts): Web Crypto SHA-256 over canonical JSON, 6 bytes as hex. */
const webCryptoHash = async (config: Json): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(config)));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('the content hash', () => {
  it('matches the daily client, which hashes with Web Crypto', async () => {
    for (const config of configs) expect(contentHash(config)).toBe(await webCryptoHash(config));
  });

  it('ignores key order and is 12 hex digits', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{12}$/);
  });

  it('picks bank indexes stably', () => {
    expect(stableIndex('word-of-the-day:2026-10-08', 12)).toBe(stableIndex('word-of-the-day:2026-10-08', 12));
    expect(stableIndex('x', 0)).toBe(0);
  });
});

describe('the publisher', () => {
  it('writes files and an index that the daily package decodes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-'));
    try {
      const publisher = createPublisher(dir);
      const config = { hello: 'world' };
      const file = publisher.writePuzzle('demo-game', '2026-10-08', config);
      publisher.writeIndex('demo-game', [{ date: '2026-10-08', hash: file.hash, size: file.size }]);
      const index = await decode(dailyIndex, JSON.parse(readFileSync(join(dir, 'demo-game/index.json'), 'utf8')));
      expect(index.ok).toBe(true);
      const envelope = dailyEnvelope(
        { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } },
        { gameId: 'demo-game', date: '2026-10-08', contentHash: file.hash },
      );
      const decoded = await decode(envelope, JSON.parse(readFileSync(join(dir, file.file), 'utf8')));
      expect(decoded.ok && decoded.value.config).toEqual(config);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
