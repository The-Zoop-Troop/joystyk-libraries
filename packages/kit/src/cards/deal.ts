// Deal helpers. The deck is an array whose index 0 is the top card. Nothing here draws
// randomness: shuffle with `rng.shuffle` first, then deal. Seats are absolute (0 … n − 1).

import type { SeatId } from '@joystyk/contracts';

const checkSeats = (seats: number, startSeat: SeatId): void => {
  if (!Number.isSafeInteger(seats) || seats < 1)
    throw new RangeError(`seats must be a positive integer, got ${seats}.`);
  if (!Number.isSafeInteger(startSeat) || startSeat < 0 || startSeat >= seats) {
    throw new RangeError(`startSeat must be a seat from 0 to ${seats - 1}, got ${startSeat}.`);
  }
};

/** The top `count` cards, and the rest. Throws a `RangeError` when the deck is too short. */
export const draw = <C>(deck: readonly C[], count: number): { drawn: C[]; rest: C[] } => {
  if (!Number.isSafeInteger(count) || count < 0 || count > deck.length) {
    throw new RangeError(`Can't draw ${count} from a deck of ${deck.length}.`);
  }
  return { drawn: deck.slice(0, count), rest: deck.slice(count) };
};

/** Turns up the top card, as a starter or upcard. Throws a `RangeError` on an empty deck. */
export const turnUp = <C>(deck: readonly C[]): { card: C; rest: C[] } => {
  const { drawn, rest } = draw(deck, 1);
  return { card: drawn[0]!, rest };
};

/**
 * Deals `perSeat` cards to each of `seats` seats, one card at a time, starting with
 * `startSeat` and going up in seat order. `hands[s]` is seat `s`'s hand, in the order its
 * cards were dealt.
 */
export const dealRoundRobin = <C>(
  deck: readonly C[],
  seats: number,
  perSeat: number,
  startSeat: SeatId = 0,
): { hands: C[][]; rest: C[] } => {
  checkSeats(seats, startSeat);
  const { drawn, rest } = draw(deck, seats * perSeat);
  const hands: C[][] = Array.from({ length: seats }, () => []);
  drawn.forEach((card, i) => hands[(startSeat + i) % seats]!.push(card));
  return { hands, rest };
};

/**
 * Deals the whole deck one card at a time, starting with `startSeat`, as Old Maid and War
 * do. Hands differ by at most one card; the seats dealt to first get the extras.
 */
export const dealAll = <C>(deck: readonly C[], seats: number, startSeat: SeatId = 0): C[][] => {
  checkSeats(seats, startSeat);
  const hands: C[][] = Array.from({ length: seats }, () => []);
  deck.forEach((card, i) => hands[(startSeat + i) % seats]!.push(card));
  return hands;
};
