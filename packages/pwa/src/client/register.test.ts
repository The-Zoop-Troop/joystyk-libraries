import { describe, expect, it } from 'vitest';
import { dailyToPrefetch, type DailyPrefetcher } from './register.ts';

const client = (gameId: string): DailyPrefetcher => ({ gameId, prefetch: async () => undefined });

describe('dailyToPrefetch', () => {
  const clients = [client('daily-word'), client('crossword')];

  it('prefetches every daily game in an installed app', () => {
    expect(dailyToPrefetch(clients, { installed: true, pinned: [] }).map((c) => c.gameId)).toEqual([
      'daily-word',
      'crossword',
    ]);
  });

  it('prefetches only the pinned daily games in a browser tab', () => {
    expect(dailyToPrefetch(clients, { installed: false, pinned: ['crossword', 'nim'] }).map((c) => c.gameId)).toEqual([
      'crossword',
    ]);
    expect(dailyToPrefetch(clients, { installed: false, pinned: [] })).toEqual([]);
  });
});
