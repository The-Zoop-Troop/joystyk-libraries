/*
 * The display-name blocklist: compact on purpose, because the character rules in filter.ts
 * already shut out most abuse (no URLs, emails, symbols, emoji or non-Latin look-alikes).
 *
 * Source: the English list of "List of Dirty, Naughty, Obscene, and Otherwise Bad Words"
 *         https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
 *         file `en`, commit 5faf2ba42d7b1c0977169ec3611df25a3c08eb13 (403 entries,
 *         sha256 af851ecef1d5f212caba17339b12ac39cc2fef7d78c74876f67237644fcee8bd).
 * License: Creative Commons Attribution 4.0 International (CC BY 4.0),
 *          https://creativecommons.org/licenses/by/4.0/ . Copyright Shutterstock, Inc. and
 *          the LDNOOBW contributors.
 * Changes: curated, not copied. Multi-word phrases were reduced to the single word that
 *          carries the meaning, or dropped when no single word does; words with innocent
 *          everyday meanings were dropped; stems replace families of inflections; a few
 *          slurs, hate codes and insults the source lacks were added (marked "added" below).
 *
 * Matching (see filter.ts) lowercases the name, undoes common digit substitutions
 * (0→o, 1→i or l, 3→e, 4→a, 5→s, 7→t, 8→b, 9→g) and squeezes repeated letters.
 */

/**
 * Stems blocked anywhere in the name, even across word breaks ("f u c k", "BigShitFan").
 * Only stems that almost never occur inside an innocent word belong here.
 */
export const BLOCKED_ANYWHERE: readonly string[] = [
  'arsehole',
  'asshole',
  'bastard',
  'bitch',
  'blowjob',
  'bollock',
  'bukkake',
  'clit',
  'creampie',
  'cumshot',
  'cunnil',
  'cunt',
  'dildo',
  'ejaculat',
  'erotic',
  'faggot',
  'fellat',
  'fuck',
  'gangbang',
  'handjob',
  'hentai',
  'hitler', // added
  'incest',
  'jailbait',
  'jigaboo',
  'jiggaboo',
  'jizz',
  'kkk', // added
  'masturbat',
  'milf',
  'nazi',
  'nigg',
  'orgasm',
  'paedophil',
  'pedophil',
  'penis',
  'piss',
  'poontang',
  'porn',
  'punany',
  'queef',
  'raghead',
  'retard', // added
  'rimjob',
  'schlong',
  'scrotum', // added
  'shemale',
  'shit',
  'slut',
  'smegma', // added
  'sodom',
  'splooge',
  'swastika',
  'threesome',
  'titties',
  'titty',
  'towelhead',
  'twat',
  'upskirt',
  'vagina',
  'voyeur',
  'wetback',
  'whore',
  'xxx',
];

/**
 * Words blocked only as a whole word (or as the whole name with its breaks removed), because
 * they hide inside innocent words: "ass" in "class", "cock" in "peacock", "coon" in
 * "raccoon". Singular forms; a trailing "s" is stripped before comparing, so plurals in
 * "es" are listed.
 */
export const BLOCKED_WORDS: readonly string[] = [
  'anal',
  'anus',
  'arse',
  'ass',
  'asses',
  'beaner',
  'boner',
  'boob',
  'butt',
  'chink', // added
  'cock',
  'coon',
  'cum',
  'darkie',
  'dick',
  'dyke',
  'fag',
  'gook', // added
  'homo', // added
  'honkey',
  'horny',
  'kike',
  'kinky',
  'kys', // added: "kill yourself"
  'negro',
  'nude',
  'orgy',
  'paki',
  'pedo',
  'poon',
  'pussy',
  'quim',
  'rape',
  'raped',
  'raping',
  'rapist',
  'scat',
  'semen',
  'sex',
  'sexy',
  'skeet',
  'smut',
  'spic',
  'spunk',
  'stfu', // added
  'suck',
  'tit',
  'tranny',
  'wank',
  'wanker',
  'wtf', // added
];

/** Numbers blocked as a whole token: sexual references and hate codes (added). */
export const BLOCKED_NUMBERS: readonly string[] = ['69', '88', '420', '1488'];
