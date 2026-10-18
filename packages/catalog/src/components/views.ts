// The page views <jy-app> renders: plain functions of the catalog state, in light DOM so
// crawlers and the document stylesheet see them. List rows are module-level and pure: they
// read only their arguments (Gyral's `each` rule).
import { each, html, nothing } from '@gyral/core';
import '@joystyk/launcher';
import type { LauncherGame } from '@joystyk/launcher';
import '@joystyk/ui/ad-slot';
import type { SlotId, SlotSurface } from '@joystyk/ui/slots';
import { MODE_LABELS, STATUS_LABELS, playersLabel, playersRange, rankLabel } from '../labels.ts';
import { ADVERTISE_PATH, categoryPath, gamePath, type Page } from '../routes.ts';
import { pageTitleOf } from '../seo.ts';
import type { CatalogState } from '../store.ts';
import type { CategoryInfo, GameDetail, GameSummary } from '../wire.ts';
import { advertiseView, policyView, sentView } from './advertise.ts';
import { leavingView } from './leaving.ts';

/** What a page is about, for the slot's contextual ad request: never who is looking. */
interface SlotContext {
  readonly page: SlotSurface;
  readonly game?: string;
  readonly category?: string;
}

/** A billboard slot; `<ad-slot>` reserves its box from the slot registry and fills it lazily. */
const adSlot = (id: SlotId, c: SlotContext) =>
  html`<ad-slot slot-id=${id} page=${c.page} game-id=${c.game} category=${c.category}></ad-slot>`;

/** What the launcher needs from a game page's data. */
export const launcherGameOf = (g: GameDetail): LauncherGame => ({
  id: g.id,
  name: g.name,
  modes: g.modes,
  players: g.players,
  aiLevels: g.aiLevels,
  status: g.status,
  aiContent: g.aiContent,
  ...(g.options === undefined ? {} : { options: g.options }),
});

// --- Shared pieces ---------------------------------------------------------------------

const Badge = (text: string) => html`<li>${text}</li>`;

const badges = (g: GameSummary) => html`<ul class="badges" aria-label="At a glance">
  <li class="badge-status" data-status=${g.status}>${STATUS_LABELS[g.status]}</li>
  <li>${playersLabel(g.players)}</li>
  ${each(
    g.modes,
    (m) => m,
    (m) => Badge(MODE_LABELS[m]),
  )}
</ul>`;

const cardBody = (g: GameSummary) => html`<p class="card-summary">${g.summary}</p>
  ${badges(g)}
  <jy-offline-availability game-id=${g.id} hidden></jy-offline-availability>`;

/** A game card under an h2 section heading. */
const CardH3 = (g: GameSummary) => html`<li>
  <article class="game-card" data-category=${g.category}>
    <h3><a href=${gamePath(g.id)}>${g.name}</a></h3>
    ${cardBody(g)}
  </article>
</li>`;

/** A game card directly under the page's h1. */
const CardH2 = (g: GameSummary) => html`<li>
  <article class="game-card" data-category=${g.category}>
    <h2><a href=${gamePath(g.id)}>${g.name}</a></h2>
    ${cardBody(g)}
  </article>
</li>`;

const grid = (games: readonly GameSummary[], card: typeof CardH3) =>
  html`<ul class="game-grid" role="list">${each(games, (g) => g.id, card)}</ul>`;

const loading = (failed: boolean, what: string) =>
  html`<p class="loading" aria-busy=${failed ? 'false' : 'true'}>
    ${failed ? `The ${what} could not load. Reload the page to try again.` : `Loading ${what}…`}
  </p>`;

interface Crumb {
  readonly name: string;
  readonly href: string;
}

const CrumbItem = (c: Crumb, current: boolean) =>
  html`<li><a href=${c.href} aria-current=${current ? 'page' : null}>${c.name}</a></li>`;

const breadcrumbs = (crumbs: readonly Crumb[]) => {
  const last = crumbs.at(-1)?.href;
  return html`<nav class="crumbs" aria-label="Breadcrumb">
    <ol>${each(
      crumbs,
      (c) => c.href,
      CrumbItem,
      (c) => c.href === last,
    )}</ol>
  </nav>`;
};

const categoryOf = (c: CatalogState, id: string): CategoryInfo | undefined => c.categories.find((k) => k.id === id);

// --- Home ------------------------------------------------------------------------------

