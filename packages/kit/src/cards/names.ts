// Card names for people: spoken names for screen readers and announcements, and compact
// labels for faces. Every string comes from a per-locale table, so a new language is a new
// table rather than new code.

import type { Face, Rank, Suit } from './card.ts';

/** Languages with a name table. English only for now. */
export type Locale = 'en';

type NameTable = {
  readonly ranks: Readonly<Record<Rank, string>>;
  readonly suits: Readonly<Record<Suit, string>>;
  readonly suitsPlural: Readonly<Record<Suit, string>>;
  readonly joker: string;
  readonly cardName: (rank: string, suitPlural: string) => string;
};

const TABLES: Readonly<Record<Locale, NameTable>> = {
  en: {
    // Numerals for 2–10: screen readers speak "7" as "seven", and the digits read faster on screen.
    ranks: {
      1: 'Ace',
      2: '2',
      3: '3',
      4: '4',
      5: '5',
      6: '6',
      7: '7',
      8: '8',
      9: '9',
      10: '10',
      11: 'Jack',
      12: 'Queen',
      13: 'King',
    },
    suits: { S: 'Spade', H: 'Heart', D: 'Diamond', C: 'Club' },
    suitsPlural: { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' },
    joker: 'Joker',
    cardName: (rank, suitPlural) => `${rank} of ${suitPlural}`,
  },
};

/** Suit glyphs, for display only. Never the only cue, and never the accessible name. */
export const SUIT_GLYPHS: Readonly<Record<Suit, string>> = { S: '♠', H: '♥', D: '♦', C: '♣' };

const RANK_SHORT: Readonly<Record<Rank, string>> = {
  1: 'A',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
};

/** A rank's spoken name: "Ace", "7", "Queen". */
export const rankName = (rank: Rank, locale: Locale = 'en'): string => TABLES[locale].ranks[rank];

/** A suit's singular name: "Spade". */
export const suitName = (suit: Suit, locale: Locale = 'en'): string => TABLES[locale].suits[suit];

/** A suit's plural name, as in a card name or a hand summary: "spades". */
export const suitPluralName = (suit: Suit, locale: Locale = 'en'): string => TABLES[locale].suitsPlural[suit];

/** A rank's compact label: "A", "7", "10", "Q". */
export const rankShort = (rank: Rank): string => RANK_SHORT[rank];

/** The spoken name of a card: "Queen of spades", "7 of hearts", "Joker". */
export const cardName = (card: Face, locale: Locale = 'en'): string => {
  const table = TABLES[locale];
  if (card.rank === 'joker') return table.joker;
  return table.cardName(table.ranks[card.rank], table.suitsPlural[card.suit]);
};

/**
 * A card's compact label: "Q♠", or "QS" with `glyphs: false` for places where glyphs aren't
 * wanted. A joker is "JK".
 */
export const cardShort = (card: Face, options: { readonly glyphs?: boolean } = {}): string => {
  if (card.rank === 'joker') return 'JK';
  return RANK_SHORT[card.rank] + (options.glyphs === false ? card.suit : SUIT_GLYPHS[card.suit]);
};
