// Trick-taking helpers for Hearts, Spades and similar games.

import type { SeatId } from '@joystyk/contracts';
import { rankValue, type Suit, type SuitedFace } from './card.ts';

/** One card played to a trick. */
export type Play<C> = { readonly seat: SeatId; readonly card: C };

/** A trick: who led, the plays in order, and the winner once it is complete. */
export type Trick<C> = {
  readonly leader: SeatId;
  readonly plays: readonly Play<C>[];
  readonly winner: SeatId | null;
};

export type PlayRules<C> = {
  /** The suit led to the current trick, or null when this play leads. */
  readonly led: Suit | null;
  /**
   * A suit that can't be led until it is broken (hearts in Hearts, spades in Spades). Pass
   * null, or leave it out, once it is broken. A leader holding nothing else may lead it.
   */
  readonly unbroken?: Suit | null;
  /**
   * Cards that may not be played now, such as hearts and the Queen of Spades on Hearts'
   * first trick. The ban lifts when it would leave no legal play.
   */
  readonly banned?: (card: C) => boolean;
  /**
   * Cards that must be played if held and otherwise legal, such as the 2 of clubs on
   * Hearts' first lead.
   */
  readonly required?: (card: C) => boolean;
};

/**
 * The cards in `hand` that may be played now, in hand order:
 *
 * 1. Following: cards of the led suit if any, otherwise the whole hand.
 *    Leading: every card except the unbroken suit, unless the hand holds nothing else.
 * 2. If any of those cards is `required`, only the required ones.
 * 3. Without `banned` cards, unless that leaves nothing.
 *
 * An empty hand has no legal plays.
 */
export const legalPlays = <C extends SuitedFace>(hand: readonly C[], rules: PlayRules<C>): C[] => {
  let legal: C[];
  if (rules.led !== null) {
    const following = hand.filter((card) => card.suit === rules.led);
    legal = following.length > 0 ? following : hand.slice();
  } else {
    const unbroken = rules.unbroken ?? null;
    const leads = hand.filter((card) => card.suit !== unbroken);
    legal = leads.length > 0 ? leads : hand.slice();
  }
  const { required, banned } = rules;
  if (required) {
    const must = legal.filter(required);
    if (must.length > 0) legal = must;
  }
  if (banned) {
    const allowed = legal.filter((card) => !banned(card));
    if (allowed.length > 0) legal = allowed;
  }
  return legal;
};

/** True when `card` (matched by id) is one of the legal plays. */
export const isLegalPlay = <C extends SuitedFace & { readonly id: string }>(
  hand: readonly C[],
  card: C,
  rules: PlayRules<C>,
): boolean => legalPlays(hand, rules).some((legal) => legal.id === card.id);

/** The suit led to a trick, or null before anyone plays. */
export const ledSuit = <C extends SuitedFace>(plays: readonly Play<C>[]): Suit | null => plays[0]?.card.suit ?? null;

/**
 * The seat that wins a trick: the highest trump if any trump was played, otherwise the
 * highest card of the led suit. Cards of other suits never win. Aces are high unless
 * `aceHigh` is false. Throws a `RangeError` for a trick with no plays.
 */
export const trickWinner = <C extends SuitedFace>(
  plays: readonly Play<C>[],
  trump: Suit | null = null,
  aceHigh = true,
): SeatId => {
  const first = plays[0];
  if (first === undefined) throw new RangeError('A trick with no plays has no winner.');
  const led = first.card.suit;
  const strength = (card: C): number => {
    const value = rankValue(card.rank, aceHigh);
    if (trump !== null && card.suit === trump) return 100 + value;
    return card.suit === led ? value : 0;
  };
  let best = first;
  for (const play of plays) if (strength(play.card) > strength(best.card)) best = play;
  return best.seat;
};
