// The billboard slot registry (docs/design-docs/monetization.md, "v1 slots"): the one source
// of truth for slot ids, where each slot may appear, its size per breakpoint and the keys a
// campaign can target. `<ad-slot>` reserves each slot's exact box from it, so a creative
// arriving later never shifts the layout. It lives in `ui`, beside `<ad-slot>`, because the
// catalog's pages and the launcher's results screen both render slots and only `ui` is
// below both; `@joystyk/catalog` re-exports it.

export type SlotId = 'index-hero' | 'index-inline' | 'category-rail' | 'game-page' | 'results' | 'daily-presenting';

/** Every slot id, in registry order. */
export const SLOT_IDS: readonly SlotId[] = [
  'index-hero',
  'index-inline',
  'category-rail',
  'game-page',
  'results',
  'daily-presenting',
];

export const isSlotId = (value: unknown): value is SlotId =>
  typeof value === 'string' && (SLOT_IDS as readonly string[]).includes(value);

/** Pages and screens a slot can appear on. `results` and `daily` belong to the launcher. */
export type SlotSurface = 'home' | 'category' | 'game' | 'results' | 'daily';

export type TargetingKey = 'page' | 'game' | 'category' | 'date';

/** A creative's box, in CSS pixels. */
export interface SlotSize {
  readonly width: number;
  readonly height: number;
}

export interface SlotDefinition {
  readonly id: SlotId;
  /** Where the slot sits, as the monetization design describes it. */
  readonly placement: string;
  readonly shape: 'wide banner' | 'responsive banner' | 'tall rail' | 'medium rectangle' | 'logo and line';
  readonly surfaces: readonly SlotSurface[];
  /**
   * The box on narrow and wide containers. The slot is wide when the space it sits in is at
   * least as wide as the wide box; null hides the slot at that width.
   */
  readonly sizes: { readonly narrow: SlotSize | null; readonly wide: SlotSize | null };
  readonly targeting: readonly TargetingKey[];
  /** The visible label, as US FTC and UK ASA rules require. */
  readonly label: 'Advertisement' | 'Sponsored';
}

export const SLOTS: readonly SlotDefinition[] = [
  {
    id: 'index-hero',
    placement: 'Top of the home page, under the featured games. One sponsor per day or week.',
    shape: 'wide banner',
    surfaces: ['home'],
    sizes: { narrow: { width: 320, height: 100 }, wide: { width: 728, height: 90 } },
    targeting: ['page', 'date'],
    label: 'Advertisement',
  },
  {
    id: 'index-inline',
    placement: 'Between rows of the game grid; several per page, rotating creatives.',
    shape: 'responsive banner',
    surfaces: ['home'],
    sizes: { narrow: { width: 320, height: 100 }, wide: { width: 728, height: 90 } },
    targeting: ['page', 'category', 'date'],
    label: 'Advertisement',
  },
  {
    id: 'category-rail',
    placement: 'Sidebar on the index and category pages; hidden on narrow screens.',
    shape: 'tall rail',
    surfaces: ['home', 'category'],
    sizes: { narrow: null, wide: { width: 160, height: 600 } },
    targeting: ['page', 'category', 'date'],
    label: 'Advertisement',
  },
  {
    id: 'game-page',
    placement: 'Game page, under the launcher and above the rules.',
    shape: 'medium rectangle',
    surfaces: ['game'],
    sizes: { narrow: { width: 300, height: 250 }, wide: { width: 300, height: 250 } },
    targeting: ['page', 'game', 'category', 'date'],
    label: 'Advertisement',
  },
  {
    id: 'results',
    placement: 'The game-over screen, beside "play again". Never an interstitial.',
    shape: 'medium rectangle',
    surfaces: ['results'],
    sizes: { narrow: { width: 300, height: 250 }, wide: { width: 300, height: 250 } },
    targeting: ['game', 'category', 'date'],
    label: 'Advertisement',
  },
  {
    id: 'daily-presenting',
    placement: 'Daily games: a presenting sponsor, sold per day.',
    shape: 'logo and line',
    surfaces: ['daily'],
    sizes: { narrow: { width: 320, height: 50 }, wide: { width: 468, height: 60 } },
    targeting: ['game', 'date'],
    label: 'Sponsored',
  },
];

const byId = new Map(SLOTS.map((s) => [s.id, s]));

export function slot(id: SlotId): SlotDefinition {
  const found = byId.get(id);
  if (found === undefined) throw new Error(`Unknown slot "${id}"; slots are listed in packages/ui/src/slots.ts.`);
  return found;
}

const box = (size: SlotSize | null): string =>
  size === null
    ? 'display: none;'
    : `display: grid; inline-size: min(100%, ${String(size.width)}px); aspect-ratio: ${String(size.width)} / ${String(size.height)};`;

/**
 * The CSS that gives every slot its reserved box, generated from the registry so the sizes
 * have one source. `<ad-slot>` is its own size container: a slot takes its wide box when its
 * container is at least as wide as that box, and its narrow box (or nothing) otherwise.
 */
export function slotBoxStyles(slots: readonly SlotDefinition[] = SLOTS): string {
  const narrow = slots.map((s) => `  .box[data-slot='${s.id}'] { ${box(s.sizes.narrow)} }`).join('\n');
  const wide = slots
    .filter((s) => s.sizes.wide !== null)
    .map(
      (s) =>
        `  @container (inline-size >= ${String(s.sizes.wide?.width)}px) {\n    .box[data-slot='${s.id}'] { ${box(s.sizes.wide)} }\n  }`,
    )
    .join('\n');
  return `@layer components {\n${narrow}\n${wide}\n}\n`;
}
