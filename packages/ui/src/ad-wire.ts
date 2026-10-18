// What `<ad-slot>` asks the site's ad endpoint, and what it gets back (monetization.md,
// "Serving"). Both sides import this file: the site builds its answers to fit it, and the
// browser parses every answer through it before rendering anything (invariant 2). Browser
// code imports zod/mini (D-22).
//
// A request carries only the context of the page: the slot, the kind of page, and the game
// or category the page is about. Never a user, a cookie or a device: every visitor on the
// same page and date gets the same answer, so it can be cached at the edge.
import * as z from 'zod/mini';
import { SLOTS, isSlotId, type SlotId, type SlotSurface } from './slots.ts';

/** Where `<ad-slot>` asks which creative to show. */
export const AD_SLOT_PATH = '/api/ads/slot';
/** Where a rendered creative reports its impression (a beacon, POST with no body). */
export const AD_IMPRESSION_PATH = '/api/ads/impression';
/** The first-party click notice ("You're leaving Joystyk"): `/ads/click/<creative id>?slot=<slot id>`. */
export const AD_CLICK_PREFIX = '/ads/click/';
/** Creative images, at content-hashed, immutable URLs: `/ads/creative/<sha256>.<ext>`. */
export const AD_CREATIVE_PREFIX = '/ads/creative/';

export const SLOT_SURFACES = ['home', 'category', 'game', 'results', 'daily'] as const satisfies readonly SlotSurface[];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A game or category id: kebab-case, as the catalog writes them. */
export const isContextId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 64 && KEBAB.test(value);

/** The context a slot sends: what the page is about, never who is looking at it. */
export interface AdQuery {
  readonly slot: SlotId;
  readonly page: SlotSurface;
  /** The game the page or screen is about, if any. The server derives its category. */
  readonly game: string | null;
  /** The category page's category, if any (ignored when `game` is set). */
  readonly category: string | null;
}

/** The surface a slot is on when its element doesn't say: the first the registry lists. */
export const defaultSurface = (slotId: SlotId): SlotSurface =>
  SLOTS.find((s) => s.id === slotId)?.surfaces[0] ?? 'home';

/**
 * The request URL for `query`, with its parameters in one fixed order and empty ones left out,
 * so equal contexts share one cache entry at the edge.
 */
export function adQueryUrl(query: AdQuery): string {
  const params = new URLSearchParams({ slot: query.slot, page: query.page });
  if (query.game !== null) params.set('game', query.game);
  else if (query.category !== null) params.set('category', query.category);
  return `${AD_SLOT_PATH}?${params.toString()}`;
}

/** A path on this site: starts with one `/`, never `//` or a backslash (no other origin). */
const sitePath = z
  .string()
  .check(
    z.refine(
      (value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && value.length <= 512,
      'Expected a path on this site',
    ),
  );
const text = (max: number) => z.string().check(z.minLength(1), z.maxLength(max));
const dimension = z.int().check(z.positive(), z.lte(4096));

/** A booked creative: an image, its alt text and a headline, linked through the click notice. */
export const CreativeFillSchema = z.object({
  kind: z.literal('creative'),
  id: z.int().check(z.positive()),
  image: z.object({ src: sitePath, width: dimension, height: dimension }),
  alt: text(150),
  headline: text(90),
  /** The click notice on this site; the advertiser's link never reaches the page. */
  href: sitePath,
  /** Where the slot reports that the creative rendered. */
  beacon: sitePath,
});

/** Our own promotion for an unsold slot: a game from the catalog, or "Advertise with us". */
export const HouseFillSchema = z.object({
  kind: z.literal('house'),
  headline: text(90),
  text: text(200),
  /** The call to action, the link's visible words. */
  cta: text(40),
  href: sitePath,
});

/** Nothing to show: the slot collapses. */
export const CollapseFillSchema = z.object({ kind: z.literal('collapse') });

export const AdFillSchema = z.discriminatedUnion('kind', [CreativeFillSchema, HouseFillSchema, CollapseFillSchema]);

export type CreativeFill = z.infer<typeof CreativeFillSchema>;
export type HouseFill = z.infer<typeof HouseFillSchema>;
export type AdFill = z.infer<typeof AdFillSchema>;

/** Parses an endpoint answer; null for anything that doesn't fit, which collapses the slot. */
export const parseAdFill = (value: unknown): AdFill | null => {
  const parsed = AdFillSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const contextId = z.string().check(z.refine(isContextId, 'Expected a kebab-case id'));

/** The endpoint's query string, as an object of its parameters. */
export const AdQuerySchema = z
  .object({
    slot: z.string().check(z.refine(isSlotId, 'Expected a slot id from packages/ui/src/slots.ts')),
    page: z.enum(SLOT_SURFACES),
    game: z.optional(contextId),
    category: z.optional(contextId),
  })
  .check(
    z.refine(
      (q) => SLOTS.some((s) => s.id === q.slot && s.surfaces.includes(q.page)),
      'The slot never appears on that kind of page',
    ),
  );

/** Parses the query string the endpoint receives. Null when any part is missing or invalid. */
export function parseAdQuery(params: URLSearchParams): AdQuery | null {
  const parsed = AdQuerySchema.safeParse(Object.fromEntries(params));
  if (!parsed.success) return null;
  const { slot, page, game, category } = parsed.data;
  return { slot: slot as SlotId, page, game: game ?? null, category: game === undefined ? (category ?? null) : null };
}
