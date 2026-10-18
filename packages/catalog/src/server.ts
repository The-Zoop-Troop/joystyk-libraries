// The catalog's request-time renderer. It resolves the URL to a page, redirects
// non-canonical paths, loads exactly the data that page shows into a fresh store instance,
// picks the status from that data, and renders the document with @gyral/ssr. It does no
// I/O: the app passes in the registry, the built asset URLs and the stylesheet text.
import { html, type ChildValue } from '@gyral/core';
import { renderPage, type CspOptions } from '@gyral/ssr';
import './components/app.ts';
import type { ContactFormState } from './advertise.ts';
import { toGyralHead } from './head.ts';
import type { Registry } from './registry.ts';
import { pageFor, site, type Page } from './routes.ts';
import { headFor } from './seo.ts';
import { catalog, emptyCatalog, type CatalogState, type Leaving } from './store.ts';

export interface CatalogRendererOptions {
  /** Public origin for canonical URLs and JSON-LD, e.g. https://joystyk.com. */
  readonly origin: string;
  readonly registry: Registry;
  /** The built client entry's URL (`/assets/client-<hash>.js`), or the source path in dev. */
  readonly clientEntry: string;
  /** Chunks to preload with the entry, including Gyral's hydration chunk. */
  readonly modulepreload?: readonly string[];
  /** Document CSS, in cascade order: the ui tokens, then the catalog stylesheet. */
  readonly styles: readonly string[];
  /** Hashed CSS URLs from the client manifest, in cascade order. */
  readonly css?: readonly string[];
  /** Extra head markup every page gets (favicon, theme colour). */
  readonly head?: ChildValue;
}

/** Headers on every HTML response. HTML always revalidates (offline-and-updates.md, Rule 1). */
export const HTML_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

export type { Leaving } from './store.ts';

export const CSP: CspOptions = {
  directives: {
    'default-src': "'self'",
    'script-src': "'self'",
    'connect-src': "'self'",
    'img-src': "'self' data:",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'self'",
    'frame-ancestors': "'none'",
  },
};

/** A rejected contact form post, re-rendered on the advertise page with this status. */
export interface ContactRender {
  readonly form: ContactFormState;
  readonly status: number;
}

const copyForm = (form: ContactFormState): CatalogState['contactForm'] => ({
  values: Object.fromEntries(Object.entries(form.values).map(([k, v]) => [k, typeof v === 'string' ? v : [...v]])),
  errors: Object.fromEntries(Object.entries(form.errors).map(([k, v]) => [k, [...v]])),
});

/** What the site passes for the pages that show server-only data. */
export interface PageData {
  /** The advertise page after a rejected post. */
  readonly contact?: ContactRender;
  /** The "You're leaving Joystyk" page: an approved creative's destination. */
  readonly leaving?: Leaving;
}

/** What `page` renders, loaded before rendering (the render is synchronous), and its status. */
export function seedFor(
  page: Page,
  registry: Registry,
  origin: string,
  data: PageData = {},
): { readonly state: CatalogState; readonly status: number } {
  const { contact, leaving } = data;
  const empty = emptyCatalog(origin, registry.categories());
  const summaries = [...registry.summaries()];
  switch (page._tag) {
    case 'Home':
      return { state: { ...empty, summaries }, status: 200 };
    case 'Category':
      return registry.categories().some((k) => k.id === page.id)
        ? { state: { ...empty, summaries }, status: 200 }
        : { state: empty, status: 404 };
    case 'Game': {
      const game = registry.detail(page.id);
      return game === undefined
        ? { state: { ...empty, missing: [page.id] }, status: 404 }
        : { state: { ...empty, summaries, games: { [game.id]: game } }, status: 200 };
    }
    case 'Advertise':
      return contact === undefined
        ? { state: empty, status: 200 }
        : { state: { ...empty, contactForm: copyForm(contact.form) }, status: contact.status };
    case 'Licenses':
    case 'AdvertisePolicy':
    case 'AdvertiseSent':
      return { state: empty, status: 200 };
    // Only with a destination for this creative from the ad routes; without one, not found.
    case 'LeavingSite':
      return leaving?.id === page.id
        ? { state: { ...empty, leaving: { ...leaving } }, status: 200 }
        : { state: empty, status: 404 };
    case 'NotFound':
      return { state: empty, status: 404 };
  }
}

/**
 * Renders the page at a URL. `data.contact` re-renders the advertise page after a rejected
 * post, with the visitor's values and the errors; the site's contact handler passes it.
 * `data.leaving` renders an ad click's "You're leaving Joystyk" page; the ad routes pass it.
 */
export type CatalogRenderer = (url: URL, data?: PageData) => Response;

export function createCatalogRenderer(options: CatalogRendererOptions): CatalogRenderer {
  const { styles } = options;
  return (url, data = {}) => {
    const page = pageFor(url.pathname);
    // One URL per page: /games/x/ answers 301 to /games/x, keeping the query.
    const canonicalPath = page._tag === 'NotFound' ? url.pathname : (site.match(url)?.path ?? url.pathname);
    if (canonicalPath !== url.pathname) {
      return new Response(null, {
        status: 301,
        headers: { location: `${canonicalPath}${url.search}`, 'cache-control': 'no-cache' },
      });
    }
    const seed = seedFor(page, options.registry, options.origin, data);
    const head = headFor(page, seed.state);
    return renderPage(
      {
        ...toGyralHead(head),
        lang: 'en',
        styles,
        stylesheets: options.css ?? [],
        extraHead: options.head,
        stores: [catalog.instance(seed.state)],
        body: html`<jy-app path=${url.pathname}></jy-app>`,
        scripts: [options.clientEntry],
        modulepreload: options.modulepreload ?? [],
        csp: CSP,
      },
      { status: seed.status, headers: HTML_HEADERS },
    );
  };
}
