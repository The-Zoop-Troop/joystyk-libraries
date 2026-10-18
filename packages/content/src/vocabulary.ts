// The SCOWL-derived word lists (lists/build-lists.ts): which words are real, and which are
// common enough for a confident young reader. Loaded once, lazily, from the package's lists/
// folder.
import { readFileSync } from 'node:fs';
import { fold } from './text.ts';
import { rankedWords } from './ranked.ts';

/** Word membership questions the validators ask. Tests may pass a small fake. */
export interface Vocabulary {
  /** In SCOWL at size 50 or below: fine in any player-facing text. */
  isCommon(word: string): boolean;
  /** In SCOWL at size 70 or below: a real word a player may meet as an answer or option. */
  isKnown(word: string): boolean;
}

const readWords = (name: 'scowl-common.txt' | 'scowl-vocabulary.txt' | 'common-extra.txt'): Set<string> =>
  new Set(
    readFileSync(new URL(`../lists/${name}`, import.meta.url), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  );

let cached: Vocabulary | null = null;
let plainExtra: ReadonlySet<string> | null = null;

/** Lowercase word families only, plus the reviewed supplement; excludes proper-name lists. */
export const isPlainCommonWord = (input: string): boolean => {
  plainExtra ??= readWords('common-extra.txt');
  const word = fold(input),
    size = rankedWords().get(word);
  return (size !== undefined && size <= 50) || plainExtra.has(word);
};

/**
 * The SCOWL vocabulary: common is sizes 10–50 plus the short reviewed supplement of modern
 * everyday words in common-extra.txt; known adds sizes 55–70.
 */
export const scowlVocabulary = (): Vocabulary => {
  if (cached !== null) return cached;
  const common = readWords('scowl-common.txt');
  for (const word of readWords('common-extra.txt')) common.add(word);
  const extra = readWords('scowl-vocabulary.txt');
  cached = {
    isCommon: (word) => common.has(fold(word)),
    isKnown: (word) => {
      const folded = fold(word);
      return common.has(folded) || extra.has(folded);
    },
  };
  return cached;
};

/** A vocabulary over explicit word sets, for tests and small tools. */
export const vocabularyOf = (common: Iterable<string>, known: Iterable<string> = []): Vocabulary => {
  const commonSet = new Set([...common].map(fold));
  const knownSet = new Set([...known].map(fold));
  return {
    isCommon: (word) => commonSet.has(fold(word)),
    isKnown: (word) => commonSet.has(fold(word)) || knownSet.has(fold(word)),
  };
};
