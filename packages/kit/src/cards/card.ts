// The standard playing card: ranks, suits, colors and orderings. Plain JSON throughout.

/** Spades, hearts, diamonds, clubs. Letters, so a card prints and serializes compactly. */
export type Suit = 'S' | 'H' | 'D' | 'C';

/** Ace is 1; jack, queen and king are 11, 12 and 13. Ace-high games rank it with `rankValue`. */
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/** A card with a rank and a suit. */
export type SuitedFace = { readonly rank: Rank; readonly suit: Suit };

/** A joker. It has no suit; `suit: null` keeps every face the same shape. */
export type JokerFace = { readonly rank: 'joker'; readonly suit: null };

/** What a standard card shows: a rank and suit, or a joker. Identity lives in `id`, not here. */
export type Face = SuitedFace | JokerFace;

/** An opaque card id: a short string, unique within a deal. See `assignIds`. */
export type CardId = string;

/** A dealt card: its face plus an id. `F` is the face type, so custom decks fit too. */
export type Card<F = Face> = F & { readonly id: CardId };

/** A standard card with a rank and suit (no jokers). Most trick and meld helpers take these. */
export type SuitedCard = Card<SuitedFace>;

/** The canonical suit order: spades, hearts, diamonds, clubs. Decks are built in this order. */
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

/** Ranks from ace (1) to king (13). */
export const RANKS: readonly Rank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export const ACE: Rank = 1;
export const JACK: Rank = 11;
export const QUEEN: Rank = 12;
export const KING: Rank = 13;

export const isSuit = (value: unknown): value is Suit =>
  value === 'S' || value === 'H' || value === 'D' || value === 'C';

export const isRank = (value: unknown): value is Rank =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 13;

export const isJoker = (face: Face): face is JokerFace => face.rank === 'joker';

export const isSuited = <F extends Face>(face: F): face is Extract<F, SuitedFace> => face.rank !== 'joker';

/** Builds a suited face. */
export const face = (rank: Rank, suit: Suit): SuitedFace => ({ rank, suit });

/** The joker face. */
export const JOKER: JokerFace = { rank: 'joker', suit: null };

/** True when two faces show the same rank and suit (ids are ignored). */
export const sameFace = (a: Face, b: Face): boolean => a.rank === b.rank && a.suit === b.suit;

export type Color = 'red' | 'black';

/** Hearts and diamonds are red; spades and clubs are black. */
export const suitColor = (suit: Suit): Color => (suit === 'H' || suit === 'D' ? 'red' : 'black');

export const isRed = (card: SuitedFace): boolean => suitColor(card.suit) === 'red';

export const sameColor = (a: SuitedFace, b: SuitedFace): boolean => suitColor(a.suit) === suitColor(b.suit);

/**
 * A rank's value for comparison. Ace-low (the default) gives ace 1 … king 13; ace-high gives
 * 2 … king 13, ace 14.
 */
export const rankValue = (rank: Rank, aceHigh = false): number => (aceHigh && rank === 1 ? 14 : rank);

/** The next rank up, or null after the king. Ace-high play treats the ace as above the king. */
export const nextRank = (rank: Rank, aceHigh = false): Rank | null => {
  if (aceHigh) return rank === 1 ? null : rank === 13 ? 1 : ((rank + 1) as Rank);
  return rank === 13 ? null : ((rank + 1) as Rank);
};

/** The next rank down, or null below the ace (ace-low) or the two (ace-high). */
export const previousRank = (rank: Rank, aceHigh = false): Rank | null => {
  if (aceHigh) return rank === 2 ? null : rank === 1 ? 13 : ((rank - 1) as Rank);
  return rank === 1 ? null : ((rank - 1) as Rank);
};

/**
 * True when each card is one rank below the one before it and the colors alternate, as in
 * a Klondike or FreeCell tableau run, from the top of the run down.
 */
export const isDescendingAlternating = (cards: readonly SuitedFace[]): boolean =>
  cards.every((card, i) => {
    const above = cards[i - 1];
    return above === undefined || (card.rank === above.rank - 1 && !sameColor(card, above));
  });

/** True when each card is one rank below the one before it, all in one suit (Spider). */
export const isDescendingSameSuit = (cards: readonly SuitedFace[]): boolean =>
  cards.every((card, i) => {
    const above = cards[i - 1];
    return above === undefined || (card.rank === above.rank - 1 && card.suit === above.suit);
  });

/**
 * How many cards at the end of a pile form one run, counted from the last card back: the
 * cards a solitaire game may move together. `'alternating'` follows Klondike and FreeCell
 * (descending, alternating colors); `'same-suit'` follows Spider (descending, one suit).
 * An empty pile has a run of 0; any other pile has at least 1.
 */
export const trailingRunLength = (cards: readonly SuitedFace[], kind: 'alternating' | 'same-suit'): number => {
  let length = cards.length === 0 ? 0 : 1;
  for (let i = cards.length - 1; i > 0; i -= 1) {
    const card = cards[i]!;
    const above = cards[i - 1]!;
    const fits =
      card.rank === above.rank - 1 && (kind === 'alternating' ? !sameColor(card, above) : card.suit === above.suit);
    if (!fits) break;
    length += 1;
  }
  return length;
};

export type SortOptions = {
  /** Suit order, first to last. Defaults to `SUITS`. */
  readonly suitOrder?: readonly Suit[];
  /** Ace sorts above the king. Defaults to false. */
  readonly aceHigh?: boolean;
  /** Ranks run high to low within a suit. Defaults to false. */
  readonly descending?: boolean;
};

/**
 * A comparator for display order: by suit in `suitOrder`, then by rank. Jokers sort last.
 * Ties (two copies of a card in a multi-deck game) keep their order, because
 * `Array.prototype.sort` is stable.
 */
export const compareCards =
  (options: SortOptions = {}) =>
  (a: Face, b: Face): number => {
    const order = options.suitOrder ?? SUITS;
    // Listed suits first, then suits missing from the order, then jokers.
    const suitIndex = (f: Face): number =>
      f.suit === null ? order.length + 2 : order.indexOf(f.suit) + 1 || order.length + 1;
    const bySuit = suitIndex(a) - suitIndex(b);
    if (bySuit !== 0 || a.rank === 'joker' || b.rank === 'joker') return bySuit;
    const byRank = rankValue(a.rank, options.aceHigh) - rankValue(b.rank, options.aceHigh);
    return options.descending ? -byRank : byRank;
  };

/** A sorted copy of a hand, for display. See `compareCards`. */
export const sortHand = <C extends Face>(cards: readonly C[], options: SortOptions = {}): C[] =>
  cards.slice().sort(compareCards(options));
