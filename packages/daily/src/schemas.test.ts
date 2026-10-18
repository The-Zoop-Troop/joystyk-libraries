import type { StandardSchemaV1 } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import {
  canonicalJson,
  dailyEnvelope,
  dailyIndex,
  dailyResult,
  decode,
  isPuzzleId,
  parsePuzzleId,
  puzzleId,
  type DailyResult,
} from './index.ts';

const config = z.object({ answer: z.string().check(z.length(5)), hard: z.optional(z.boolean()) });

const file = {
  schemaVersion: 1,
  puzzleId: 'daily-word:2026-10-08',
  date: '2026-10-08',
  contentHash: '0123456789ab',
  config: { answer: 'PQVJO' },
};

describe('puzzle ids', () => {
  it('builds and parses <game>:<yyyy-mm-dd>', () => {
    expect(puzzleId('daily-word', '2026-10-08')).toBe('daily-word:2026-10-08');
    expect(parsePuzzleId('crossword:2028-02-29')).toEqual({ gameId: 'crossword', date: '2028-02-29' });
    expect(parsePuzzleId('crossword:2027-02-29')).toBeNull();
    expect(parsePuzzleId('Crossword:2026-10-08')).toBeNull();
    expect(parsePuzzleId('crossword')).toBeNull();
    expect(isPuzzleId('hangman:word:apple')).toBe(false);
    expect(() => puzzleId('Daily Word', '2026-10-08')).toThrow(RangeError);
  });
});

describe('dailyEnvelope', () => {
  it("decodes the wrapper, then the config with the game's schema", async () => {
    const decoded = await decode(dailyEnvelope(config), file);
    expect(decoded).toEqual({ ok: true, value: file });
  });

  it('reports config issues under config', async () => {
    const decoded = await decode(dailyEnvelope(config), { ...file, config: { answer: 'TOOLONG' } });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error[0]).toMatch(/^config\.answer: /);
  });

  it('refuses a file for another game, date or hash than the one requested', async () => {
    const schema = (expected: Parameters<typeof dailyEnvelope>[1]) => dailyEnvelope(config, expected);
    expect((await decode(schema({ gameId: 'crossword' }), file)).ok).toBe(false);
    expect((await decode(schema({ date: '2026-10-09' }), file)).ok).toBe(false);
    expect((await decode(schema({ contentHash: 'ffffffffffff' }), file)).ok).toBe(false);
    expect(
      (await decode(schema({ gameId: 'daily-word', date: '2026-10-08', contentHash: '0123456789ab' }), file)).ok,
    ).toBe(true);
  });

  it("refuses a wrapper whose id and date disagree, or that isn't a puzzle file at all", async () => {
    expect((await decode(dailyEnvelope(config), { ...file, date: '2026-10-09' })).ok).toBe(false);
    expect((await decode(dailyEnvelope(config), { ...file, schemaVersion: 2 })).ok).toBe(false);
    expect((await decode(dailyEnvelope(config), { ...file, contentHash: 'ABC' })).ok).toBe(false);
    expect((await decode(dailyEnvelope(config), null)).ok).toBe(false);
    expect((await decode(dailyEnvelope(config), { ...file, config: undefined })).ok).toBe(false);
  });

  it('works with an async Standard Schema from any library', async () => {
    const asyncConfig: StandardSchemaV1<unknown, { answer: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) =>
          typeof value === 'object' && value !== null && 'answer' in value
            ? { value: { answer: String(value.answer) } }
            : { issues: [{ message: 'no answer', path: ['answer'] }] },
      },
    };
    expect((await decode(dailyEnvelope(asyncConfig), file)).ok).toBe(true);
    expect(await decode(dailyEnvelope(asyncConfig), { ...file, config: {} })).toEqual({
      ok: false,
      error: ['config.answer: no answer'],
    });
  });
});

describe('dailyIndex', () => {
  const index = {
    schemaVersion: 1,
    gameId: 'daily-word',
    dates: [
      { date: '2026-10-08', hash: '0123456789ab', size: 512 },
      { date: '2026-10-09', hash: 'abcdef012345', size: 498 },
    ],
  };

  it('decodes an index and refuses duplicate dates or bad hashes', async () => {
    expect((await decode(dailyIndex, index)).ok).toBe(true);
    expect((await decode(dailyIndex, { ...index, dates: [...index.dates, index.dates[0]] })).ok).toBe(false);
    expect((await decode(dailyIndex, { ...index, dates: [{ date: '2026-10-08', hash: 'xyz', size: 1 }] })).ok).toBe(
      false,
    );
    expect((await decode(dailyIndex, { ...index, gameId: 'Daily Word' })).ok).toBe(false);
  });
});

describe('dailyResult', () => {
  const result: DailyResult = {
    puzzleId: 'crossword:2026-10-08',
    variant: 'quick',
    contentHash: '0123456789ab',
    outcome: 'completed',
    assisted: true,
    summary: 'Solved in 3:05 with 2 checks and 1 reveal',
    stats: { checks: 2, reveals: 1 },
    shareRows: [],
    finishedOn: '2026-10-09',
  };

  it('decodes a result and refuses broken ones', async () => {
    expect(await decode(dailyResult, result)).toEqual({ ok: true, value: result });
    expect((await decode(dailyResult, { ...result, variant: null })).ok).toBe(true);
    expect((await decode(dailyResult, { ...result, variant: 'Quick' })).ok).toBe(false);
    expect((await decode(dailyResult, { ...result, outcome: 'draw' })).ok).toBe(false);
    expect((await decode(dailyResult, { ...result, puzzleId: 'crossword' })).ok).toBe(false);
    expect((await decode(dailyResult, { ...result, finishedOn: '2026-02-30' })).ok).toBe(false);
    expect((await decode(dailyResult, { ...result, stats: { time: Number.NaN } })).ok).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth and leaves no whitespace', () => {
    expect(canonicalJson({ b: [3, { d: 1, c: 'é' }], a: null, B: true })).toBe(
      '{"B":true,"a":null,"b":[3,{"c":"é","d":1}]}',
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

it('preserves legacy daily results and validates separately persisted share annotations', () => {
  const base = {
    puzzleId: 'map-guess:2026-10-10',
    variant: null,
    contentHash: 'a'.repeat(12),
    outcome: 'won',
    assisted: false,
    summary: '2/6',
    stats: {},
    shareRows: ['🔵⚪', '🗺️'],
    shareWords: ['41 percent close', 'found'],
    finishedOn: '2026-10-10',
  };
  expect(dailyResult['~standard'].validate(base)).not.toHaveProperty('issues');
  expect(dailyResult['~standard'].validate({ ...base, shareDetails: [41, 'found'] })).not.toHaveProperty('issues');
  for (const detail of [-1, 101, 0.5, 'Chile'])
    expect(dailyResult['~standard'].validate({ ...base, shareDetails: [detail] })).toHaveProperty('issues');
});

it('keeps complete spoken move histories, with a bounded 1000-character row', () => {
  const base = {
    puzzleId: 'gem-swap:2026-10-10',
    variant: null,
    contentHash: 'a'.repeat(12),
    outcome: 'won',
    assisted: false,
    summary: 'Three stars',
    stats: {},
    shareRows: ['🟩'.repeat(25)],
    finishedOn: '2026-10-10',
  };
  expect(dailyResult['~standard'].validate({ ...base, shareWords: ['x'.repeat(1000)] })).not.toHaveProperty('issues');
  expect(dailyResult['~standard'].validate({ ...base, shareWords: ['x'.repeat(1001)] })).toHaveProperty('issues');
});
