// Hidden-hand sampling for card AI (hearts.md, "Shared needs", item 8). An AI that looks
// ahead can't see the other hands, so it imagines them: it deals the cards it can't see
// among the other seats in a way that agrees with everything it knows (each seat's card
// count, the suits a seat has shown it lacks, cards it knows a seat holds), plays each
// imagined deal out, and averages. This is "determinization". The sampler is pure: every
// draw comes from the `rng` it is given.
//
// Constraints can make naive rejection sampling slow or hopeless (a seat void in three
// suits must take the fourth), so the sampler places the most constrained cards first and
// never makes a choice that leaves the rest impossible. It checks that with Hall's
// condition, which is exact here: the seats a card may go to depend only on the card, so
// a deal exists exactly when, for every set of seats S, the cards that may only go to
// seats in S fit into S's free places.

import type { Rng, SeatId } from '@joystyk/contracts';
import type { Suit, SuitedFace } from './card.ts';
import type { Play } from './tricks.ts';

/** The most seats the sampler handles: Hall's check visits every subset of seats. */
export const MAX_SAMPLE_SEATS = 12;

/** What the AI knows about the cards it can't see. */
export type SampleSpec<C> = {
  /** The unseen cards whose places are unknown. Each goes to exactly one seat. */
  readonly cards: readonly C[];
  /**
   * How many unseen cards each seat holds, by seat, `known` cards included. The viewer's own
   * seat (and any seat with no hidden cards) is 0. The counts minus the known cards must add
   * up to `cards.length`.
   */
  readonly counts: readonly number[];
  /** Suits each seat is known to lack, by seat: a seat that didn't follow suit is void in it. */
  readonly voids?: readonly (readonly Suit[] | undefined)[];
  /**
   * Cards known to be in a given hand, such as the cards this seat passed in Hearts. They are
   * not in `cards`; each lands in its seat's hand first and counts toward that seat's count.
   */
  readonly known?: readonly { readonly seat: SeatId; readonly card: C }[];
  /** Any further rule: false when `seat` can't hold `card`. */
  readonly allowed?: (card: C, seat: SeatId) => boolean;
};

const popcount = (mask: number): number => {
  let n = 0;
  for (let m = mask; m !== 0; m &= m - 1) n += 1;
  return n;
};

type Problem<C> = {
  readonly seats: number;
  /** Free places per seat, after the known cards. */
  readonly free: number[];
  /** The seats each card may go to, as a bit mask, by card index. */
  readonly masks: number[];
  /** Cards still to place, counted by mask. */
  readonly byMask: Map<number, number>;
  readonly known: readonly { readonly seat: SeatId; readonly card: C }[];
};

