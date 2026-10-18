// Groups and rummy melds: pairs and books by rank (Old Maid, Go Fish), and the exact meld
// search Gin Rummy needs: sets, runs, the arrangement with the least deadwood, and the best
// layoffs onto another player's melds.

import { compareCards, type Rank, type Suit, type SuitedFace } from './card.ts';
import { deadwoodValue } from './points.ts';

export type MeldKind = 'set' | 'run';

/** A meld: a set (three or four of a rank) or a run (three or more in sequence in one suit, ace low). */
export type Meld<C> = { readonly kind: MeldKind; readonly cards: readonly C[] };

/** A hand split into melds and deadwood, with the deadwood's total value. */
export type Arrangement<C> = {
  readonly melds: readonly Meld<C>[];
  readonly deadwood: readonly C[];
  readonly points: number;
};

/** One card laid off onto `meld`, an index into the melds it was laid onto. */
export type Layoff<C> = { readonly card: C; readonly meld: number };

/** A defender's best answer to a knock: their own melds, their layoffs and what is left. */
export type Defense<C> = Arrangement<C> & { readonly layoffs: readonly Layoff<C>[] };

export type MeldOptions<C> = {
  /** A card's deadwood value. Defaults to Gin Rummy's: ace 1, faces 10. */
  readonly value?: (card: C) => number;
};

/** The meld search works on bit masks, so a hand may hold at most this many cards. */
export const MAX_MELD_HAND = 30;

/** True for three or four cards of one rank. */
export const isSet = (cards: readonly SuitedFace[]): boolean =>
  cards.length >= 3 && cards.length <= 4 && cards.every((card) => card.rank === cards[0]!.rank);

/** True for three or more cards of one suit in sequence, ace low only: A-2-3 is a run, Q-K-A is not. */
export const isRun = (cards: readonly SuitedFace[]): boolean => {
  if (cards.length < 3 || !cards.every((card) => card.suit === cards[0]!.suit)) return false;
  const ranks = cards.map((card) => card.rank).sort((a, b) => a - b);
  return ranks.every((rank, i) => i === 0 || rank === ranks[i - 1]! + 1);
};

/** The kind of meld `cards` form, or null when they form none. */
export const meldKind = (cards: readonly SuitedFace[]): MeldKind | null =>
  isSet(cards) ? 'set' : isRun(cards) ? 'run' : null;

/**
 * Takes as many disjoint groups of exactly `size` cards of equal rank as the hand holds:
 * pairs for Old Maid (`size` 2: three of a rank make one pair and leave one card, four make
 * two), books for Go Fish (`size` 4). Groups come in rank order, ace first; `rest` keeps
 * the hand's order. Jokers never group.
 */
export const takeGroups = <C extends { readonly rank: Rank | 'joker' }>(
  cards: readonly C[],
  size: number,
): { groups: C[][]; rest: C[] } => {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError(`size must be a positive integer, got ${size}.`);
  const byRank = new Map<Rank, number[]>();
  cards.forEach((card, i) => {
    if (card.rank !== 'joker') byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), i]);
  });
  const taken = new Set<number>();
  const groups: C[][] = [];
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const indices = byRank.get(rank)!;
    for (let start = 0; start + size <= indices.length; start += size) {
      const group = indices.slice(start, start + size);
      group.forEach((i) => taken.add(i));
      groups.push(group.map((i) => cards[i]!));
    }
  }
  return { groups, rest: cards.filter((_, i) => !taken.has(i)) };
};

type Candidate = { readonly indices: readonly number[]; readonly mask: number };

const combinations = (items: readonly number[], k: number): number[][] => {
  if (k === 0) return [[]];
  const out: number[][] = [];
  for (let i = 0; i <= items.length - k; i += 1) {
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([items[i]!, ...rest]);
  }
  return out;
};

const product = (choices: readonly (readonly number[])[]): number[][] =>
  choices.reduce<number[][]>((acc, options) => acc.flatMap((prefix) => options.map((o) => [...prefix, o])), [[]]);

const maskOf = (indices: readonly number[]): number => indices.reduce((mask, i) => mask | (1 << i), 0);

const lowestIndex = (mask: number): number => 31 - Math.clz32(mask & -mask);

/**
 * The search state for one hand. Cards are sorted into the canonical order (suits S, H, D,
 * C, then rank, ace low); a mask bit `i` stands for `cards[i]`. Candidates are every set and
 * run the hand could form, grouped by their lowest card, each group in lexicographic order
 * of card indices. That order decides ties, so results are deterministic.
 */
class MeldSearch<C extends SuitedFace> {
  readonly cards: readonly C[];
  readonly values: readonly number[];
  readonly full: number;
  readonly #byLowest: readonly Candidate[][];
  readonly #memo = new Map<number, number>();

