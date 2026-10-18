// The ranked word list (lists/build-ranked.ts): lowercase SCOWL words of 3 to 12 letters with
// the smallest SCOWL size level that lists each one. Grid games build their answers from it:
// Crossword scores fill by size, and Word Flux limits each puzzle size to a size level.
// Loaded once, lazily, from the package's lists/ folder.
import { readFileSync } from 'node:fs';

/** Word → SCOWL size (10, 20, 35, 40, 50, 55 or 60). Lower is more common. */
export type RankedWords = ReadonlyMap<string, number>;

/** Parses "<word> <size>" lines; blank lines and "#" comments are skipped. */
export const parseRanked = (text: string): Map<string, number> => {
  const words = new Map<string, number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const [word, size] = trimmed.split(/\s+/);
    const level = Number(size);
    if (word !== undefined && /^[a-z]+$/.test(word) && Number.isInteger(level)) words.set(word, level);
  }
  return words;
};

let cached: RankedWords | null = null;

/** The ranked list from lists/scowl-ranked.txt. */
export const rankedWords = (): RankedWords => {
  cached ??= parseRanked(readFileSync(new URL('../lists/scowl-ranked.txt', import.meta.url), 'utf8'));
  return cached;
};

/**
 * A word's familiarity score from 1 to 100, from its SCOWL size (crossword.md, "The crossword
 * word list"): size 10 scores 100 and each level down costs ten points (size 50 scores 60,
 * size 60 scores 40). Staff adjustments, when they exist, override it.
 */
export const scoreOfSize = (size: number): number => {
  const scores: Readonly<Record<number, number>> = { 10: 100, 20: 90, 35: 75, 40: 70, 50: 60, 55: 50, 60: 40 };
  return scores[size] ?? Math.max(1, Math.min(100, 110 - size));
};
