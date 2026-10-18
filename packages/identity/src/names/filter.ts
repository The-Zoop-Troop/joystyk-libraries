// Display names (D-11, D-26): shown to other players, so every name passes a strict all-ages
// filter. The rules are deliberately narrow; a player who trips one can roll a generated name.
import { err, ok, type GameError, type Result } from '@joystyk/contracts';
import { BLOCKED_ANYWHERE, BLOCKED_NUMBERS, BLOCKED_WORDS } from './blocklist.ts';

export const NAME_LIMITS = {
  /** Characters, after trimming. */
  minLength: 3,
  maxLength: 20,
  /** At most this many digits, so a name can't carry a phone number or a birth year and day. */
  maxDigits: 4,
} as const;

/** Why a name was refused. */
export type NameRejectionCode = 'TooShort' | 'TooLong' | 'Characters' | 'NoLetter' | 'TooManyDigits' | 'NotAllowed';

/** A refused name, worded for the player. It never repeats the word that was blocked. */
export type NameRejection = GameError & { readonly code: NameRejectionCode };

const MESSAGES = {
  TooShort: `Names need at least ${NAME_LIMITS.minLength} characters.`,
  TooLong: `Names can have at most ${NAME_LIMITS.maxLength} characters.`,
  Characters: 'Use letters, numbers, and single spaces, hyphens or underscores between them.',
  NoLetter: 'Names need at least one letter.',
  TooManyDigits: `Names can have at most ${NAME_LIMITS.maxDigits} digits.`,
  NotAllowed: "That name isn't allowed. Try another, or roll a random one.",
} as const satisfies Record<NameRejectionCode, string>;

const reject = (code: NameRejectionCode): Result<never, NameRejection> => err({ code, message: MESSAGES[code] });

/**
 * Letters and digits, with single spaces, hyphens or underscores between them. ASCII only:
 * look-alike letters from other scripts would slip past the blocklist.
 */
const SHAPE = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;

/** Unicode-normalizes (NFKC, so full-width letters become ASCII), trims and collapses spaces. */
export const normalizeDisplayName = (input: string): string => input.normalize('NFKC').trim().replace(/\s+/g, ' ');

// Matching. A term becomes a pattern in which each run of a letter matches that run or a
// longer one, so "fuuuck" matches "fuck" and "boooob" matches "boob", but "bob" doesn't.
const pattern = (term: string, anchored: boolean): RegExp => {
  const runs = term.match(/(.)\1*/g) ?? [];
  const body = runs.map((run) => `${run[0]}{${run.length},}`).join('');
  return new RegExp(anchored ? `^${body}$` : body);
};
const ANYWHERE = BLOCKED_ANYWHERE.map((term) => pattern(term, false));
const WORDS = BLOCKED_WORDS.map((term) => pattern(term, true));
const NUMBERS = new Set(BLOCKED_NUMBERS);

const LEET: Readonly<Record<string, string>> = { '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g' };

/** Both readings of a token's digits: 1 as i and as l. */
const unleet = (token: string): readonly string[] => {
  const mapped = token.replace(/[0345789]/g, (digit) => LEET[digit] ?? digit);
  return [mapped.replaceAll('1', 'i'), mapped.replaceAll('1', 'l')];
};

/** Splits at spaces, hyphens, underscores and camelCase humps ("BigFoxFan" → big, fox, fan). */
const tokenize = (name: string): readonly string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[ _-]+/)
    .filter((token) => token !== '')
    .map((token) => token.toLowerCase());

/**
 * The forms a word is compared in: as written, and without a plural "s". Stripping "es" too
 * would turn "spices" into a slur, so the few "es" plurals that matter are listed instead.
 */
const wordForms = (word: string): readonly string[] => [word, word.replace(/s$/, '')];

/** True when the name contains a blocked word, stem or number in any of its readings. */
export const isBlocked = (name: string): boolean => {
  const tokens = tokenize(name);
  if (tokens.some((token) => NUMBERS.has(token))) return true;

  // Pure numbers are left out of the letter readings, so "Fox 55" doesn't read as "foxss".
  const lettered = tokens.filter((token) => /[a-z]/.test(token));
  const readings = lettered.map(unleet);
  const words = readings.flat().flatMap(wordForms);
  const joined = [0, 1].map((variant) => readings.map((forms) => forms[variant]).join(''));

  if (joined.some((text) => ANYWHERE.some((term) => term.test(text)))) return true;
  return [...words, ...joined.flatMap(wordForms)].some((word) => WORDS.some((term) => term.test(word)));
};

/**
 * Checks a display name and returns it normalized, or says why it was refused. Rooms and
 * every other place that shows a name to someone else should run the same check.
 */
export const checkDisplayName = (input: string): Result<string, NameRejection> => {
  const name = normalizeDisplayName(input);
  const length = [...name].length;
  if (length < NAME_LIMITS.minLength) return reject('TooShort');
  if (length > NAME_LIMITS.maxLength) return reject('TooLong');
  if (!SHAPE.test(name)) return reject('Characters');
  if (!/[A-Za-z]/.test(name)) return reject('NoLetter');
  if ((name.match(/[0-9]/g)?.length ?? 0) > NAME_LIMITS.maxDigits) return reject('TooManyDigits');
  if (isBlocked(name)) return reject('NotAllowed');
  return ok(name);
};

/** True when `checkDisplayName` accepts the name exactly as given (already normalized). */
export const isDisplayName = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const checked = checkDisplayName(value);
  return checked.ok && checked.value === value;
};