  constructor(hand: readonly C[], options: MeldOptions<C>) {
    if (hand.length > MAX_MELD_HAND) {
      throw new RangeError(`The meld search takes at most ${MAX_MELD_HAND} cards, got ${hand.length}.`);
    }
    const value = options.value ?? deadwoodValue;
    this.cards = hand.slice().sort(compareCards());
    this.values = this.cards.map((card) => value(card));
    this.full = (1 << this.cards.length) - 1;

    const candidates: number[][] = [];
    const byRank = new Map<Rank, number[]>();
    const byFace = new Map<string, number[]>();
    this.cards.forEach((card, i) => {
      byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), i]);
      const key = `${card.rank}${card.suit}`;
      byFace.set(key, [...(byFace.get(key) ?? []), i]);
    });
    for (const indices of byRank.values()) {
      for (const k of [3, 4]) candidates.push(...combinations(indices, k));
    }
    for (const suit of ['S', 'H', 'D', 'C'] as const) {
      for (let start = 1; start <= 11; start += 1) {
        const choices: number[][] = [];
        for (let rank = start; rank <= 13; rank += 1) {
          const options = byFace.get(`${rank}${suit}`);
          if (options === undefined) break;
          choices.push(options);
          if (choices.length >= 3) candidates.push(...product(choices));
        }
      }
    }
    const byLowest: Candidate[][] = this.cards.map(() => []);
    for (const indices of candidates) {
      const sorted = indices.slice().sort((a, b) => a - b);
      byLowest[sorted[0]!]!.push({ indices: sorted, mask: maskOf(sorted) });
    }
    for (const group of byLowest) {
      group.sort((a, b) => {
        for (let i = 0; i < Math.min(a.indices.length, b.indices.length); i += 1) {
          if (a.indices[i] !== b.indices[i]) return a.indices[i]! - b.indices[i]!;
        }
        return a.indices.length - b.indices.length;
      });
    }
    this.#byLowest = byLowest;
  }

  /** Melds that can take the lowest card of `mask` using only cards in `mask`. */
  #fitting(mask: number): Candidate[] {
    return this.#byLowest[lowestIndex(mask)]!.filter((c) => (c.mask & mask) === c.mask);
  }

  /** The least deadwood the cards in `mask` can be left with. */
  best(mask: number): number {
    if (mask === 0) return 0;
    const cached = this.#memo.get(mask);
    if (cached !== undefined) return cached;
    const low = lowestIndex(mask);
    let result = this.values[low]! + this.best(mask & ~(1 << low));
    for (const candidate of this.#fitting(mask)) {
      result = Math.min(result, this.best(mask & ~candidate.mask));
    }
    this.#memo.set(mask, result);
    return result;
  }

  /** Every way to reach `best(mask)`, as meld index lists plus deadwood indices. */
  *#ways(mask: number): Generator<{ melds: (readonly number[])[]; deadwood: number[] }> {
    if (mask === 0) {
      yield { melds: [], deadwood: [] };
      return;
    }
    const target = this.best(mask);
    const low = lowestIndex(mask);
    for (const candidate of this.#fitting(mask)) {
      const rest = mask & ~candidate.mask;
      if (this.best(rest) !== target) continue;
      for (const way of this.#ways(rest)) yield { melds: [candidate.indices, ...way.melds], deadwood: way.deadwood };
    }
    const rest = mask & ~(1 << low);
    if (this.values[low]! + this.best(rest) === target) {
      for (const way of this.#ways(rest)) yield { melds: way.melds, deadwood: [low, ...way.deadwood] };
    }
  }

  #arrangement(way: { melds: (readonly number[])[]; deadwood: number[] }): Arrangement<C> {
    const melds = way.melds.map((indices): Meld<C> => {
      const cards = indices.map((i) => this.cards[i]!);
      return { kind: isSet(cards) ? 'set' : 'run', cards };
    });
    const deadwood = way.deadwood.map((i) => this.cards[i]!);
    return { melds, deadwood, points: way.deadwood.reduce((sum, i) => sum + this.values[i]!, 0) };
  }

  first(mask: number): Arrangement<C> {
    const { value } = this.#ways(mask).next();
    return this.#arrangement(value!);
  }

  all(mask: number): Arrangement<C>[] {
    return [...this.#ways(mask)].map((way) => this.#arrangement(way));
  }

  /** Index of the first card in canonical order matching a face and not in `used`. */
  find(rank: number, suit: Suit, used: number): number | null {
    const i = this.cards.findIndex((card, index) => card.rank === rank && card.suit === suit && !(used & (1 << index)));
    return i < 0 ? null : i;
  }
}

