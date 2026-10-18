// The results store in real Chromium, over IndexedDB.
import { STREAK_RECORD, type Storage } from '@joystyk/storage';
import { openBrowserStorage } from '@joystyk/storage/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DailyOutcome, DailyResult } from '../index.ts';
import { createDailyResults } from './index.ts';

const PLAYER = '0f8fad5b-d9cb-469f-a165-70867728950e';

const result = (date: string, outcome: DailyOutcome = 'won', extra: Partial<DailyResult> = {}): DailyResult => ({
  puzzleId: `daily-word:${date}`,
  variant: null,
  contentHash: '0123456789ab',
  outcome,
  assisted: false,
  summary: outcome === 'won' ? '4/6' : 'X/6',
  stats: { guesses: 4 },
  shareRows: ['⬜🟨⬜⬜⬜', '🟩🟩🟩🟩🟩'],
  finishedOn: date,
  ...extra,
});

let name = '';
let storage: Storage;

beforeEach(async () => {
  name = `joystyk-daily-results-${Date.now()}-${Math.random()}`;
  storage = await openBrowserStorage({ indexedDb: { name } });
});

afterEach(async () => {
  storage.close();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
});

describe('createDailyResults', () => {
  it('keeps results and returns the streaks they make', async () => {
    const results = createDailyResults(storage, PLAYER);
    await results.record(result('2026-10-06'), '2026-10-06');
    await results.record(result('2026-10-07', 'lost'), '2026-10-07');
    const recorded = await results.record(result('2026-10-08'), '2026-10-08');
    expect(recorded.ok && recorded.value).toMatchObject({
      isNew: true,
      streaks: { current: 3, best: 3, winCurrent: 1, winBest: 1, lastDay: '2026-10-08' },
    });
    const listed = await results.list('daily-word');
    expect(listed.ok && listed.value.map((r) => r.puzzleId)).toEqual([
      'daily-word:2026-10-06',
      'daily-word:2026-10-07',
      'daily-word:2026-10-08',
    ]);
  });

  it('keeps the first result for a puzzle; a finished result stays as it was', async () => {
    const results = createDailyResults(storage, PLAYER);
    await results.record(result('2026-10-08', 'won'), '2026-10-08');
    const again = await results.record(result('2026-10-08', 'lost'), '2026-10-08');
    expect(again.ok && again.value).toMatchObject({ isNew: false, result: { outcome: 'won' } });
    expect((await results.get('daily-word:2026-10-08', null)).ok).toBe(true);
  });

  it("credits a puzzle finished after midnight to its own date, and keeps each variant's result", async () => {
    const results = createDailyResults(storage, PLAYER);
    await results.record(result('2026-10-07', 'won'), '2026-10-07');
    const late = await results.record(
      {
        ...result('2026-10-08', 'completed'),
        puzzleId: 'crossword:2026-10-08',
        variant: 'quick',
        finishedOn: '2026-10-09',
      },
      '2026-10-09',
    );
    expect(late.ok && late.value.streaks).toMatchObject({ current: 1, lastDay: '2026-10-08' });
    await results.record(
      { ...result('2026-10-08', 'completed'), puzzleId: 'crossword:2026-10-08', variant: 'standard' },
      '2026-10-09',
    );
    const crossword = await results.list('crossword');
    expect(crossword.ok && crossword.value.map((r) => r.variant)).toEqual(['quick', 'standard']);
    // The other game's results don't count toward this game's streak.
    const word = await results.streaks('daily-word', '2026-10-08');
    expect(word.ok && word.value.current).toBe(1);
  });

  it('writes the streak records, resets the stored current after a missed date, and never lowers the best', async () => {
    const results = createDailyResults(storage, PLAYER);
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) await results.record(result(date), date);
    const player = storage.player(PLAYER);
    expect(await player.streaks.get('daily-word')).toEqual({
      ok: true,
      value: { current: 3, best: 3, lastDay: '2026-10-03' },
    });

    const opened = await results.streaks('daily-word', '2026-10-08');
    expect(opened.ok && opened.value).toMatchObject({ current: 0, best: 3, winCurrent: 0, winBest: 3 });
    expect(await player.streaks.get('daily-word')).toEqual({
      ok: true,
      value: { current: 0, best: 3, lastDay: '2026-10-03' },
    });
    expect(await storage.records(STREAK_RECORD).get(`${PLAYER}/daily-word/win`)).toEqual({
      ok: true,
      value: { current: 0, best: 3, lastDay: '2026-10-03' },
    });

    // A best the results can no longer show (say, from v2 sync) is kept.
    await player.streaks.set('daily-word', { current: 0, best: 9, lastDay: '2026-10-03' });
    const kept = await results.streaks('daily-word', '2026-10-08');
    expect(kept.ok && kept.value.best).toBe(9);
  });

  it('survives reopening the database', async () => {
    await createDailyResults(storage, PLAYER).record(result('2026-10-08'), '2026-10-08');
    storage.close();
    storage = await openBrowserStorage({ indexedDb: { name } });
    const reopened = await createDailyResults(storage, PLAYER).streaks('daily-word', '2026-10-09');
    expect(reopened.ok && reopened.value).toMatchObject({ current: 1, winCurrent: 1 });
  });

  it('refuses a result that fails its schema and ids that cannot be keys', async () => {
    const results = createDailyResults(storage, PLAYER);
    const bad = await results.record({ ...result('2026-10-08'), contentHash: 'nope' }, '2026-10-08');
    expect(!bad.ok && bad.error.code).toBe('InvalidValue');
    await expect(results.get('not-a-puzzle', null)).rejects.toThrow(RangeError);
    expect(() => createDailyResults(storage, 'no/slashes')).toThrow(RangeError);
  });
});
