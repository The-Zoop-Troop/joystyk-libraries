// Point tables shared by several card games, as data.

import type { Rank, SuitedFace } from './card.ts';

/** Gin Rummy deadwood: ace 1, 2–10 their number, jack, queen and king 10. */
export const DEADWOOD_VALUES: Readonly<Record<Rank, number>> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 10,
  12: 10,
  13: 10,
};

/** Crazy Eights penalties: eight 50, jack, queen and king 10, ace 1, others their number. */
export const CRAZY_EIGHTS_PENALTIES: Readonly<Record<Rank, number>> = { ...DEADWOOD_VALUES, 8: 50 };

/** A card's Gin Rummy deadwood value. */
export const deadwoodValue = (card: SuitedFace): number => DEADWOOD_VALUES[card.rank];

/** A card's Crazy Eights penalty. */
export const crazyEightsPenalty = (card: SuitedFace): number => CRAZY_EIGHTS_PENALTIES[card.rank];

/** Hearts: every heart 1, the Queen of Spades 13, everything else 0. */
export const heartsPoints = (card: SuitedFace): number =>
  card.suit === 'H' ? 1 : card.suit === 'S' && card.rank === 12 ? 13 : 0;
