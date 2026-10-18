// The manifest registry: every game the site lists, as static data. A game registers its
// GameManifest (plain JSON, so the index renders without loading game code) together with
// the listing copy its pages show. The registry checks the whole set once, at startup, and
// answers the grouping questions the pages ask. It is server-side data: pages receive what
// they show through the store seed and /api/games.
import { isGameId, isGameOptions, type GameManifest } from '@joystyk/contracts';
import { CATEGORIES, type CategoryDefinition } from './categories.ts';
import { GameDetailSchema, type CategoryInfo, type GameDetail, type GameStatus, type GameSummary } from './wire.ts';

/** What a game's pages say about it, beyond the manifest. */
export interface Listing {
  readonly status: GameStatus;
  /**
   * True for an entry written before its game exists. Placeholders keep the real id, name and
   * category, so URLs stay stable when the game's own `entry.ts` replaces the entry.
   */
  readonly placeholder: boolean;
  /** Shown in the index's Featured section. */
  readonly featured: boolean;
  /** One or two paragraphs for the game page. */
  readonly description: string;
  /** A short rules summary, one step per item. The full rules ship with the game. */
  readonly rules: readonly string[];
}

export interface CatalogEntry {
  readonly manifest: GameManifest;
  readonly listing: Listing;
}

/** Returns the entry unchanged; a typed spot for a game to declare its catalog entry. */
export const defineEntry = <const E extends CatalogEntry>(entry: E): E => entry;

