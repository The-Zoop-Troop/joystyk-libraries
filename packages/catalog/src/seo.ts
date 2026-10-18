// Head metadata as a pure function of the page and the catalog state. The server writes it
// into the document head; after client navigation the shell sends the same value to the head
// model through Gyral's shared head API, so both sinks read one source.
import type { JsonValue } from '@gyral/core';
import type { Mode } from '@joystyk/contracts';
import { playersLabel } from './labels.ts';
import { ADVERTISE_PATH, ADVERTISE_POLICY_PATH, categoryPath, gamePath, type Page } from './routes.ts';
import type { CatalogState } from './store.ts';
import type { CategoryInfo, GameDetail } from './wire.ts';

export const SITE_NAME = 'Joystyk';

export type JsonLd = Readonly<Record<string, JsonValue>>;

export interface Head {
  readonly title: string;
  readonly description: string;
  /** Absolute canonical URL, or null for pages that must not be indexed. */
  readonly canonical: string | null;
  readonly robots: 'index' | 'noindex';
  /** Open Graph type: the index is a website; everything else an article-like page. */
  readonly ogType: 'website' | 'article';
  readonly jsonLd: JsonLd | null;
}

const SINGLE: readonly Mode[] = ['solo', 'ai', 'daily'];
const MULTI: readonly Mode[] = ['pass-and-play', 'p2p', 'server'];

/** schema.org playMode values for a game's modes. */
export function playModes(modes: readonly Mode[]): readonly string[] {
  const out: string[] = [];
  if (modes.some((m) => SINGLE.includes(m))) out.push('SinglePlayer');
  if (modes.some((m) => MULTI.includes(m))) out.push('MultiPlayer');
  return out;
}

/**
 * What a game page calls the game in its title, heading and structured data: the manifest's
 * `pageTitle` ("Klondike Solitaire") when it has one, else the display name. Links, cards
 * and breadcrumbs keep the display name.
 */
export const pageTitleOf = (game: Pick<GameDetail, 'name' | 'pageTitle'>): string => game.pageTitle ?? game.name;

const crumb = (position: number, name: string, item: string) => ({ '@type': 'ListItem', position, name, item });

export function gameJsonLd(game: GameDetail, category: CategoryInfo | undefined, origin: string): JsonLd {
  const url = `${origin}${gamePath(game.id)}`;
  const crumbs = [crumb(1, 'Games', `${origin}/`)];
  if (category !== undefined) crumbs.push(crumb(2, category.name, `${origin}${categoryPath(category.id)}`));
  crumbs.push(crumb(crumbs.length + 1, game.name, url));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'VideoGame',
        '@id': `${url}#game`,
        name: pageTitleOf(game),
        ...(pageTitleOf(game) === game.name ? {} : { alternateName: game.name }),
        description: game.description,
        url,
        ...(category === undefined ? {} : { genre: category.name }),
        keywords: game.tags.join(', '),
        gamePlatform: 'Web browser',
        applicationCategory: 'Game',
        operatingSystem: 'Any',
        playMode: playModes(game.modes),
        numberOfPlayers: { '@type': 'QuantitativeValue', minValue: game.players.min, maxValue: game.players.max },
        isAccessibleForFree: true,
        publisher: { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
      },
      { '@type': 'BreadcrumbList', itemListElement: crumbs },
    ],
  };
}

export function categoryJsonLd(category: CategoryInfo, origin: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      crumb(1, 'Games', `${origin}/`),
      crumb(2, category.name, `${origin}${categoryPath(category.id)}`),
    ],
  };
}

export const NOT_FOUND_HEAD: Head = {
  title: `Page not found | ${SITE_NAME}`,
  description: 'There is no page at this address.',
  canonical: null,
  robots: 'noindex',
  ogType: 'article',
  jsonLd: null,
};

const loadingHead: Head = { ...NOT_FOUND_HEAD, title: `Loading… | ${SITE_NAME}`, description: '' };

const findCategory = (c: CatalogState, id: string): CategoryInfo | undefined => c.categories.find((k) => k.id === id);

/** A game page's description: the summary, then the facts a searcher wants. */
export const gameDescription = (g: GameDetail): string =>
  `${g.summary} Free in your browser, ${playersLabel(g.players)}.`;

export function headFor(page: Page, c: CatalogState): Head {
  switch (page._tag) {
    case 'Home':
      return {
        title: `${SITE_NAME}: free arcade, card and dice games in your browser`,
        description:
          'Free arcade, card and dice games for every age. Play in your browser with no sign-up and no download: alone, against the computer, or with friends.',
        canonical: `${c.origin}/`,
        robots: 'index',
        ogType: 'website',
        jsonLd: { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: `${c.origin}/` },
      };
    case 'Category': {
      const category = findCategory(c, page.id);
      if (category === undefined) return NOT_FOUND_HEAD;
      return {
        title: `${category.name} games: play free in your browser | ${SITE_NAME}`,
        description: category.description,
        canonical: `${c.origin}${categoryPath(category.id)}`,
        robots: 'index',
        ogType: 'article',
        jsonLd: categoryJsonLd(category, c.origin),
      };
    }
    case 'Game': {
      const game = c.games[page.id];
      if (game === undefined) return c.missing.includes(page.id) ? NOT_FOUND_HEAD : loadingHead;
      const category = findCategory(c, game.category);
      return {
        title: `${pageTitleOf(game)}: free online ${category?.noun ?? 'game'} | ${SITE_NAME}`,
        description: gameDescription(game),
        canonical: `${c.origin}${gamePath(game.id)}`,
        robots: 'index',
        ogType: 'article',
        jsonLd: gameJsonLd(game, category, c.origin),
      };
    }
    case 'Licenses':
      return {
        title: `Source licenses and credits | ${SITE_NAME}`,
        description: 'Credits and source-license notices for Joystyk’s map and word data.',
        canonical: `${c.origin}/licenses`,
        robots: 'index',
        ogType: 'article',
        jsonLd: null,
      };
    case 'Advertise':
      return {
        title: `Advertise with us: ad slots, audience and rules | ${SITE_NAME}`,
        description:
          'Put your brand beside free games played by every age. See the ad slots on Joystyk and their sizes, who sees them and the rules every ad meets, then send us a message.',
        canonical: `${c.origin}${ADVERTISE_PATH}`,
        robots: 'index',
        ogType: 'article',
        jsonLd: null,
      };
    case 'AdvertisePolicy':
      return {
        title: `Creative policy for advertisers | ${SITE_NAME}`,
        description:
          'The rules every ad on Joystyk meets before it runs: products we never advertise, honest claims, clear labels, safe landing pages and the image specs for each slot.',
        canonical: `${c.origin}${ADVERTISE_POLICY_PATH}`,
        robots: 'index',
        ogType: 'article',
        jsonLd: null,
      };
    case 'AdvertiseSent':
      return {
        ...NOT_FOUND_HEAD,
        title: `Message sent | ${SITE_NAME}`,
        description: 'Thanks for getting in touch about advertising on Joystyk.',
      };
    // A step between an ad and the advertiser's site: never indexed.
    case 'LeavingSite':
      return c.leaving?.id === page.id
        ? {
            ...NOT_FOUND_HEAD,
            title: `You’re leaving ${SITE_NAME}`,
            description: `This ad goes to ${c.leaving.domain}, a website ${SITE_NAME} doesn’t run.`,
          }
        : NOT_FOUND_HEAD;
    case 'NotFound':
      return NOT_FOUND_HEAD;
  }
}
