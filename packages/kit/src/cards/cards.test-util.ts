// Shorthand for card tests: write hands as text, read them back as text.

import { face, type Rank, type Suit, type SuitedCard, type SuitedFace } from './card.ts';
import { withStableIds } from './ids.ts';
import { cardShort } from './names.ts';

/** Parses "QS 10H 2C" into suited cards with stable ids. */
export const hand = (text: string): SuitedCard[] =>
  text.trim() === ''
    ? []
    : (withStableIds(
        text
          .trim()
          .split(/\s+/)
          .map((token): SuitedFace => {
            const rank = { A: 1, J: 11, Q: 12, K: 13 }[token.slice(0, -1)] ?? Number(token.slice(0, -1));
            return face(rank as Rank, token.slice(-1) as Suit);
          }),
      ) as SuitedCard[]);

/** Prints cards as "QS 10H 2C". */
export const show = (cards: readonly SuitedFace[]): string =>
  cards.map((c) => cardShort(c, { glyphs: false })).join(' ');
