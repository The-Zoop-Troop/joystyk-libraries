import { ok } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkDisplayName,
  generateName,
  isBlocked,
  isDisplayName,
  NAME_ADJECTIVES,
  NAME_LIMITS,
  NAME_NOUNS,
  NAME_NUMBERS,
  normalizeDisplayName,
} from './index.ts';
import { BLOCKED_ANYWHERE, BLOCKED_NUMBERS, BLOCKED_WORDS } from './blocklist.ts';

const code = (name: string) => {
  const result = checkDisplayName(name);
  return result.ok ? 'ok' : result.error.code;
};

describe('checkDisplayName: shape', () => {
  it('accepts ordinary names and returns them normalized', () => {
    expect(checkDisplayName('  Pixel   Fox 42 ')).toEqual(ok('Pixel Fox 42'));
    expect(checkDisplayName('ada_l')).toEqual(ok('ada_l'));
    expect(checkDisplayName('Mary-Jane')).toEqual(ok('Mary-Jane'));
    // Full-width letters fold to ASCII.
    expect(checkDisplayName('Ｐｉｘｅｌ')).toEqual(ok('Pixel'));
  });

  it.each([
    ['ab', 'TooShort'],
    ['  a  ', 'TooShort'],
    ['A'.repeat(NAME_LIMITS.maxLength + 1), 'TooLong'],
    ['me@example.com', 'Characters'],
    ['www.site.com', 'Characters'],
    ['Fox--Fan', 'Characters'],
    ['-Fox', 'Characters'],
    ['Fox!', 'Characters'],
    ['Zoë', 'Characters'],
    // Cyrillic "а" and "о" look like Latin letters but would dodge the blocklist.
    ['Pаndа', 'Characters'],
    ['Fox 🦊', 'Characters'],
    ['12345', 'NoLetter'],
    ['555', 'NoLetter'],
    ['Call 555 0199', 'TooManyDigits'],
  ])('refuses %j (%s)', (name, expected) => {
    expect(code(name)).toBe(expected);
  });

  it('counts the length in characters', () => {
    expect(code('A'.repeat(NAME_LIMITS.maxLength))).toBe('ok');
    expect(code('A'.repeat(NAME_LIMITS.minLength))).toBe('ok');
  });

  it('never repeats the blocked word in its message', () => {
    const result = checkDisplayName('Shithead');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message.toLowerCase()).not.toContain('shit');
  });
});

describe('checkDisplayName: blocklist', () => {
  it.each([
    'Fuck',
    'fuuuuck you',
    'F U C K',
    'BigShitFan',
    'sh1t',
    'b1tch',
    'Ass',
    'Big Ass',
    'BigAss',
    'Asses',
    'A S S',
    'Tits',
    'n4z1',
    'P0rn',
    'Porn Star',
    'xXx Slayer',
    'Fox 69',
    'Hero 1488',
    'Sexy',
    'boooob',
  ])('blocks %j', (name) => {
    expect(code(name)).toBe('NotAllowed');
  });

  it.each([
    'Classic',
    'Bass Player',
    'Glass',
    'Peacock',
    'Raccoon',
    'Cockatoo',
    'Title',
    'Dickens',
    'Spices',
    'Grape',
    'Therapist',
    'Analyst',
    'Butter',
    'Bob',
    'Scatter',
    'Sussex',
    'Assassin', // contains "ass" twice, but only inside a word
  ])('allows the innocent %j', (name) => {
    expect(code(name)).toBe('ok');
  });

  it('refuses an innocent name now and then, by design', () => {
    // A stem matched across the space. Strict beats clever; the player can roll a name.
    expect(code('Cosmic Untamed')).toBe('NotAllowed');
  });

  it('blocks every listed term written plainly', () => {
    for (const term of [...BLOCKED_ANYWHERE, ...BLOCKED_WORDS]) {
      expect(isBlocked(term), term).toBe(true);
      expect(isBlocked(`Big ${term} Fan`), term).toBe(true);
    }
    for (const number of BLOCKED_NUMBERS) expect(isBlocked(`Fox ${number}`), number).toBe(true);
  });

  it('keeps every term lowercase ASCII, with no duplicates', () => {
    const all = [...BLOCKED_ANYWHERE, ...BLOCKED_WORDS];
    for (const term of all) expect(term).toMatch(/^[a-z]+$/);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('generateName', () => {
  it('makes "Adjective Noun NN" names', () => {
    let calls = 0;
    const random = () => [0, 0.25, 0.5][calls++ % 3] ?? 0;
    expect(generateName(random)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{2}$/);
    expect(generateName(() => 0)).toBe(`${NAME_ADJECTIVES[0]} ${NAME_NOUNS[0]} ${NAME_NUMBERS[0]}`);
    // A random source that returns its upper bound still picks the last item.
    expect(generateName(() => 0.999_999_999)).toBe(
      `${NAME_ADJECTIVES.at(-1)} ${NAME_NOUNS.at(-1)} ${NAME_NUMBERS.at(-1)}`,
    );
  });

  it('only ever makes names the filter accepts', () => {
    // Pure-number tokens are judged on their own, so checking each word pair with one
    // number, and each number on its own, covers every combination.
    for (const adjective of NAME_ADJECTIVES) {
      for (const noun of NAME_NOUNS) {
        const name = `${adjective} ${noun} 42`;
        expect(isDisplayName(name), name).toBe(true);
      }
    }
    for (const number of NAME_NUMBERS) {
      const name = `${NAME_ADJECTIVES[0]} ${NAME_NOUNS[0]} ${number}`;
      expect(isDisplayName(name), name).toBe(true);
    }
  });

  it('has no duplicate words', () => {
    expect(new Set(NAME_ADJECTIVES).size).toBe(NAME_ADJECTIVES.length);
    expect(new Set(NAME_NOUNS).size).toBe(NAME_NOUNS.length);
  });
});

describe('normalizeDisplayName', () => {
  it('trims and collapses whitespace, including tabs and newlines', () => {
    expect(normalizeDisplayName('\tPixel \n Fox ')).toBe('Pixel Fox');
  });
});
