// A room's policy from the game's manifest (game-contract.md, "Manifest and mounting").
import type { GameManifest } from '@joystyk/contracts';
import type { RoomPolicy } from './types.ts';

export const DEFAULT_GRACE_MS = 30_000;
export const DEFAULT_MAX_SPECTATORS = 8;
export const DEFAULT_RETAIN_MS = 24 * 60 * 60 * 1000;
/** No room outlives this, so hashed assets (kept 30 days) always outlive their rooms. */
export const MAX_ROOM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The policy a game's rooms start with. Seat counts come from `players`, the clock from
 * `clock.default`, the rest from `rooms` with platform defaults. Without an AI, an absent
 * player's seat waits rather than going to the AI.
 */
export const policyFromManifest = (manifest: GameManifest): RoomPolicy => {
  const rooms = manifest.rooms ?? {};
  return {
    seats: { min: manifest.players.min, max: manifest.players.max },
    start: rooms.start ?? 'host',
    lateJoin: rooms.lateJoin ?? 'spectate',
    absent: rooms.absent ?? (manifest.ai === null ? 'wait' : 'ai'),
    graceMs: rooms.graceMs ?? DEFAULT_GRACE_MS,
    decisionMs: manifest.clock === null || manifest.clock.mode === 'bank' ? null : manifest.clock.default * 1000,
    bank: manifest.clock?.mode === 'bank' ? manifest.clock.default : null,
    maxSpectators: rooms.maxSpectators ?? DEFAULT_MAX_SPECTATORS,
    retainMs: DEFAULT_RETAIN_MS,
  };
};

/** Why a policy can't run, or null when it can. */
export const policyProblem = (policy: RoomPolicy): string | null => {
  const { min, max } = policy.seats;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 64)
    return 'Seats must satisfy 1 ≤ min ≤ max ≤ 64.';
  if (policy.graceMs < 0 || policy.maxSpectators < 0 || policy.retainMs <= 0)
    return 'Durations and caps must not be negative.';
  if (policy.decisionMs !== null && policy.decisionMs <= 0) return 'The decision clock must be positive or off.';
  if (
    policy.bank !== undefined &&
    policy.bank !== null &&
    (policy.decisionMs !== null || policy.bank.initialMs <= 0 || policy.bank.incrementMs < 0)
  ) {
    return 'A time bank needs a positive start, no negative increment, and no per-move clock.';
  }
  return null;
};
