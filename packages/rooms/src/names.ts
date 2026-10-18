// Seat names (D-11, D-26). Every name another player sees passes the identity package's
// filter. A refused name is replaced by a generated one, drawn from a stream seeded by the
// room itself (code, epoch, revision, seat), so the core stays pure and the same step always
// picks the same name.
import { checkDisplayName, generateName, type NameRejection } from '@joystyk/identity/names';
import { restoreRng, seedFromParts } from '@joystyk/kit';
import type { SeatId } from '@joystyk/contracts';
import type { RoomCode } from './protocol/index.ts';

/** The name a seat gets, and why the one asked for was refused (null when it was kept). */
export type AdmittedName = { readonly name: string; readonly rejection: NameRejection | null };

/** Where in the room a name is admitted; it seeds the generated name. */
export type NameSeed = {
  readonly room: RoomCode;
  readonly epoch: number;
  readonly revision: number;
  readonly seat: SeatId;
};

/** The normalized name if `checkDisplayName` accepts it; otherwise a generated one and the reason. */
export const admitName = (input: string, seed: NameSeed): AdmittedName => {
  const checked = checkDisplayName(input);
  if (checked.ok) return { name: checked.value, rejection: null };
  const rng = restoreRng(seedFromParts(['display-name', seed.room, seed.epoch, seed.revision, seed.seat]));
  return { name: generateName(() => rng.next()), rejection: checked.error };
};

/** What the player is told when their name was replaced. It never repeats the refused name. */
export const nameReplacedMessage = (rejection: NameRejection, shown: string): string =>
  `${rejection.message} You're playing as ${shown}.`;
