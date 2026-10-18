// The ranked word list: lowercase SCOWL words with their size levels, and the score a size gives.
import { describe, expect, it } from 'vitest';
import { parseRanked, rankedWords, scoreOfSize } from './ranked.ts';

describe('the ranked word list', () => {
  it('lists common lowercase words with their size, and no names or abbreviations', () => {
    const ranked = rankedWords();
    expect(ranked.get('garden')).toBe(10);
    expect(ranked.has('london')).toBe(false);
    expect(ranked.has('nasa')).toBe(false);
    for (const [word, size] of ranked) {
      expect(word).toMatch(/^[a-z]{3,12}$/);
      expect(size).toBeLessThanOrEqual(60);
    }
  });

  it('parses lines and skips comments and junk', () => {
    expect([...parseRanked('# note\ncat 10\n\nDog 20\nbird x\n')]).toEqual([['cat', 10]]);
  });

  it('scores size 10 as 100 and size 60 as 40', () => {
    expect([10, 20, 35, 40, 50, 55, 60].map(scoreOfSize)).toEqual([100, 90, 75, 70, 60, 50, 40]);
  });
});
