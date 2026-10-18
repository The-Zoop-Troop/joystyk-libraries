// The catalog store: what the browser knows about the catalog. The server seeds it per
// request with exactly what the requested page shows; client navigation fills the gaps from
// /api/games. Loading lives here, so components only send LoadSummaries or LoadGame, and
// every response is decoded at the boundary (core belief 9).
import { isGameId } from '@joystyk/contracts';
import { defineStore } from '@gyral/core';
import { get, type HttpError } from '@gyral/http';
import * as z from 'zod/mini';
import {
  CategoryInfoSchema,
  GameDetailSchema,
  GameSummaryListSchema,
  type CategoryInfo,
  type GameDetail,
  type GameSummary,
} from './wire.ts';

const LoadSchema = z.enum(['idle', 'loading', 'failed']);

/** A contact form post the server rejected: what was sent, and the errors per field. */
const ContactFormSchema = z.object({
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  errors: z.record(z.string(), z.array(z.string())),
});
export type Load = z.infer<typeof LoadSchema>;

/**
 * Where an ad click leads: the creative's id, its approved link, that link's domain as the page
 * names it, and the same-site path "Back to Joystyk" returns to.
 */
const LeavingSchema = z.object({ id: z.string(), href: z.string(), domain: z.string(), back: z.string() });
export type Leaving = z.infer<typeof LeavingSchema>;

export const CatalogStateSchema = z.object({
  /** Public origin for canonical URLs, e.g. https://joystyk.com: configuration from the server. */
  origin: z.string(),
  /** Categories with games. Small, so every page's seed carries it. */
  categories: z.array(CategoryInfoSchema),
  summaries: z.nullable(GameSummaryListSchema),
  games: z.record(z.string(), GameDetailSchema),
  /** Game ids the server said do not exist. */
  missing: z.array(z.string()),
  summariesLoad: LoadSchema,
  gameLoads: z.record(z.string(), LoadSchema),
  /** The advertise page's contact form after a rejected post (server-seeded only), else null. */
  contactForm: z.nullable(ContactFormSchema),
  /** The "You're leaving Joystyk" page's destination (server-seeded only), else null. */
  leaving: z.nullable(LeavingSchema),
});

export type CatalogState = z.infer<typeof CatalogStateSchema>;

export type CatalogMsg =
  | { readonly _tag: 'LoadSummaries' }
  | { readonly _tag: 'LoadGame'; readonly id: string }
  | { readonly _tag: 'SummariesLoaded'; readonly summaries: GameSummary[] }
  | { readonly _tag: 'GameLoaded'; readonly game: GameDetail }
  | { readonly _tag: 'GameMissing'; readonly id: string }
  | { readonly _tag: 'LoadFailed'; readonly id: string | null };

export const emptyCatalog = (origin: string, categories: readonly CategoryInfo[] = []): CatalogState => ({
  origin,
  categories: [...categories],
  summaries: null,
  games: {},
  missing: [],
  summariesLoad: 'idle',
  gameLoads: {},
  contactForm: null,
  leaving: null,
});

const statusOf = (error: HttpError): number | undefined =>
  error._tag === 'HttpStatusError' ? error.status : undefined;

export const catalog = defineStore<CatalogState, CatalogMsg>('joystyk/catalog', {
  init: () => emptyCatalog(''),
  schema: CatalogStateSchema,
  update: {
    LoadSummaries: (s) =>
      s.summaries !== null || s.summariesLoad === 'loading'
        ? s
        : [
            { ...s, summariesLoad: 'loading' },
            [
              get('/api/games', {
                schema: GameSummaryListSchema,
                key: 'catalog:summaries',
                concurrency: 'exhaust',
                onSuccess: (summaries): CatalogMsg => ({ _tag: 'SummariesLoaded', summaries }),
                onFailure: (): CatalogMsg => ({ _tag: 'LoadFailed', id: null }),
              }),
            ],
          ],
    LoadGame: (s, { id }) =>
      !isGameId(id) || id in s.games || s.missing.includes(id) || s.gameLoads[id] === 'loading'
        ? s
        : [
            { ...s, gameLoads: { ...s.gameLoads, [id]: 'loading' } },
            [
              get(`/api/games/${encodeURIComponent(id)}`, {
                schema: GameDetailSchema,
                key: `catalog:game:${id}`,
                concurrency: 'exhaust',
                onSuccess: (game): CatalogMsg => ({ _tag: 'GameLoaded', game }),
                onFailure: (error): CatalogMsg =>
                  statusOf(error) === 404 ? { _tag: 'GameMissing', id } : { _tag: 'LoadFailed', id },
              }),
            ],
          ],
    SummariesLoaded: (s, { summaries }) => ({ ...s, summaries, summariesLoad: 'idle' }),
    GameLoaded: (s, { game }) => ({
      ...s,
      games: { ...s.games, [game.id]: game },
      gameLoads: { ...s.gameLoads, [game.id]: 'idle' },
    }),
    GameMissing: (s, { id }) => ({ ...s, missing: [...s.missing, id], gameLoads: { ...s.gameLoads, [id]: 'idle' } }),
    LoadFailed: (s, { id }) =>
      id === null ? { ...s, summariesLoad: 'failed' } : { ...s, gameLoads: { ...s.gameLoads, [id]: 'failed' } },
  },
});
