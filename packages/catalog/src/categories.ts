// The categories a game's manifest may name. A category gets a page only once it has a
// game (the registry counts them), so planned categories can be listed here early.

export interface CategoryDefinition {
  /** Kebab-case; appears in /categories/<id>. */
  readonly id: string;
  /** Display name, e.g. "Dice". */
  readonly name: string;
  /** Lowercase singular for prose and titles, e.g. "dice game". */
  readonly noun: string;
  /** One or two sentences for the category page and its meta description. */
  readonly description: string;
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'arcade',
    name: 'Arcade',
    noun: 'arcade game',
    description: 'Fast, real-time games built on reflexes and timing. One more go is always one click away.',
  },
  {
    id: 'board',
    name: 'Board',
    noun: 'board game',
    description: 'Classic board games for two: play the computer or pass the device to a friend.',
  },
  {
    id: 'cards',
    name: 'Cards',
    noun: 'card game',
    description: 'Card games to play alone, against computer opponents, or with friends at one table.',
  },
  {
    id: 'dice',
    name: 'Dice',
    noun: 'dice game',
    description: 'Dice games of luck and nerve, for a quick turn or a long party.',
  },
  {
    id: 'puzzle',
    name: 'Puzzle',
    noun: 'puzzle',
    description: 'Puzzles to solve at your own pace, with no clock unless you want one.',
  },
  {
    id: 'word',
    name: 'Word',
    noun: 'word game',
    description: 'Word games and daily puzzles, the same for everyone each day.',
  },
];

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

export const findCategory = (id: string): CategoryDefinition | undefined => byId.get(id);
