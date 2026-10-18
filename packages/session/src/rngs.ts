// The runners' random sources. The game's stream is restored with the factory the caller
// passes (the kit's `restoreRng` by default). The AI's stream is the platform's own: each AI
// decision gets a child forked with the kit's `forkRng`, so the stream moves by a fixed
// amount per accepted AI move however much a search draws, and a worker can receive the
// child as plain `RngState` (game-contract.md, "AI: runner-driven or engine-driven").
import type { RngState, SeatId } from '@joystyk/contracts';
import { forkRng, restoreRng, SFC32 } from '@joystyk/kit';
import type { RngFactory } from './ports.ts';

/** The default factory: the kit's SFC32. */
export const defaultRestoreRng: RngFactory = restoreRng;

/**
 * Restores a state from the AI stream. Forks are always the kit's SFC32, whatever algorithm
 * the game's seed names; anything else goes to the game's factory.
 */
export const aiRestore =
  (game: RngFactory): RngFactory =>
  (state) =>
    state.algorithm === SFC32 ? restoreRng(state) : game(state);

/** An AI seed derived from a game's random state: a fork of a copy, so the game's stream doesn't move. */
export const deriveAiSeed = (state: RngState, restore: RngFactory): RngState => forkRng(restore(state)).save();

/**
 * The child stream for one decision of `seat`: fork number `seat` of the AI stream's state.
 * Seats choosing at the same time get different children; a choice that is cancelled and
 * started again gets the same one, because the stream only moves when a move is accepted.
 */
export const aiDecisionSeed = (state: RngState, seat: SeatId, restore: RngFactory): RngState => {
  const parent = restore(state);
  for (let i = 0; i < seat; i += 1) forkRng(parent);
  return forkRng(parent).save();
};

/**
 * The AI stream after an accepted AI move: one fork per seat, past every child the old state
 * handed out, so no later decision reuses a child.
 */
export const advanceAi = (state: RngState, seats: number, restore: RngFactory): RngState => {
  const parent = restore(state);
  for (let i = 0; i < seats; i += 1) forkRng(parent);
  return parent.save();
};
