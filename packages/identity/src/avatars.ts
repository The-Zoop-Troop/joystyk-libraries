import { pick, type Random } from './names/generator.ts';

/**
 * The preset avatars. Players choose from these; there are no uploads (D-26: no personal
 * data, no public profiles). Only ids for now; the `ui` package will draw them. Ids are
 * stable forever, because profiles store them: add new ones, never rename or remove one.
 */
export const AVATAR_IDS = [
  'fox',
  'panda',
  'otter',
  'owl',
  'penguin',
  'koala',
  'tiger',
  'dragon',
  'robot',
  'alien',
  'rocket',
  'comet',
  'planet',
  'star',
  'dice',
  'joystick',
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

export const isAvatarId = (value: unknown): value is AvatarId =>
  typeof value === 'string' && (AVATAR_IDS as readonly string[]).includes(value);

/** A random preset avatar, for a new guest. */
export const randomAvatar = (random: Random): AvatarId => pick(AVATAR_IDS, random);
