// Deck builders. Every deck comes out in a fixed canonical order, so the shuffle alone
// decides the deal, and a seed always gives the same deal. Never change the order: deal
// numbers and daily puzzles depend on it.

import { JOKER, RANKS, SUITS, sameFace, type Face, type Suit } from './card.ts';

export type DeckOptions = {
  /** How many full decks to combine, one after another. Defaults to 1. */
  readonly decks?: number;
  /** Which suits each deck holds, in this order. Defaults to `SUITS` (S, H, D, C). Spider's one-suit game uses `['S']` with 8 decks. */
  readonly suits?: readonly Suit[];
  /** Jokers added after all the suited cards. Defaults to 0. */
  readonly jokers?: number;
  /** Faces to take out, one copy each, from the front: Old Maid removes `face(QUEEN, 'C')`. */
  readonly without?: readonly Face[];
};

const count = (value: number | undefined, fallback: number, name: string): number => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer, got ${n}.`);
  return n;
};

/**
 * A deck of standard faces in canonical order: for each deck, suit by suit in `suits`
 * order, ace to king; then the jokers. `standardDeck()` is the 52-card deck,
 * `standardDeck({ decks: 2 })` the 104-card two-deck pack, `standardDeck({ jokers: 2 })` 54
 * cards. The faces carry no ids yet: shuffle, then `assignIds`.
 */
export const standardDeck = (options: DeckOptions = {}): Face[] => {
  const decks = count(options.decks, 1, 'decks');
  const jokers = count(options.jokers, 0, 'jokers');
  const suits = options.suits ?? SUITS;
  const deck: Face[] = [];
  for (let d = 0; d < decks; d += 1) {
    for (const suit of suits) for (const rank of RANKS) deck.push({ rank, suit });
  }
  for (let j = 0; j < jokers; j += 1) deck.push({ ...JOKER });
  for (const removed of options.without ?? []) {
    const index = deck.findIndex((card) => sameFace(card, removed));
    if (index < 0) throw new RangeError(`The deck has no ${JSON.stringify(removed)} left to remove.`);
    deck.splice(index, 1);
  }
  return deck;
};

/**
 * `copies` copies of a custom deck, one after another, for games with their own faces.
 * Shift 23, for example, lists its 76 faces once and builds on them:
 * `repeatDeck(SHIFT23_FACES, 1)`.
 */
export const repeatDeck = <F>(faces: readonly F[], copies: number): F[] => {
  const n = count(copies, 1, 'copies');
  const deck: F[] = [];
  for (let c = 0; c < n; c += 1) deck.push(...faces);
  return deck;
};
