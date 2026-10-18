// Spoiler-free share text (content-pipeline.md, "Share text"). The shape is shared; each game
// supplies its result line and symbol rows. Share text never carries answer letters, clue
// text, theme words, the player's name or a tracking parameter.

import { isIsoDate } from './dates.ts';

/**
 * One row of a result grid, in two forms: emoji symbols for *Share*, and the same row in
 * plain words for *Copy as text*, which screen readers read well.
 */
export type ShareRow = {
  /** Symbols only, e.g. "⬜🟨⬜⬜⬜". Letters and bare digits are refused; numeric keycap emoji are symbols. */
  readonly symbols: string;
  /** The row in words, e.g. "Guess 1: 1 wrong place". */
  readonly words: string;
  /** Optional spoiler-free suffix: a whole percentage (0–100) or the fixed word found. */
  readonly detail?: number | 'found';
};

export type ShareInput = {
  /** The game's display name, e.g. "Daily Word". */
  readonly title: string;
  /** The puzzle's date, `yyyy-mm-dd`. Shown in the header unless `number` is given. */
  readonly date: string;
  /** A puzzle number from `puzzleNumber`, shown as "#412" in place of the date. */
  readonly number?: number;
  /** The variant's display name, shown in brackets: "Quick". */
  readonly variant?: string | null;
  /** A short result that ends the header line, e.g. "4/6" or "4/6 (hard)". */
  readonly headline?: string;
  /** A result line of its own, e.g. "Solved in 1:42, no help". */
  readonly summary?: string;
  readonly rows?: readonly ShareRow[];
  /** The game page's absolute URL, with no query string or fragment. */
  readonly url?: string;
};

/** `symbols`: the emoji form for *Share*. `words`: the plain form for *Copy as text*. */
export type ShareForm = 'symbols' | 'words';

const NUMERIC_KEYCAP = /[0-9]\uFE0F?\u20E3/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const LINE_BREAK = /[\r\n\p{Zl}\p{Zp}]/u;
const PAGE_URL = /^https?:\/\/[^\s?#]+$/;

const singleLine = (field: string, value: string): string => {
  if (LINE_BREAK.test(value)) throw new RangeError(`Share text ${field} must be a single line.`);
  return value.trim();
};

const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * The text to share, in either form. Lines: a header (`<title> <date or #number>`, the
 * variant in brackets, then the headline), the summary line, the rows and the URL; absent
 * parts are left out. In the `words` form each row is a sentence on its own line.
 *
 * Throws a `RangeError` for a symbol row containing a letter or bare digit, a field with a line
 * break, or a URL with a query string or fragment: each is a bug that could leak a spoiler or
 * a tracking parameter.
 */
export const shareText = (input: ShareInput, form: ShareForm = 'symbols'): string => {
  if (!isIsoDate(input.date)) throw new RangeError(`Expected a "yyyy-mm-dd" date, got ${JSON.stringify(input.date)}.`);
  const label = input.number === undefined ? input.date : `#${input.number}`;
  if (input.number !== undefined && !Number.isSafeInteger(input.number)) {
    throw new RangeError(`Expected a whole puzzle number, got ${input.number}.`);
  }
  const header = [
    singleLine('title', input.title),
    label,
    ...(input.variant == null || input.variant === '' ? [] : [`(${singleLine('variant', input.variant)})`]),
    ...(input.headline === undefined || input.headline === '' ? [] : [singleLine('headline', input.headline)]),
  ].join(' ');

  const lines = [header];
  if (input.summary !== undefined && input.summary !== '') lines.push(singleLine('summary', input.summary));
  for (const [index, row] of (input.rows ?? []).entries()) {
    const symbols = singleLine(`row ${index + 1}`, row.symbols);
    if (LETTER_OR_DIGIT.test(symbols.replace(NUMERIC_KEYCAP, ''))) {
      throw new RangeError(`Share row ${index + 1} must hold symbols only, never letters or digits.`);
    }
    if (
      row.detail !== undefined &&
      row.detail !== 'found' &&
      (!Number.isInteger(row.detail) || row.detail < 0 || row.detail > 100)
    )
      throw new RangeError('Share detail must be a whole percentage from 0 to 100 or found.');
    const detail = row.detail === undefined ? '' : row.detail === 'found' ? ' found' : ` ${row.detail}%`;
    lines.push(form === 'symbols' ? symbols + detail : sentence(singleLine(`row ${index + 1} words`, row.words)));
  }
  if (input.url !== undefined) {
    if (!PAGE_URL.test(input.url)) {
      throw new RangeError('The share URL must be an absolute http(s) URL with no query string or fragment.');
    }
    lines.push(input.url);
  }
  return lines.join('\n');
};

/** How one kind of cell appears: its symbol, and its name in words. */
export type ShareLegendEntry = {
  readonly symbol: string;
  /** E.g. "right place". Leave it out for cells the words form shouldn't count ("not in word"). */
  readonly words?: string;
};

/**
 * Turns a grid of cell kinds into share rows. Each row's words form counts the cells of each
 * kind that has `words`, in the legend's order: "Guess 2: 1 right place, 2 wrong place". A row
 * with nothing to count reads `<label>: <empty>`.
 */
export const gridRows = <Kind extends string>(
  grid: readonly (readonly Kind[])[],
  legend: Readonly<Record<Kind, ShareLegendEntry>>,
  label: (index: number) => string,
  empty = 'none',
): ShareRow[] =>
  grid.map((cells, index) => {
    const counts = (Object.keys(legend) as Kind[]).flatMap((kind) => {
      const words = legend[kind].words;
      const count = cells.filter((cell) => cell === kind).length;
      return words === undefined || count === 0 ? [] : [`${count} ${words}`];
    });
    return {
      symbols: cells.map((cell) => legend[cell].symbol).join(''),
      words: `${label(index)}: ${counts.length === 0 ? empty : counts.join(', ')}`,
    };
  });

/** A play time for share text and results: "0:07", "1:42", "1:02:05". Whole seconds, rounded down. */
export const formatClock = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Expected a duration in milliseconds, got ${ms}.`);
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
};