/**
 * The arrangement of `hand` with the least deadwood. Melds are listed by their lowest card
 * in the canonical order (suits S, H, D, C, then rank, ace low), and their cards in that
 * order too, so a run reads low to high. When several arrangements tie, this is the first
 * in that order; `bestArrangements` lists them all. Exact for any hand up to 30 cards and
 * fast for Gin Rummy's ten or eleven: the search memoizes on the set of cards left.
 */
export const bestArrangement = <C extends SuitedFace>(
  hand: readonly C[],
  options: MeldOptions<C> = {},
): Arrangement<C> => {
  const search = new MeldSearch(hand, options);
  return search.first(search.full);
};

/**
 * Every arrangement of `hand` with the least deadwood, in canonical order. Gin Rummy's
 * knocker picks among them the one that allows the fewest layoffs.
 */
export const bestArrangements = <C extends SuitedFace>(
  hand: readonly C[],
  options: MeldOptions<C> = {},
): Arrangement<C>[] => {
  const search = new MeldSearch(hand, options);
  return search.all(search.full);
};

/** True when `card` can be laid off onto `meld`: a fourth card on a set, or one rank past either end of a run. */
export const canLayOff = (card: SuitedFace, meld: Meld<SuitedFace>): boolean => {
  if (meld.kind === 'set') return meld.cards.length < 4 && card.rank === meld.cards[0]!.rank;
  const ranks = meld.cards.map((c) => c.rank);
  return (
    card.suit === meld.cards[0]!.suit && (card.rank === Math.min(...ranks) - 1 || card.rank === Math.max(...ranks) + 1)
  );
};

type LayoffOption = { readonly indices: readonly number[]; readonly mask: number };

/** Every way `search`'s hand can extend one target meld, starting with laying off nothing. */
const layoffOptions = <C extends SuitedFace>(search: MeldSearch<C>, meld: Meld<SuitedFace>): LayoffOption[] => {
  const options: LayoffOption[] = [{ indices: [], mask: 0 }];
  if (meld.kind === 'set') {
    if (meld.cards.length >= 4) return options;
    search.cards.forEach((card, i) => {
      if (card.rank === meld.cards[0]!.rank) options.push({ indices: [i], mask: 1 << i });
    });
    return options;
  }
  const suit = meld.cards[0]!.suit;
  const ranks = meld.cards.map((c) => c.rank);
  const chain = (from: number, step: number): number[] => {
    const out: number[] = [];
    let used = 0;
    for (let rank = from; rank >= 1 && rank <= 13; rank += step) {
      const i = search.find(rank, suit, used);
      if (i === null) break;
      out.push(i);
      used |= 1 << i;
    }
    return out;
  };
  const down = chain(Math.min(...ranks) - 1, -1);
  const up = chain(Math.max(...ranks) + 1, 1);
  for (let d = 0; d <= down.length; d += 1) {
    for (let u = 0; u <= up.length; u += 1) {
      if (d === 0 && u === 0) continue;
      const indices = [...down.slice(0, d), ...up.slice(0, u)];
      options.push({ indices, mask: maskOf(indices) });
    }
  }
  return options;
};

/**
 * The defender's best answer to a knock: the combination of their own melds and layoffs
 * onto `targets` (the knocker's melds) that leaves the least deadwood. A card may go into
 * the defender's own meld or onto a target, and layoffs chain: a laid-off 8 lets a 9
 * follow on the same run. Ties go to the first combination found, which lays off nothing
 * onto earlier targets before something. Throws a `RangeError` if a target isn't a meld.
 */
export const bestLayoffs = <C extends SuitedFace, T extends SuitedFace>(
  hand: readonly C[],
  targets: readonly Meld<T>[],
  options: MeldOptions<C> = {},
): Defense<C> => {
  for (const target of targets) {
    if (meldKind(target.cards) !== target.kind) {
      throw new RangeError(`Not a ${target.kind}: ${JSON.stringify(target.cards)}.`);
    }
  }
  const search = new MeldSearch(hand, options);
  const perTarget = targets.map((target) => layoffOptions(search, target));
  let bestPoints = Infinity;
  let bestChoice: LayoffOption[] = [];
  const visit = (t: number, used: number, chosen: LayoffOption[]): void => {
    if (t === perTarget.length) {
      const points = search.best(search.full & ~used);
      if (points < bestPoints) {
        bestPoints = points;
        bestChoice = chosen;
      }
      return;
    }
    for (const option of perTarget[t]!) {
      if ((option.mask & used) === 0) visit(t + 1, used | option.mask, [...chosen, option]);
    }
  };
  visit(0, 0, []);
  const laid = bestChoice.reduce((mask, option) => mask | option.mask, 0);
  const layoffs = bestChoice.flatMap((option, meld) => option.indices.map((i) => ({ card: search.cards[i]!, meld })));
  return { ...search.first(search.full & ~laid), layoffs };
};
