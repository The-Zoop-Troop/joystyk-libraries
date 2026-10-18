// Turn order around a table of absolute seats 0 … seats − 1. "Clockwise" is increasing
// seat order; a game that draws seats differently rotates in its own view code.

import type { SeatId } from '@joystyk/contracts';

const checkSeat = (seat: SeatId, seats: number): void => {
  if (!Number.isSafeInteger(seats) || seats < 1)
    throw new RangeError(`seats must be a positive integer, got ${seats}.`);
  if (!Number.isSafeInteger(seat) || seat < 0 || seat >= seats) {
    throw new RangeError(`Seat ${seat} isn't at a table of ${seats}.`);
  }
};

/** The seat `steps` places after `seat` (before, when negative), wrapping around the table. */
export const seatAfter = (seat: SeatId, seats: number, steps = 1): SeatId => {
  checkSeat(seat, seats);
  return (((seat + steps) % seats) + seats) % seats;
};

/** Every seat once, starting at `start` and going clockwise: `seatsFrom(2, 4)` is `[2, 3, 0, 1]`. */
export const seatsFrom = (start: SeatId, seats: number): SeatId[] => {
  checkSeat(start, seats);
  return Array.from({ length: seats }, (_, i) => (start + i) % seats);
};

/**
 * The next seat after `seat` for which `active` is true (players still in the hand, seats
 * with cards left), or null when no other seat is. `seat` itself is checked last, so a
 * lone active player gets the turn back.
 */
export const nextActiveSeat = (seat: SeatId, seats: number, active: (seat: SeatId) => boolean): SeatId | null => {
  checkSeat(seat, seats);
  for (let step = 1; step <= seats; step += 1) {
    const candidate = (seat + step) % seats;
    if (active(candidate)) return candidate;
  }
  return null;
};
