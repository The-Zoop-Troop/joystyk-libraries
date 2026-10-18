// The all-ages filter (content-pipeline.md, "The all-ages filter"). Layers 1 and 2 are word
// lists in lists/: the blocklist and the sensitive list. Matching is whole-word, in the
// regular plural and verb forms of each entry, so innocent words that merely contain a bad
// substring pass ("class", "scamper"). An entry ending in "*" matches any word starting with
// it; an entry with spaces matches as a phrase. Letter grids are also read along every
// straight line, where a blocklisted word of four or more letters rejects the grid.
// Layer 3, the model screen, is in screen.ts.
import { readFileSync } from 'node:fs';
import { fold, wordsOf } from './text.ts';

export type FilterList = 'blocklist' | 'sensitive';

/** A text the filter reads, with a path that names it in reports ("entry.definition"). */
export interface FieldText {
  readonly path: string;
  readonly text: string;
}

export interface FilterHit {
  readonly path: string;
  readonly list: FilterList;
  /** The list entry that matched. Logged, never shown to players. */
  readonly term: string;
}

export interface FilterReport {
  readonly ok: boolean;
  readonly hits: readonly FilterHit[];
}

interface Term {
  readonly entry: string;
  /** Tokens; the last may be a prefix. */
  readonly tokens: readonly string[];
  readonly prefix: boolean;
  /** The forms each token matches (unused for a prefix token). */
  readonly forms: readonly Set<string>[];
}

const VOWEL = /[aeiou]/;
const consonant = (ch: string | undefined) => ch !== undefined && /[a-z]/.test(ch) && !VOWEL.test(ch);

/**
 * The forms a list entry matches: the word, its plural and its verb endings. Deliberately
 * narrower than `formsOf` (no -er, -ly or -y), so "butt" never matches "butter".
 */
export const filterForms = (word: string): Set<string> => {
  const forms = new Set([word, `${word}s`]);
  const last = word.at(-1);
  if (/(s|x|z|ch|sh)$/.test(word)) forms.add(`${word}es`);
  if (
    word.length <= 4 &&
    consonant(last) &&
    VOWEL.test(word.at(-2) ?? '') &&
    consonant(word.at(-3) ?? 'b') &&
    !/[wxy]/.test(last ?? '')
  ) {
    forms.add(`${word}${last}ed`).add(`${word}${last}ing`);
  } else if (last === 'e') {
    forms.add(`${word}d`);
    if (word.length > 3) forms.add(`${word.slice(0, -1)}ing`);
  } else if (last === 'y' && consonant(word.at(-2))) {
    forms
      .add(`${word.slice(0, -1)}ies`)
      .add(`${word.slice(0, -1)}ied`)
      .add(`${word}ing`);
  } else {
    forms.add(`${word}ed`).add(`${word}ing`);
  }
  return forms;
};

export const parseList = (text: string): Term[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((entry) => {
      const prefix = entry.endsWith('*');
      const tokens = wordsOf(prefix ? entry.slice(0, -1) : entry);
      return { entry, prefix, tokens, forms: tokens.map(filterForms) };
    })
    .filter((term) => term.tokens.length > 0);

const termAt = (tokens: readonly string[], i: number, term: Term): boolean => {
  if (i + term.tokens.length > tokens.length) return false;
  return term.tokens.every((word, k) => {
    const token = tokens[i + k] ?? '';
    return term.prefix && k === term.tokens.length - 1 ? token.startsWith(word) : (term.forms[k]?.has(token) ?? false);
  });
};

export interface WordFilter {
  /** The list entries a text contains. */
  matches(text: string, list?: FilterList): { list: FilterList; term: string }[];
  /** Layers 1 and 2 over every field. */
  check(fields: readonly FieldText[]): FilterReport;
  /** The blocklisted words of at least `minLength` letters along any straight line of a letter grid. */
  checkGrid(rows: readonly string[], minLength?: number): FilterReport;
  /** True when a single word (an answer, an option) is on either list. */
  isListed(word: string): boolean;
}

/** A filter over the given list texts. `defaultFilter()` reads the repository's lists. */
export const createWordFilter = (lists: { readonly blocklist: string; readonly sensitive: string }): WordFilter => {
  const terms: Record<FilterList, Term[]> = {
    blocklist: parseList(lists.blocklist),
    sensitive: parseList(lists.sensitive),
  };
  const matches = (text: string, only?: FilterList) => {
    const tokens = wordsOf(text);
    const found: { list: FilterList; term: string }[] = [];
    for (const list of ['blocklist', 'sensitive'] as const) {
      if (only !== undefined && list !== only) continue;
      for (const term of terms[list]) {
        for (let i = 0; i < tokens.length; i++) {
          if (termAt(tokens, i, term)) {
            found.push({ list, term: term.entry });
            break;
          }
        }
      }
    }
    return found;
  };
  const singleBlocked = terms.blocklist.filter((term) => term.tokens.length === 1);
  return {
    matches,
    check: (fields) => {
      const hits = fields.flatMap((field) => matches(field.text).map((hit) => ({ path: field.path, ...hit })));
      return { ok: hits.length === 0, hits };
    },
    checkGrid: (rows, minLength = 4) => {
      const hits: FilterHit[] = [];
      for (const [index, line] of gridLines(rows).entries()) {
        for (const term of singleBlocked) {
          const word = term.tokens[0] ?? '';
          if (word.length >= minLength && line.includes(word))
            hits.push({ path: `grid.line${String(index)}`, list: 'blocklist', term: term.entry });
        }
      }
      return { ok: hits.length === 0, hits };
    },
    isListed: (word) => matches(word).length > 0,
  };
};

/**
 * Every straight line of a letter grid, read both ways: rows, columns and both diagonals.
 * Non-letter cells (blocks, spaces) break a line.
 */
export const gridLines = (rows: readonly string[]): string[] => {
  const grid = rows.map((row) => [...fold(row)]);
  const height = grid.length;
  const width = Math.max(0, ...grid.map((row) => row.length));
  const at = (r: number, c: number) => grid[r]?.[c] ?? ' ';
  const lines: string[] = [];
  const walk = (r: number, c: number, dr: number, dc: number) => {
    let line = '';
    for (; r >= 0 && r < height && c >= 0 && c < width; r += dr, c += dc) line += at(r, c);
    for (const run of line.split(/[^a-z]+/)) if (run.length > 1) lines.push(run, [...run].reverse().join(''));
  };
  for (let r = 0; r < height; r++) walk(r, 0, 0, 1);
  for (let c = 0; c < width; c++) walk(0, c, 1, 0);
  for (let c = 0; c < width; c++) walk(0, c, 1, 1);
  for (let r = 1; r < height; r++) walk(r, 0, 1, 1);
  for (let c = 0; c < width; c++) walk(0, c, 1, -1);
  for (let r = 1; r < height; r++) walk(r, width - 1, 1, -1);
  return lines;
};

const readList = (name: 'blocklist.txt' | 'sensitive.txt'): string =>
  readFileSync(new URL(`../lists/${name}`, import.meta.url), 'utf8');

let cached: WordFilter | null = null;

/** The filter over lists/blocklist.txt and lists/sensitive.txt. */
export const defaultFilter = (): WordFilter => {
  cached ??= createWordFilter({ blocklist: readList('blocklist.txt'), sensitive: readList('sensitive.txt') });
  return cached;
};
