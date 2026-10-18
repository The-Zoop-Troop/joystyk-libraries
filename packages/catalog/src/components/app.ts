// <jy-app>: the page shell. Light DOM (`shadow: false`), so crawlers and the document
// stylesheet see the content. It owns the page, so its router captures same-origin link
// clicks. The server renders it with `path`; in the browser `listen` reports the same URL
// first (ignored), then every navigation. After a navigation it loads what the new page
// needs, updates the head, and moves focus to the new page's h1 so keyboard and screen
// reader users land on the content.
import { changed, define, focus, html, prop, send, type Command } from '@gyral/core';
import { listen, setHead, type RouteLocation } from '@gyral/router';
import { toGyralHead } from '../head.ts';
import { pageFor, samePage, type Page } from '../routes.ts';
import { headFor } from '../seo.ts';
import { catalog, type CatalogState } from '../store.ts';
import { footer, isReady, mainView, masthead } from './views.ts';

const props = { path: prop.string({ required: true }) };

export interface AppState {
  readonly page: Page;
  /** A navigation happened and its content isn't on screen yet: focus the h1 when it is. */
  readonly focusPending: boolean;
  /** True once hydrated; exposed to CSS and tests as `jy-app:state(live)`. */
  readonly live: boolean;
}

export type AppMsg = { readonly _tag: 'Routed'; readonly location: RouteLocation };

/** Commands that make sure the catalog holds what `page` shows. */
export function loadFor(page: Page, c: CatalogState): Command<AppMsg>[] {
  if ((page._tag === 'Home' || page._tag === 'Category') && c.summaries === null)
    return [send(catalog, { _tag: 'LoadSummaries' })];
  if (page._tag === 'Game') {
    const commands: Command<AppMsg>[] = [];
    if (!(page.id in c.games)) commands.push(send(catalog, { _tag: 'LoadGame', id: page.id }));
    // The game page's "More games" list reads the summaries.
    if (c.summaries === null) commands.push(send(catalog, { _tag: 'LoadSummaries' }));
    return commands;
  }
  return [];
}

const focusHeading = () => focus('main h1');

export const App = define<AppState, AppMsg, { readonly path: string }>()('jy-app', {
  shadow: false,
  props,
  stores: [catalog],
  init: (p) => ({ page: pageFor(p.path), focusPending: false, live: false }),
  subscriptions: () => [listen((location): AppMsg => ({ _tag: 'Routed', location }))],
  states: (s) => ({ live: s.live }),
  intent: {},
  update: {
    Routed: (s, m, { read }) => {
      const page = pageFor(m.location.pathname);
      if (samePage(page, s.page)) return s; // listen's first report: the URL the server rendered
      const c = read(catalog);
      const ready = isReady(page, c);
      return [
        { ...s, page, focusPending: !ready },
        [...loadFor(page, c), setHead(toGyralHead(headFor(page, c))), ...(ready ? [focusHeading()] : [])],
      ];
    },
    Hydrated: (s) => ({ ...s, live: true }),
    // Data for the current page arrived: refresh the head, and focus the h1 once it exists.
    StoreChanged: (s, m) => {
      const c = changed(catalog, m);
      if (c === undefined) return s;
      const ready = s.focusPending && isReady(s.page, c.state);
      return [
        { ...s, focusPending: s.focusPending && !ready },
        [setHead(toGyralHead(headFor(s.page, c.state))), ...(ready ? [focusHeading()] : [])],
      ];
    },
  },
  view: (s, _i, { read }) => {
    const c = read(catalog);
    return html`${masthead(s.page, c)}
      <main id="main" tabindex="-1">${mainView(s.page, c)}</main>
      ${footer()}`;
  },
});

declare global {
  interface HTMLElementTagNameMap {
    'jy-app': InstanceType<typeof App>;
  }
}
