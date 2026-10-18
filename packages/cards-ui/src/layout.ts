// The table a card game hands to <jy-card-table>: regions of piles, each pile's cards bottom
// to top, and what the player may do with them. It is plain JSON built from the game's view
// on every snapshot, so the table never needs the rules: the game says how many cards a pile
// lets go of and where each pick-up may land, and the table turns pointer and keyboard input
// into moves (klondike.md, "Interaction and accessibility").
import type { Rank, Suit } from '@joystyk/kit/cards';

/** A face-up card: its stable id (an animation key) and its face. */
export type FaceCard = { readonly id: string; readonly rank: Rank; readonly suit: Suit };

/** A face-down card. It carries no id, so nothing about it reaches the page. */
export type DownCard = { readonly hidden: true };

export type PileCard = FaceCard | DownCard;

/**
 * How a pile shows its cards:
 * - `down`: a column, each card lower than the last, so every face-up card shows its strip;
 * - `right`: fanned to the right (a draw-3 waste, completed runs), showing the last `show`;
 * - `stack`: squared up, only the top card visible (stock, foundations, free cells).
 */
export type Fan = 'down' | 'right' | 'stack';

export type PileSpec = {
  /** Unique within the table: `t3`, `waste`, `f0`. Moves name piles by it. */
  readonly id: string;
  /** The accessible name, already in words: "Column 3: 2 face-down cards, then 9 of spades." */
  readonly label: string;
  /** Bottom to top. */
  readonly cards: readonly PileCard[];
  readonly fan: Fan;
  /** For `right` and `stack`: how many cards from the top are drawn. Default 1 for a stack, 3 fanned. */
  readonly show?: number;
  /** How many cards from the top may be picked up together; 0 for none. */
  readonly pickable: number;
  /** Said when the player asks for more cards than `pickable` (Spider: "different suits"). */
  readonly limit?: string;
  /** Legal destinations by pick-up size: `targets[k - 1]` lists the piles `k` cards may go to. */
  readonly targets?: readonly (readonly string[])[];
  /** Clicking the pile, or Enter on it, runs its action instead of picking up (the stock). */
  readonly action?: boolean;
  /** What an empty pile shows: "A" on a foundation, "K" on a column, "↺" on a stock that can redeal. */
  readonly mark?: string;
  /** A styling hook for the game's theme: `stock`, `waste`, `foundation`, `column`, `cell`, `runs`. */
  readonly kind: string;
  /** The number key that jumps to this pile: "1" … "9", "0". */
  readonly key?: string;
  /** How many grid columns the pile spans. Default 1. */
  readonly span?: number;
  /** Said after "Picked up …" from this pile: "Up to 5 can move." */
  readonly note?: string;
  /** Half-card horizontal steps and half-card rows in a freely placed region. */
  readonly position?: { readonly row: number; readonly column: number };
  /** A visible, non-color cue, such as a Pyramid partner's value. */
  readonly badge?: string;
  /** Up/Down reads individual cards without changing the one-card action. */
  readonly inspect?: boolean;
};

/** Where a region sits on the table grid. Tab order follows the region list, not the place. */
export type Place = 'top-start' | 'top-end' | 'main' | 'bottom-start' | 'bottom-end';

export type RegionSpec = {
  readonly id: string;
  /** "Stock and waste", "Foundations", "Tableau". */
  readonly label: string;
  readonly place: Place;
  readonly piles: readonly PileSpec[];
  readonly placement?: 'free';
};

/** A suggested move, outlined on the table. */
export type HintSpec = { readonly from: string; readonly to: string; readonly count: number };

export type TableLayout = {
  /** The table's name: "Klondike table". */
  readonly label: string;
  /** Grid columns the cards are sized for: 7 for Klondike, 8 for FreeCell, 10 for Spider. */
  readonly columns: number;
  readonly regions: readonly RegionSpec[];
  readonly hint: HintSpec | null;
  /**
   * Single-key shortcuts that act on the focused pile (Klondike's `F`, FreeCell's `C`). The
   * table reports them as `Key` outputs with the pile and count; other keys bubble to the game.
   */
  readonly keys: readonly string[];
  /** Number shortcuts activate the named pile (rather than just focusing it). */
  readonly activateNumbers?: boolean;
  /** Changes whenever the cards do (the session revision). A change drops any pick-up. */
  readonly version: number;
};

/** Card backs: Klondike's lattice, Spider's fine-line web, FreeCell's cells. All original. */
export type Back = 'lattice' | 'web' | 'cells' | 'terraces' | 'contours' | 'dunes';

export type TableOptions = {
  /** WCAG 2.1.4: false turns off number keys and the layout's single-key shortcuts. */
  readonly singleKeys: boolean;
  /** Reduced motion: cards move instantly. */
  readonly calm: boolean;
  /** Blue diamonds and green clubs, for players who struggle with red and black. */
  readonly fourColor: boolean;
  readonly back: Back;
};

export const DEFAULT_OPTIONS: TableOptions = { singleKeys: true, calm: false, fourColor: false, back: 'lattice' };

export const EMPTY_LAYOUT: TableLayout = {
  label: 'Card table',
  columns: 7,
  regions: [],
  hint: null,
  keys: [],
  version: 0,
};

export const isFaceCard = (card: PileCard | undefined): card is FaceCard => card !== undefined && !('hidden' in card);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** A light shape check for the `layout` property (development builds validate properties). */
export const isTableLayout = (value: unknown): value is TableLayout =>
  isRecord(value) &&
  typeof value['label'] === 'string' &&
  typeof value['columns'] === 'number' &&
  Array.isArray(value['regions']) &&
  typeof value['version'] === 'number';

export const isTableOptions = (value: unknown): value is TableOptions =>
  isRecord(value) &&
  typeof value['singleKeys'] === 'boolean' &&
  typeof value['calm'] === 'boolean' &&
  typeof value['fourColor'] === 'boolean' &&
  typeof value['back'] === 'string';

/** Every pile with its region index and position, in Tab order. */
export const allPiles = (
  layout: TableLayout,
): readonly { readonly region: number; readonly index: number; readonly pile: PileSpec }[] =>
  layout.regions.flatMap((region, r) => region.piles.map((pile, index) => ({ region: r, index, pile })));

export const findPile = (
  layout: TableLayout,
  id: string,
): { readonly region: number; readonly index: number; readonly pile: PileSpec } | null =>
  allPiles(layout).find((entry) => entry.pile.id === id) ?? null;

/** The face-up cards at the top of a pile, `count` of them, bottom first. */
export const topCards = (pile: PileSpec, count: number): FaceCard[] =>
  pile.cards.slice(Math.max(0, pile.cards.length - count)).filter(isFaceCard);

/** True when `count` cards from `from` may go to `to`. */
export const isTarget = (pile: PileSpec, count: number, to: string): boolean =>
  pile.targets?.[count - 1]?.includes(to) === true;