export interface Registry {
  /** Every entry, sorted by name. */
  readonly entries: readonly CatalogEntry[];
  readonly find: (id: string) => CatalogEntry | undefined;
  readonly summaries: () => readonly GameSummary[];
  readonly summary: (id: string) => GameSummary | undefined;
  readonly detail: (id: string) => GameDetail | undefined;
  readonly featured: () => readonly GameSummary[];
  /** Categories with at least one game, in the order CATEGORIES lists them. */
  readonly categories: () => readonly CategoryInfo[];
  readonly inCategory: (categoryId: string) => readonly GameSummary[];
  /** Game ids per tag, tags sorted alphabetically. */
  readonly tags: () => ReadonlyMap<string, readonly string[]>;
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

/** Every problem with one entry, as sentences that name the fix. */
function problems(
  entry: CatalogEntry,
  known: (id: string) => CategoryDefinition | undefined,
  categories: readonly CategoryDefinition[],
): string[] {
  const { manifest: m, listing } = entry;
  const found: string[] = [];
  if (!isGameId(m.id)) found.push(`id "${m.id}" must be kebab-case, e.g. "shift-23".`);
  if (m.name.trim() === '') found.push('name is empty.');
  if (m.pageTitle !== undefined && !m.pageTitle.includes(m.name)) {
    found.push(
      `pageTitle "${m.pageTitle}" must contain the name "${m.name}", so the page heading matches the cards that link to it; leave it out to use the name.`,
    );
  }
  if (m.summary.trim() === '') found.push('summary is empty; it is the card text and meta description.');
  if (known(m.category) === undefined) {
    found.push(
      `category "${m.category}" is not in CATEGORIES (packages/catalog/src/categories.ts); add it there or use one of ${categories.map((c) => c.id).join(', ')}.`,
    );
  }
  if (m.modes.length === 0) found.push('modes is empty; list at least one way to play.');
  if (!Number.isInteger(m.players.min) || m.players.min < 1 || m.players.max < m.players.min) {
    found.push(
      `players { min: ${String(m.players.min)}, max: ${String(m.players.max)} } must be whole numbers with 1 <= min <= max.`,
    );
  }
  const preset = m.players.default;
  if (preset !== undefined && (!Number.isInteger(preset) || preset < m.players.min || preset > m.players.max)) {
    found.push(
      `players.default ${String(preset)} must be a whole number from min (${String(m.players.min)}) to max (${String(m.players.max)}), or left out.`,
    );
  }
  if (m.options !== undefined && !isGameOptions(m.options))
    found.push('options must have unique keys, valid choices and matching defaults.');
  if (m.attribution !== undefined && !GameDetailSchema.shape.attribution.safeParse(m.attribution).success)
    found.push('attribution needs nonempty text (up to 500 characters) and an HTTPS link without credentials.');
  if (listing.description.trim() === '') found.push('listing.description is empty.');
  if (listing.rules.length === 0) found.push('listing.rules is empty; give at least a one-line rules summary.');
  return found.map((p) => `${m.id}: ${p}`);
}

const toSummary = ({ manifest: m, listing: l }: CatalogEntry): GameSummary => ({
  id: m.id,
  name: m.name,
  summary: m.summary,
  category: m.category,
  tags: [...m.tags],
  modes: [...m.modes],
  players:
    m.players.default === undefined
      ? { min: m.players.min, max: m.players.max }
      : { min: m.players.min, max: m.players.max, default: m.players.default },
  status: l.status,
  placeholder: l.placeholder,
  featured: l.featured,
});

const toDetail = (entry: CatalogEntry): GameDetail => ({
  ...toSummary(entry),
  description: entry.listing.description,
  ...(entry.manifest.pageTitle === undefined ? {} : { pageTitle: entry.manifest.pageTitle }),
  rules: [...entry.listing.rules],
  aiLevels: entry.manifest.ai === null ? [] : [...entry.manifest.ai.levels],
  essentialMotion: entry.manifest.essentialMotion,
  aiContent: entry.manifest.aiContent === true,
  assets: entry.manifest.assets,
  ...(entry.manifest.options === undefined ? {} : { options: [...entry.manifest.options] }),
  ...(entry.manifest.attribution === undefined ? {} : { attribution: entry.manifest.attribution }),
});

/**
 * Builds the registry, or throws a RegistryError listing every invalid entry and duplicate
 * id. Call it once at startup so a bad manifest stops the deploy, not a page view.
 */
export function createRegistry(
  entries: readonly CatalogEntry[],
  categories: readonly CategoryDefinition[] = CATEGORIES,
): Registry {
  const known = (id: string) => categories.find((c) => c.id === id);
  const found = entries.flatMap((e) => problems(e, known, categories));
  const seen = new Set<string>();
  for (const { manifest } of entries) {
    if (seen.has(manifest.id))
      found.push(`${manifest.id}: two entries share this id; ids are unique and stable forever.`);
    seen.add(manifest.id);
  }
  if (found.length > 0) throw new RegistryError(`Invalid catalog entries:\n- ${found.join('\n- ')}`);

  const sorted = [...entries].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, 'en'));
  const byId = new Map(sorted.map((e) => [e.manifest.id, e]));
  const summaries = sorted.map(toSummary);
  const summaryById = new Map(summaries.map((s) => [s.id, s]));
  const details = new Map(sorted.map((e) => [e.manifest.id, toDetail(e)]));
  const infos: readonly CategoryInfo[] = categories.flatMap((c) => {
    const games = summaries.filter((s) => s.category === c.id).length;
    return games === 0 ? [] : [{ id: c.id, name: c.name, noun: c.noun, description: c.description, games }];
  });
  const tags = new Map<string, string[]>();
  for (const s of summaries) {
    for (const tag of s.tags) tags.set(tag, [...(tags.get(tag) ?? []), s.id]);
  }
  const sortedTags: ReadonlyMap<string, readonly string[]> = new Map(
    [...tags].sort(([a], [b]) => a.localeCompare(b, 'en')),
  );

  return {
    entries: sorted,
    find: (id) => byId.get(id),
    summaries: () => summaries,
    summary: (id) => summaryById.get(id),
    detail: (id) => details.get(id),
    featured: () => summaries.filter((s) => s.featured),
    categories: () => infos,
    inCategory: (categoryId) => summaries.filter((s) => s.category === categoryId),
    tags: () => sortedTags,
  };
}