const CategorySection = (k: CategoryInfo, games: readonly GameSummary[]) => html`<section
  class="category-section"
  data-category=${k.id}
  aria-labelledby="category-${k.id}"
>
  <header class="section-head">
    <h2 id="category-${k.id}"><a href=${categoryPath(k.id)}>${k.name}</a></h2>
    <p>${k.description}</p>
  </header>
  ${grid(games, CardH3)}
</section>`;

interface LineupRow {
  readonly rank: number;
  readonly game: GameSummary;
  readonly category: string;
}

const LineupItem = (r: LineupRow) => html`<tr>
  <td class="rank">${rankLabel(r.rank)}</td>
  <th scope="row"><a href=${gamePath(r.game.id)}>${r.game.name}</a><jy-offline-availability game-id=${r.game.id} hidden></jy-offline-availability></th>
  <td>${r.category}</td>
  <td class="num">${playersRange(r.game.players)}</td>
  <td>${STATUS_LABELS[r.game.status]}</td>
</tr>`;

const lineup = (rows: readonly LineupRow[]) => html`<section class="lineup" aria-labelledby="lineup-heading">
  <h2 id="lineup-heading">The lineup</h2>
  <div class="score-screen" role="region" aria-labelledby="lineup-caption" tabindex="0">
    <table class="score-table">
      <caption id="lineup-caption">Every game on Joystyk, high-score style</caption>
      <thead>
        <tr>
          <th scope="col">No.</th>
          <th scope="col">Game</th>
          <th scope="col">Category</th>
          <th scope="col" class="num">Players</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        ${each(rows, (r) => r.game.id, LineupItem)}
      </tbody>
    </table>
  </div>
</section>`;

const rail = (c: SlotContext) => html`<aside class="rail" aria-label="Sponsor">${adSlot('category-rail', c)}</aside>`;

const HOME: SlotContext = { page: 'home' };

function homeView(c: CatalogState) {
  const games = c.summaries;
  const featured = games?.filter((g) => g.featured) ?? [];
  const [first, ...rest] = c.categories;
  const section = (k: CategoryInfo) => CategorySection(k, games?.filter((g) => g.category === k.id) ?? []);
  return html`<div class="home">
    <section class="hero" aria-labelledby="hero-heading">
      <div class="screen">
        <p class="kicker"><span class="blink">Press start</span></p>
        <h1 id="hero-heading" tabindex="-1">Free games for your browser. No quarters needed.</h1>
        <p class="lede">
          Arcade, card and dice games that start in one click: no sign-up, no download, safe for every age. Play alone,
          against the computer, or with friends.
        </p>
        <p class="hero-actions"><a class="cta" href="#categories" aria-label="Insert coin: browse the games">Insert coin</a></p>
      </div>
    </section>
    <div class="with-rail">
      <div class="column">
        ${
          games === null
            ? loading(c.summariesLoad === 'failed', 'games')
            : html`<section class="featured" aria-labelledby="featured-heading">
                <h2 id="featured-heading">Featured</h2>
                ${grid(featured, CardH3)}
              </section>
              ${adSlot('index-hero', HOME)}
              <div id="categories" class="categories">
                ${first === undefined ? nothing : section(first)} ${rest.length > 0 ? adSlot('index-inline', HOME) : nothing}
                ${rest.map(section)}
              </div>
              ${lineup(games.map((game, n) => ({ rank: n + 1, game, category: categoryOf(c, game.category)?.name ?? game.category })))}`
        }
      </div>
      ${rail(HOME)}
    </div>
  </div>`;
}

// --- Category --------------------------------------------------------------------------

const OtherCategory = (k: CategoryInfo) =>
  html`<li><a href=${categoryPath(k.id)}>${k.name}</a> <span class="count">(${k.games})</span></li>`;

function categoryView(k: CategoryInfo, c: CatalogState) {
  const games = c.summaries?.filter((g) => g.category === k.id);
  return html`<div class="category-page" data-category=${k.id}>
    ${breadcrumbs([
      { name: 'Games', href: '/' },
      { name: k.name, href: categoryPath(k.id) },
    ])}
    <header class="page-head">
      <p class="kicker">Category</p>
      <h1 tabindex="-1">${k.name} games</h1>
      <p class="lede">${k.description}</p>
    </header>
    <div class="with-rail">
      <div class="column">
        ${games === undefined ? loading(c.summariesLoad === 'failed', 'games') : grid(games, CardH2)}
        <nav class="more" aria-labelledby="other-categories">
          <h2 id="other-categories">Other categories</h2>
          <ul>${each(
            c.categories.filter((o) => o.id !== k.id),
            (o) => o.id,
            OtherCategory,
          )}</ul>
        </nav>
      </div>
      ${rail({ page: 'category', category: k.id })}
    </div>
  </div>`;
}

