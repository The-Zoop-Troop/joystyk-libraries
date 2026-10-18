/**
 * A stable seat index, 0 … players − 1. Seat ids are absolute: a game that draws the viewer
 * at the bottom of the table rotates inside its own view code, never in the contract.
 */
export type SeatId = number;

/** Who plays a seat. */
export type Controller = 'human' | 'ai';

/** A seat as the platform describes it to the engine and to the frame. */
export type SeatInfo = {
  readonly id: SeatId;
  /** Display name, already filtered (D-11). */
  readonly name: string;
  readonly controller: Controller;
  /** One of the engine's declared AI levels; present only for AI seats. */
  readonly aiLevel?: string;
};
