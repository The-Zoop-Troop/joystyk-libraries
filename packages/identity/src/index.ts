// @joystyk/identity: the guest player (D-11). A stable player id made on the device, a
// display name that passes a strict all-ages filter, and a preset avatar. Nothing personal
// (D-26). This entry point is headless; '@joystyk/identity/browser' supplies Web Crypto, and
// '@joystyk/identity/names' is the name filter and generator alone, for the room server.

export { AVATAR_IDS, isAvatarId, randomAvatar, type AvatarId } from './avatars.ts';
export { generateName, NAME_ADJECTIVES, NAME_NOUNS, NAME_NUMBERS, pick, type Random } from './names/generator.ts';
export {
  checkDisplayName,
  isBlocked,
  isDisplayName,
  NAME_LIMITS,
  normalizeDisplayName,
  type NameRejection,
  type NameRejectionCode,
} from './names/filter.ts';
export {
  createIdentity,
  DEVICE_RECORD,
  isPlayerId,
  PROFILE_RECORD,
  type Identity,
  type IdentityError,
  type IdentityOptions,
  type PlayerId,
  type Profile,
} from './identity.ts';
