// Catalog data as it crosses the wire: the store seed in every page and the /api/games
// responses. Plain JSON, decoded in the browser through Zod's Standard Schema interface
// (D-18, D-22; browser code uses zod/mini). The server builds these values from the
// registry, so the client never bundles the registry itself.
import { isGameId, isGameOptions, type Mode } from '@joystyk/contracts';
import * as z from 'zod/mini';

export const MODES = ['solo', 'ai', 'pass-and-play', 'p2p', 'server', 'daily'] as const satisfies readonly Mode[];

/** Whether a game can be played yet. Every placeholder is `coming-soon`. */
export const GAME_STATUSES = ['coming-soon', 'available'] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

const count = z.int().check(z.positive());
const gameId = z.string().check(z.refine(isGameId, 'not a kebab-case game id'));

export const GameSummarySchema = z.object({
  id: gameId,
  name: z.string(),
  summary: z.string(),
  category: z.string(),
  tags: z.array(z.string()),
  modes: z.array(z.enum(MODES)),
  /** `default`: the table size the launcher starts at against the computer (the manifest's `players.default`). */
  players: z.object({ min: count, max: count, default: z.optional(count) }),
  status: z.enum(GAME_STATUSES),
  /** True while the entry is a stand-in written before the game exists. */
  placeholder: z.boolean(),
  featured: z.boolean(),
});

/** What a card, a grid tile and a lineup row need. */
export type GameSummary = z.infer<typeof GameSummarySchema>;

export const GameDetailSchema = z.extend(GameSummarySchema, {
  description: z.string(),
  /**
   * The manifest's `pageTitle`, the fuller name people search for ("Klondike Solitaire"):
   * the page's title, heading and structured data use it. Cards and the launcher use `name`.
   */
  pageTitle: z.optional(z.string()),
  /** A short rules summary; the full rules arrive with the game. */
  rules: z.array(z.string()),
  aiLevels: z.array(z.string()),
  essentialMotion: z.boolean(),
  /** The game plays AI-generated content, so the launcher asks for the notice first (D-44). */
  aiContent: z.boolean(),
  /** The game manifest's `assets`: its asset list, which "Make available offline" pins. */
  assets: z.string(),
  options: z.optional(z.custom<import('@joystyk/contracts').GameOption[]>(isGameOptions)),
  attribution: z.optional(
    z.object({
      text: z.string().check(z.minLength(1), z.maxLength(500)),
      href: z.string().check(
        z.refine((value) => {
          try {
            const url = new URL(value);
            return url.protocol === 'https:' && url.username === '' && url.password === '';
          } catch {
            return false;
          }
        }, 'credit links must use HTTPS'),
      ),
    }),
  ),
});

/** What a game page needs. */
export type GameDetail = z.infer<typeof GameDetailSchema>;

export const GameSummaryListSchema = z.array(GameSummarySchema);

export const CategoryInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Lowercase singular for prose and titles, e.g. "dice game". */
  noun: z.string(),
  description: z.string(),
  games: count,
});

/** A category that has at least one game. Every page's seed carries the full list. */
export type CategoryInfo = z.infer<typeof CategoryInfoSchema>;
