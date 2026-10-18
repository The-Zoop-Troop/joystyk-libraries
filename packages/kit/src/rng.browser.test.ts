// The same known answers as rng.test.ts, run in real Chromium: a seed must give the same
// stream in the browser as on the server, or replays and room authority break.
import type { Rng } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { dailySeed } from './daily.ts';
import { RAW_STEPS, SEEDS, SHUFFLES } from './known-answers.test-util.ts';
import { createRng, restoreRng, seedState } from './rng.ts';

const u32s = (rng: Rng, n: number): number[] => Array.from({ length: n }, () => rng.int(0, 2 ** 32));

describe('known answers in the browser', () => {
  it('steps SFC32 from raw states', () => {
    for (const { state, outputs, after } of RAW_STEPS) {
      const rng = restoreRng(state);
      expect(u32s(rng, outputs.length)).toEqual(outputs);
      expect(rng.save()).toEqual(after);
    }
  });

  it('seeds from strings, daily ids included', () => {
    for (const { seed, words, outputs } of SEEDS) {
      expect(seedState(seed).words).toEqual(words);
      expect(u32s(createRng(seed), outputs.length)).toEqual(outputs);
    }
    expect(dailySeed('klondike', '2026-10-08').words).toEqual(SEEDS[1]!.words);
  });

  it('shuffles, then draws floats and dice', () => {
    for (const { seed, size, shuffled, floats, dice } of SHUFFLES) {
      const rng = createRng(seed);
      expect(rng.shuffle(Array.from({ length: size }, (_, i) => i))).toEqual(shuffled);
      expect(floats.map(() => rng.next())).toEqual(floats);
      expect(dice.map(() => rng.int(1, 7))).toEqual(dice);
    }
  });
});
