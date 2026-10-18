// One route table for server and client. `pageFor` turns a URL path into the page the shell
// shows; the server calls it to pick a status and to redirect, and the shell calls it on
// every navigation. `pathOf` gives each page its one canonical path.
import { isGameId } from '@joystyk/contracts';
import { routes } from '@gyral/router';

export const site = routes({
  home: '/',
  category: '/categories/:id',
  game: '/games/:id',
  licenses: '/licenses',
  advertise: '/advertise',
  advertisePolicy: '/advertise/policy',
  advertiseSent: '/advertise/thanks',
  adClick: '/ads/click/:id',
});

export type Page =
  | { readonly _tag: 'Home' }
  | { readonly _tag: 'Category'; readonly id: string }
  | { readonly _tag: 'Game'; readonly id: string }
  /** "Advertise with us": the slots, the audience, rates, the rules and the contact form. */
  | { readonly _tag: 'Licenses' }
  | { readonly _tag: 'Advertise' }
  /** The creative policy, for advertisers. */
  | { readonly _tag: 'AdvertisePolicy' }
  /** Where a sent contact form lands (Post/Redirect/Get). */
  | { readonly _tag: 'AdvertiseSent' }
  /**
   * "You're leaving Joystyk": where an ad click lands (monetization.md, "Counting"). The site's
   * ad routes count the click and render it with the creative's approved link; `id` is the
   * creative's.
   */
  | { readonly _tag: 'LeavingSite'; readonly id: string }
  | { readonly _tag: 'NotFound'; readonly path: string };

/** A creative id in a click URL: a positive integer, as the ad routes accept it. */
const CREATIVE_ID = /^[1-9]\d{0,15}$/;

const BASE = 'http://joystyk.invalid';

export function pageFor(path: string): Page {
  const match = site.match(new URL(path, BASE));
  if (match === undefined) return { _tag: 'NotFound', path };
  switch (match.name) {
    case 'home':
      return { _tag: 'Home' };
    case 'category':
      // Category ids share the game id's kebab-case shape.
      return isGameId(match.params.id) ? { _tag: 'Category', id: match.params.id } : { _tag: 'NotFound', path };
    case 'game':
      return isGameId(match.params.id) ? { _tag: 'Game', id: match.params.id } : { _tag: 'NotFound', path };
    case 'licenses':
      return { _tag: 'Licenses' };
    case 'advertise':
      return { _tag: 'Advertise' };
    case 'advertisePolicy':
      return { _tag: 'AdvertisePolicy' };
    case 'advertiseSent':
      return { _tag: 'AdvertiseSent' };
    case 'adClick':
      return CREATIVE_ID.test(match.params.id)
        ? { _tag: 'LeavingSite', id: match.params.id }
        : { _tag: 'NotFound', path };
  }
}

export const samePage = (a: Page, b: Page): boolean => {
  switch (a._tag) {
    case 'Home':
      return b._tag === 'Home';
    case 'Category':
      return b._tag === 'Category' && a.id === b.id;
    case 'Game':
      return b._tag === 'Game' && a.id === b.id;
    case 'LeavingSite':
      return b._tag === 'LeavingSite' && a.id === b.id;
    case 'Advertise':
    case 'AdvertisePolicy':
    case 'AdvertiseSent':
    case 'Licenses':
      return b._tag === a._tag;
    case 'NotFound':
      return b._tag === 'NotFound' && a.path === b.path;
  }
};

/** The one URL path for a page. The router ignores trailing slashes; the server redirects. */
export function pathOf(page: Page): string {
  switch (page._tag) {
    case 'Home':
      return site.href('home', {});
    case 'Category':
      return site.href('category', { id: page.id });
    case 'Game':
      return site.href('game', { id: page.id });
    case 'Licenses':
      return site.href('licenses', {});
    case 'Advertise':
      return site.href('advertise', {});
    case 'AdvertisePolicy':
      return site.href('advertisePolicy', {});
    case 'AdvertiseSent':
      return site.href('advertiseSent', {});
    case 'LeavingSite':
      return site.href('adClick', { id: page.id });
    case 'NotFound':
      return page.path;
  }
}

export const gamePath = (id: string): string => site.href('game', { id });
export const categoryPath = (id: string): string => site.href('category', { id });

/** The "Advertise with us" page, where the contact form posts. */
export const ADVERTISE_PATH = site.href('advertise', {});
export const ADVERTISE_POLICY_PATH = site.href('advertisePolicy', {});
/** Where the contact form's handler sends a visitor after a post. */
export const ADVERTISE_SENT_PATH = site.href('advertiseSent', {});