// --- Game ------------------------------------------------------------------------------

/**
 * The PWA's "Make available offline" control (@joystyk/pwa defines the element in the
 * browser). Server-rendered as an empty box; it fills in once a service worker is active.
 */
const offlineToggle = (g: GameDetail) =>
  html`<jy-offline-toggle game-id=${g.id} game-name=${g.name} assets=${g.assets}></jy-offline-toggle>`;

const Rule = (rule: string) => html`<li>${rule}</li>`;

const OtherGame = (g: GameSummary) =>
  html`<li><a href=${gamePath(g.id)}>${g.name}</a>: ${g.summary} <jy-offline-availability game-id=${g.id} hidden></jy-offline-availability></li>`;

function gameView(g: GameDetail, c: CatalogState) {
  const k = categoryOf(c, g.category);
  const others = c.summaries?.filter((o) => o.id !== g.id) ?? [];
  return html`<article class="game-page" data-category=${g.category} aria-labelledby="game-title">
    ${breadcrumbs([
      { name: 'Games', href: '/' },
      ...(k === undefined ? [] : [{ name: k.name, href: categoryPath(k.id) }]),
      { name: g.name, href: gamePath(g.id) },
    ])}
    <header class="page-head">
      <p class="kicker">${k === undefined ? 'Game' : `${k.name} game`}</p>
      <h1 id="game-title" tabindex="-1">${pageTitleOf(g)}</h1>
      <p class="lede">${g.summary}</p>
      <dl class="facts">
        <div><dt>Status</dt><dd>${STATUS_LABELS[g.status]}</dd></div>
        <div><dt>Players</dt><dd>${playersLabel(g.players)}</dd></div>
        <div><dt>Modes</dt><dd>${g.modes.map((m) => MODE_LABELS[m]).join(', ')}</dd></div>
        ${g.aiLevels.length === 0 ? nothing : html`<div><dt>Computer players</dt><dd>Yes</dd></div>`}
      </dl>
    </header>
    ${g.modes.includes('daily') ? adSlot('daily-presenting', { page: 'daily', game: g.id, category: g.category }) : nothing}
    <section class="cabinet" aria-labelledby="play-heading">
      <h2 id="play-heading">Play ${g.name}</h2>
      <jy-launcher .game=${launcherGameOf(g)}></jy-launcher>
      ${g.status === 'available' ? offlineToggle(g) : nothing}
    </section>
    ${adSlot('game-page', { page: 'game', game: g.id, category: g.category })}
    <section aria-labelledby="about-heading">
      <h2 id="about-heading">About ${g.name}</h2>
      <p>${g.description}</p>
      ${g.attribution === undefined ? nothing : html`<p class="credit"><a href=${g.attribution.href} target="_blank" rel="noopener noreferrer external">${g.attribution.text}</a></p>`}
    </section>
    <section aria-labelledby="rules-heading">
      <h2 id="rules-heading">How to play ${g.name}</h2>
      ${g.placeholder ? html`<p class="note">A short summary for now. The full rules arrive with the game.</p>` : nothing}
      <ol class="rules">${each(g.rules, (r) => r, Rule)}</ol>
    </section>
    ${
      others.length === 0
        ? nothing
        : html`<nav class="more" aria-labelledby="more-heading">
          <h2 id="more-heading">More games</h2>
          <ul>${each(others, (o) => o.id, OtherGame)}</ul>
        </nav>`
    }
  </article>`;
}

// --- Not found -------------------------------------------------------------------------

const notFoundView = () => html`<section class="not-found" aria-labelledby="nf-heading">
  <p class="kicker">Game over</p>
  <h1 id="nf-heading" tabindex="-1">Page not found</h1>
  <p class="lede">There is no page at this address. It may have moved, or the link may have a typo.</p>
  <p class="continue">Continue? <a href="/">See all games</a></p>
</section>`;

// --- The page --------------------------------------------------------------------------

/** True when the page's content (and so its h1) is on screen, rather than a loading line. */
export function isReady(page: Page, c: CatalogState): boolean {
  switch (page._tag) {
    case 'Home':
      return c.summaries !== null;
    case 'Category':
      return c.summaries !== null || !c.categories.some((k) => k.id === page.id);
    case 'Game':
      return page.id in c.games || c.missing.includes(page.id);
    case 'Advertise':
    case 'Licenses':
    case 'AdvertisePolicy':
    case 'AdvertiseSent':
    case 'LeavingSite':
    case 'NotFound':
      return true;
  }
}

