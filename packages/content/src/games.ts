import type { DailyGenerator } from './pipeline.ts';

/** One registry for scheduled content and staff moderation. No game code is imported here. */
export const CONTENT_GAMES = {
  daily: [
    'pipe-link',
    'mini-golf',
    'garden-crossing',
    'tower-stacker',
    'rock-field',
    'gem-swap',
    'map-guess',
    'equation',
    'word-hunt',
    'four-groups',
    'honeycomb',
    'word-of-the-day',
    'daily-word',
    'crossword',
    'word-flux',
    'freecell',
    'pyramid',
    'tripeaks',
    'golf',
    'code-breaker',
    'word-ladder',
    'queens',
    'tile-match',
  ],
  packs: ['letter-drop', 'word-flux'],
} as const;

export type DailyContentGame = (typeof CONTENT_GAMES.daily)[number];

/** Apps supply the implementations; the shared registry determines the complete lineup. */
export const dailyGenerators = (
  factories: Readonly<Record<DailyContentGame, () => DailyGenerator>>,
): DailyGenerator[] =>
  CONTENT_GAMES.daily.map((id) => {
    const generator = factories[id]();
    if (generator.gameId !== id) throw new Error(`The ${id} content factory returned ${generator.gameId}.`);
    return generator;
  });
