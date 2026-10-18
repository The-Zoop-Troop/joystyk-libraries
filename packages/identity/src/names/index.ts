// @joystyk/identity/names: the display-name rules on their own (D-11, D-26). Pure: no DOM, no
// storage and no randomness of its own, so the room server, and anything else that shows a
// name to another player, runs the same filter and generator without the rest of identity.

export { BLOCKED_ANYWHERE, BLOCKED_NUMBERS, BLOCKED_WORDS } from './blocklist.ts';
export {
  checkDisplayName,
  isBlocked,
  isDisplayName,
  NAME_LIMITS,
  normalizeDisplayName,
  type NameRejection,
  type NameRejectionCode,
} from './filter.ts';
export { generateName, NAME_ADJECTIVES, NAME_NOUNS, NAME_NUMBERS, pick, type Random } from './generator.ts';
