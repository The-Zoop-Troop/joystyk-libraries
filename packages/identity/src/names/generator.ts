// The default display name: arcade-flavored, friendly, and safe by construction. Every
// combination passes checkDisplayName (a test proves it), so a generated name never needs
// a second roll.
import { BLOCKED_NUMBERS } from './blocklist.ts';

/** A uniform random number in [0, 1). Injected, so names are reproducible in tests. */
export type Random = () => number;

export const NAME_ADJECTIVES: readonly string[] = [
  'Arcade',
  'Atomic',
  'Bonus',
  'Bouncy',
  'Brave',
  'Chrome',
  'Clever',
  'Combo',
  'Cosmic',
  'Crystal',
  'Dizzy',
  'Golden',
  'Hyper',
  'Jolly',
  'Laser',
  'Lucky',
  'Mega',
  'Mighty',
  'Neon',
  'Nimble',
  'Pixel',
  'Plucky',
  'Quantum',
  'Rapid',
  'Retro',
  'Rocket',
  'Royal',
  'Silver',
  'Snappy',
  'Sparky',
  'Speedy',
  'Starry',
  'Stellar',
  'Sunny',
  'Super',
  'Swift',
  'Turbo',
  'Zippy',
];

export const NAME_NOUNS: readonly string[] = [
  'Badger',
  'Beetle',
  'Bunny',
  'Cactus',
  'Captain',
  'Champ',
  'Comet',
  'Corgi',
  'Dolphin',
  'Dragon',
  'Falcon',
  'Fox',
  'Gecko',
  'Griffin',
  'Hamster',
  'Hero',
  'Kitten',
  'Koala',
  'Llama',
  'Lynx',
  'Mango',
  'Meteor',
  'Muffin',
  'Narwhal',
  'Noodle',
  'Nova',
  'Otter',
  'Owl',
  'Panda',
  'Pebble',
  'Penguin',
  'Phoenix',
  'Pickle',
  'Pilot',
  'Puffin',
  'Quasar',
  'Ranger',
  'Robot',
  'Sprite',
  'Taco',
  'Tiger',
  'Unicorn',
  'Waffle',
  'Whale',
  'Wizard',
  'Yeti',
];

/** Numbers 10–99, minus any the blocklist refuses. */
export const NAME_NUMBERS: readonly number[] = Array.from({ length: 90 }, (_, i) => i + 10).filter(
  (n) => !BLOCKED_NUMBERS.includes(String(n)),
);

/** A uniformly random item of a non-empty list. */
export const pick = <T>(items: readonly T[], random: Random): T => {
  const item = items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  if (item === undefined) throw new RangeError('Cannot pick from an empty list');
  return item;
};

/** A name like "Pixel Fox 42": adjective, noun, two-digit number. */
export const generateName = (random: Random): string =>
  `${pick(NAME_ADJECTIVES, random)} ${pick(NAME_NOUNS, random)} ${pick(NAME_NUMBERS, random)}`;