export function mainView(page: Page, c: CatalogState) {
  switch (page._tag) {
    case 'Home':
      return homeView(c);
    case 'NotFound':
      return notFoundView();
    case 'Licenses':
      return html`<article class="policy" aria-labelledby="licenses-title"><h1 id="licenses-title" tabindex="-1">Source licenses and credits</h1><section><h2>Map data</h2><p>Made with Natural Earth. Map Guess uses Natural Earth vector data v5.1.2, with source checksums and a mechanical combination of default, ISO and national border views. The data is in the public domain.</p><p><a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener noreferrer">Natural Earth terms of use</a> · <a href="https://www.naturalearthdata.com/about/disputed-boundaries-policy/" target="_blank" rel="noopener noreferrer">Disputed boundaries policy</a></p></section><section><h2>Word lists</h2><p>Several games use derived SCOWL 2020.12.07 word lists. Copyright 2000–2018 Kevin Atkinson, with portions copyright by the source contributors. SCOWL combines word-list sources under permissive licenses; the full copyright notices are retained with each derived list in our repository.</p><p><a href="https://github.com/en-wl/wordlist/blob/5ef55f9/scowl/Copyright" target="_blank" rel="noopener noreferrer">SCOWL license notices</a></p></section><section><h2>Fonts</h2><p>Letter Drop and Shift 23 use Zilla Slab, copyright 2017 The Mozilla Foundation, under the SIL Open Font License 1.1. The bundled font and full license are retained with each game.</p><p><a href="https://github.com/mozilla/zilla-slab" target="_blank" rel="noopener noreferrer">Zilla Slab source and license</a></p></section><section><h2>All-ages word filters</h2><p>The curated filters draw on the English LDNOOBW list, copyright Shutterstock, Inc. and the LDNOOBW contributors, under Creative Commons Attribution 4.0 International. Our filters select entries, add inflected forms and stems, and include local additions.</p><p><a href="https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words" target="_blank" rel="noopener noreferrer">Source list</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></p></section></article>`;
    case 'Advertise':
      return advertiseView(c);
    case 'AdvertisePolicy':
      return policyView();
    case 'AdvertiseSent':
      return sentView();
    case 'LeavingSite':
      return c.leaving?.id === page.id ? leavingView(c.leaving) : notFoundView();
    case 'Category': {
      const k = categoryOf(c, page.id);
      return k === undefined ? notFoundView() : categoryView(k, c);
    }
    case 'Game': {
      const g = c.games[page.id];
      if (g !== undefined) return gameView(g, c);
      if (c.missing.includes(page.id)) return notFoundView();
      return loading(c.gameLoads[page.id] === 'failed', 'game');
    }
  }
}

const NavItem = (k: CategoryInfo, current: boolean) =>
  html`<li><a href=${categoryPath(k.id)} aria-current=${current ? 'page' : null}>${k.name}</a></li>`;

export const masthead = (page: Page, c: CatalogState) => html`<a class="skip-link" href="#main">Skip to content</a>
  <header class="masthead">
    <a class="brand" href="/">
      <svg class="logo" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect x="4" y="22" width="24" height="6" rx="1.5" class="logo-base" />
        <rect x="14.5" y="8" width="3" height="15" class="logo-stick" />
        <circle cx="16" cy="8" r="5" class="logo-ball" />
        <circle cx="24" cy="24.5" r="1.6" class="logo-button" />
      </svg>
      <span class="wordmark">Joystyk</span>
    </a>
    <nav class="main-nav" aria-label="Main">
      <ul>
        <li><a href="/" aria-current=${page._tag === 'Home' ? 'page' : null}>All games</a></li>
        ${each(
          c.categories,
          (k) => k.id,
          NavItem,
          (k) => page._tag === 'Category' && page.id === k.id,
        )}
      </ul>
    </nav>
  </header>`;

export const footer = () => html`<footer class="site-footer">
  <p><span class="wordmark small">Joystyk</span> Free games for every age. No sign-up, no download.</p>
  <nav class="footer-nav" aria-label="Footer">
    <ul>
      <li><a href=${ADVERTISE_PATH}>Advertise with us</a></li><li><a href="/licenses">Source licenses</a></li>
    </ul>
  </nav>
  <p><small>Game listings marked “Coming soon” are previews while the platform is built.</small></p>
</footer>`;
