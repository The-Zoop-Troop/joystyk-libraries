import { describe, expect, it } from 'vitest';
import { formatClock, gridRows, shareText, type ShareLegendEntry } from './index.ts';

type Mark = 'hit' | 'near' | 'miss';

// The Daily Word legend (daily-word.md, "Share text").
const legend: Record<Mark, ShareLegendEntry> = {
  hit: { symbol: '🟩', words: 'right place' },
  near: { symbol: '🟨', words: 'wrong place' },
  miss: { symbol: '⬜' },
};

const board: Mark[][] = [
  ['miss', 'near', 'miss', 'miss', 'miss'],
  ['miss', 'hit', 'near', 'miss', 'near'],
  ['hit', 'hit', 'miss', 'hit', 'miss'],
  ['hit', 'hit', 'hit', 'hit', 'hit'],
];

const URL = 'https://joystyk.example/games/daily-word';

const dailyWord = {
  title: 'Daily Word',
  date: '2026-10-08',
  headline: '4/6',
  rows: gridRows(board, legend, (i) => `Guess ${i + 1}`),
  url: URL,
};

describe('shareText', () => {
  it("reproduces Daily Word's share text", () => {
    expect(shareText(dailyWord)).toBe(
      ['Daily Word 2026-10-08 4/6', '⬜🟨⬜⬜⬜', '⬜🟩🟨⬜🟨', '🟩🟩⬜🟩⬜', '🟩🟩🟩🟩🟩', URL].join('\n'),
    );
  });

  it('spells each row out in words for Copy as text', () => {
    expect(shareText(dailyWord, 'words')).toBe(
      [
        'Daily Word 2026-10-08 4/6',
        'Guess 1: 1 wrong place.',
        'Guess 2: 1 right place, 2 wrong place.',
        'Guess 3: 3 right place.',
        'Guess 4: 5 right place.',
        URL,
      ].join('\n'),
    );
  });

  it("reproduces Crossword's share text, with a variant and a result line and no grid", () => {
    const text = shareText({
      title: 'Crossword',
      date: '2026-10-08',
      variant: 'Quick',
      summary: `Solved in ${formatClock(102_000)}, no help`,
      url: 'https://joystyk.example/games/crossword',
    });
    expect(text).toBe('Crossword 2026-10-08 (Quick)\nSolved in 1:42, no help\nhttps://joystyk.example/games/crossword');
  });

  it('shows a puzzle number in place of the date when given one', () => {
    expect(shareText({ title: 'Daily Word', date: '2026-10-08', number: 412, headline: '4/6 (hard)' })).toBe(
      'Daily Word #412 4/6 (hard)',
    );
  });

  it('never puts a letter outside the header, result line and URL (daily-word.md, test 8)', () => {
    const lines = shareText(dailyWord).split('\n');
    for (const line of lines.slice(1, -1)) expect(line).not.toMatch(/[A-Za-z]/);
  });

  it('refuses letters or digits in a symbol row, so an answer can never leak', () => {
    expect(() => shareText({ ...dailyWord, rows: [{ symbols: '🟩CRANE', words: 'Guess 1' }] })).toThrow(RangeError);
    expect(() => shareText({ ...dailyWord, rows: [{ symbols: 'ÉTÉ', words: 'Guess 1' }] })).toThrow(RangeError);
    expect(() => shareText({ ...dailyWord, rows: [{ symbols: '⬛⬛4', words: 'Guess 1' }] })).toThrow(RangeError);
  });

  it('refuses a URL with a query string or fragment, which could carry tracking', () => {
    expect(() => shareText({ ...dailyWord, url: `${URL}?ref=share` })).toThrow(RangeError);
    expect(() => shareText({ ...dailyWord, url: `${URL}#me` })).toThrow(RangeError);
    expect(() => shareText({ ...dailyWord, url: '/games/daily-word' })).toThrow(RangeError);
  });

  it('refuses line breaks in single-line fields and a date that is not real', () => {
    expect(() => shareText({ ...dailyWord, summary: 'Solved\nCRANE' })).toThrow(RangeError);
    expect(() => shareText({ ...dailyWord, title: 'Daily Word' })).toThrow(RangeError);
    expect(() => shareText({ ...dailyWord, date: '2026-02-30' })).toThrow(RangeError);
  });

  it('leaves out absent parts', () => {
    expect(shareText({ title: 'Sudoku', date: '2026-10-08' })).toBe('Sudoku 2026-10-08');
  });
});

describe('gridRows', () => {
  it('names a row with nothing to count', () => {
    const rows = gridRows([['miss', 'miss']] as Mark[][], legend, (i) => `Guess ${i + 1}`, 'no letters in the word');
    expect(rows).toEqual([{ symbols: '⬜⬜', words: 'Guess 1: no letters in the word' }]);
  });
});

describe('formatClock', () => {
  it('writes minutes and seconds, and hours when there are any', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7_999)).toBe('0:07');
    expect(formatClock(185_000)).toBe('3:05');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(() => formatClock(-1)).toThrow(RangeError);
  });
});

it('permits only separate bounded percentage and fixed found annotations, keeping symbol strings strict', () => {
  const input = {
    title: 'Map Guess',
    date: '2026-10-10',
    rows: [
      { symbols: '🔵🔵⚪⚪⚪', detail: 41, words: 'Guess 1: 41 percent close.' },
      { symbols: '🗺️', detail: 'found' as const, words: 'Guess 2: found.' },
    ],
  };
  expect(shareText(input)).toContain('🔵🔵⚪⚪⚪ 41%\n🗺️ found');
  expect(shareText(input, 'words')).toContain('Guess 1: 41 percent close.\nGuess 2: found.');
  for (const detail of [-1, 101, 0.5, NaN, Infinity, 'Chile'])
    expect(() => shareText({ ...input, rows: [{ symbols: '🗺️', words: 'Found', detail: detail as number }] })).toThrow(
      RangeError,
    );
  expect(() => shareText({ ...input, rows: [{ symbols: '🗺️ found', words: 'Found' }] })).toThrow(RangeError);
  expect(shareText({ ...input, rows: [{ symbols: '⚪', words: 'No marks', detail: 0 }] })).toContain('⚪ 0%');
});
