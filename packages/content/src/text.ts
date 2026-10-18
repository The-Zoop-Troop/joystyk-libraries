// Text helpers shared by the all-ages filter and the games' validators: tokenizing, the
// common inflected forms of a word, and answer-leak checks (content-pipeline.md, "Validation").

/** Lowercase, accents removed, curly apostrophes made straight. */
export const fold = (text: string): string =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[‘’ʼ]/g, "'").toLowerCase();

/**
 * The words in a text, folded: letter runs, with inner apostrophes kept ("don't") and a
 * possessive "'s" dropped ("cat's" → "cat"). Digits, hyphens and punctuation split words.
 */
export const wordsOf = (text: string): string[] =>
  (fold(text).match(/\p{L}+(?:'\p{L}+)*/gu) ?? []).map((word) => word.replace(/'s$/, ''));

const VOWEL = /[aeiou]/;
const isConsonant = (ch: string | undefined): boolean => ch !== undefined && /[a-z]/.test(ch) && !VOWEL.test(ch);

/**
 * The regular inflected and simple derived forms of a word: plurals and verb endings,
 * comparatives, and -ly adverbs, with the usual spelling changes (final e, final y, doubled
 * final consonant). Generous on purpose: it's used to *find* the word, never to build text.
 */
export const formsOf = (input: string): Set<string> => {
  const word = fold(input);
  const forms = new Set([word]);
  const add = (...items: string[]) => items.forEach((item) => forms.add(item));
  const last = word.at(-1);
  const stemE = word.endsWith('e') ? word.slice(0, -1) : word;
  add(
    `${word}s`,
    `${word}es`,
    `${word}d`,
    `${word}ed`,
    `${word}ing`,
    `${word}er`,
    `${word}ers`,
    `${word}est`,
    `${word}ly`,
    `${word}ness`,
  );
  add(`${stemE}ing`, `${stemE}ed`, `${stemE}er`, `${stemE}est`, `${stemE}ers`);
  if (last === 'y' && isConsonant(word.at(-2))) {
    const base = word.slice(0, -1);
    add(`${base}ies`, `${base}ied`, `${base}ier`, `${base}iest`, `${base}ily`, `${base}iness`);
  }
  if (word.endsWith('le')) add(`${word.slice(0, -1)}y`);
  if (word.endsWith('ie')) add(`${word.slice(0, -2)}ying`);
  if (word.endsWith('ic')) add(`${word}ally`, `${word}ked`, `${word}king`);
  if (isConsonant(last) && last !== 'w' && last !== 'x' && last !== 'y' && VOWEL.test(word.at(-2) ?? '')) {
    add(`${word}${last}ed`, `${word}${last}ing`, `${word}${last}er`, `${word}${last}est`, `${word}${last}y`);
  }
  if (/(s|x|z|ch|sh)$/.test(word)) add(`${word}es`);
  return forms;
};

const SUFFIXES = [
  'ically',
  'ation',
  'ously',
  'ness',
  'ment',
  'ance',
  'ence',
  'ible',
  'able',
  'ious',
  'eous',
  'ous',
  'ive',
  'ity',
  'ism',
  'ist',
  'ing',
  'ate',
  'ize',
  'ise',
  'ful',
  'ial',
  'ian',
  'ent',
  'ant',
  'ary',
  'ory',
  'al',
  'ic',
  'ed',
  'er',
  'ly',
  'es',
  'y',
  'e',
  's',
];

/**
 * A word's stem for leak checks: the word without its longest common suffix, kept only when
 * at least five letters remain (shorter stems such as "prob" from "probe" would match
 * innocent words). Null when no useful stem exists.
 */
export const stemOf = (input: string): string | null => {
  const word = fold(input);
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 5) return word.slice(0, -suffix.length);
  }
  return word.length >= 6 ? word : null;
};

/** True when `text` uses `word` in one of its forms, or a word starting with its stem. */
export const mentions = (text: string, word: string): boolean => {
  const forms = formsOf(word);
  const stem = stemOf(word);
  return wordsOf(text).some((token) => forms.has(token) || (stem !== null && token.startsWith(stem)));
};

/** True when `text` contains `word` in one of its regular forms (not just its stem). */
export const usesForm = (text: string, word: string): boolean => {
  const forms = formsOf(word);
  return wordsOf(text).some((token) => forms.has(token));
};

/**
 * The strict leak check for games where players guess letters (Daily Word, Hangman,
 * crosswords): the answer, its stem, or any run of `minRun` or more consecutive letters of it
 * appears in the text, compared case- and accent-insensitively.
 */
export const leaksLetters = (text: string, answer: string, minRun = 4): boolean => {
  if (mentions(text, answer)) return true;
  const letters = fold(answer).replace(/[^a-z]/g, '');
  const haystack = wordsOf(text).join(' ');
  for (let i = 0; i + minRun <= letters.length; i++) {
    if (haystack.includes(letters.slice(i, i + minRun))) return true;
  }
  return false;
};

/** Text compared for sameness: folded, punctuation and extra spaces removed. */
export const sameText = (a: string, b: string): boolean => wordsOf(a).join(' ') === wordsOf(b).join(' ');
