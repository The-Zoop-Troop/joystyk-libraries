import { expect, it } from 'vitest';
import { isPlainCommonWord, scowlVocabulary } from './vocabulary.ts';
it('keeps proper-name vocabulary separate from plain grouping words', () => {
  expect(scowlVocabulary().isCommon('ALICE')).toBe(true);
  expect(isPlainCommonWord('ALICE')).toBe(false);
  expect(isPlainCommonWord('PARIS')).toBe(false);
  for (const word of ['BAKE', 'BAKER', 'PENCIL', 'ROBIN']) expect(isPlainCommonWord(word)).toBe(true);
  expect(isPlainCommonWord('ZXCVBN')).toBe(false);
});