/** Builds the problem, or returns null when the counts don't add up. */
const setUp = <C extends SuitedFace>(spec: SampleSpec<C>): Problem<C> | null => {
  const seats = spec.counts.length;
  if (seats > MAX_SAMPLE_SEATS)
    throw new RangeError(`sampleHands handles at most ${MAX_SAMPLE_SEATS} seats, got ${seats}.`);
  const known = spec.known ?? [];
  const free = spec.counts.map((n) => {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Hand counts must be non-negative integers, got ${n}.`);
    return n;
  });
  for (const { seat } of known) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= seats)
      throw new RangeError(`A known card names seat ${seat}, outside 0 to ${seats - 1}.`);
    free[seat] = free[seat]! - 1;
    if (free[seat]! < 0) return null;
  }
  if (free.reduce((a, b) => a + b, 0) !== spec.cards.length) return null;
  const masks = spec.cards.map((card) => {
    let mask = 0;
    for (let seat = 0; seat < seats; seat += 1) {
      if (spec.counts[seat] === 0) continue;
      if (spec.voids?.[seat]?.includes(card.suit) === true) continue;
      if (spec.allowed !== undefined && !spec.allowed(card, seat)) continue;
      mask |= 1 << seat;
    }
    return mask;
  });
  const byMask = new Map<number, number>();
  for (const mask of masks) byMask.set(mask, (byMask.get(mask) ?? 0) + 1);
  return { seats, free, masks, byMask, known };
};

/** Hall's condition: every set of seats has room for the cards that may only go there. */
const feasible = (seats: number, free: readonly number[], byMask: ReadonlyMap<number, number>): boolean => {
  const all = (1 << seats) - 1;
  for (let set = 0; set <= all; set += 1) {
    let room = 0;
    for (let seat = 0; seat < seats; seat += 1) if ((set & (1 << seat)) !== 0) room += free[seat]!;
    let need = 0;
    for (const [mask, n] of byMask) if (n > 0 && (mask & ~set) === 0) need += n;
    if (need > room) return false;
  }
  return true;
};

/** True when some deal agrees with `spec`. Draws nothing. */
export const canSampleHands = <C extends SuitedFace>(spec: SampleSpec<C>): boolean => {
  const problem = setUp(spec);
  return problem !== null && feasible(problem.seats, problem.free, problem.byMask);
};

/**
 * Deals the unseen cards among the seats, consistent with `spec`, drawing only from `rng`.
 * `hands[seat]` holds that seat's known cards first, then the cards dealt to it; seats with
 * a count of 0 get empty hands. Returns null when no deal agrees with `spec`.
 *
 * Without constraints every deal is equally likely, as if the unseen cards were shuffled
 * and dealt. With constraints the most constrained cards are placed first, each to a seat
 * chosen in proportion to its free places among the seats that keep the rest possible; the
 * result is always consistent, though not exactly uniform over consistent deals.
 */
export const sampleHands = <C extends SuitedFace>(spec: SampleSpec<C>, rng: Rng): C[][] | null => {
  const problem = setUp(spec);
  if (problem === null) return null;
  const { seats, free, masks, byMask, known } = problem;
  if (!feasible(seats, free, byMask)) return null;
  const hands: C[][] = Array.from({ length: seats }, () => []);
  for (const { seat, card } of known) hands[seat]!.push(card);
  // A random order, then the most constrained cards first (Array.prototype.sort is stable).
  const order = rng
    .shuffle(spec.cards.map((_, index) => index))
    .sort((a, b) => popcount(masks[a]!) - popcount(masks[b]!));
  // When every card may go to every seat with room, no choice can strand a later card.
  let open = 0;
  for (let seat = 0; seat < seats; seat += 1) if (free[seat]! > 0) open |= 1 << seat;
  const constrained = [...byMask.keys()].some((mask) => (open & ~mask) !== 0);
  for (const index of order) {
    const mask = masks[index]!;
    byMask.set(mask, byMask.get(mask)! - 1);
    let candidates: SeatId[] = [];
    for (let seat = 0; seat < seats; seat += 1)
      if ((mask & (1 << seat)) !== 0 && free[seat]! > 0) candidates.push(seat);
    let placed: SeatId | null = null;
    while (candidates.length > 0) {
      const total = candidates.reduce((sum, seat) => sum + free[seat]!, 0);
      let ticket = rng.int(0, total);
      let seat = candidates[0]!;
      for (const candidate of candidates) {
        ticket -= free[candidate]!;
        if (ticket < 0) {
          seat = candidate;
          break;
        }
      }
      free[seat] = free[seat]! - 1;
      if (!constrained || feasible(seats, free, byMask)) {
        placed = seat;
        break;
      }
      free[seat] = free[seat]! + 1;
      candidates = candidates.filter((c) => c !== seat);
    }
    // Unreachable while Hall's condition held before this card; kept as a guard.
    if (placed === null) return null;
    hands[placed]!.push(spec.cards[index]!);
  }
  return hands;
};

/**
 * The suits each seat has shown it lacks, from the tricks played so far: a seat that played
 * another suit to a trick is void in the suit that was led. `tricks` lists each trick's plays
 * in order, the current, unfinished trick included. Returns one list per seat, each suit once.
 */
export const inferVoids = <C extends SuitedFace>(tricks: readonly (readonly Play<C>[])[], seats: number): Suit[][] => {
  const voids: Suit[][] = Array.from({ length: seats }, () => []);
  for (const plays of tricks) {
    const led = plays[0]?.card.suit;
    if (led === undefined) continue;
    for (const { seat, card } of plays) {
      const list = voids[seat];
      if (list !== undefined && card.suit !== led && !list.includes(led)) list.push(led);
    }
  }
  return voids;
};
