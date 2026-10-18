// <ad-slot>: the one billboard component (docs/design-docs/monetization.md). It reserves its
// slot's exact box from the slot registry, labels it as advertising and, once the box comes
// near the viewport, asks the site's ad endpoint what to show: a booked creative (an image
// and a headline, linked through the first-party click notice), a house promotion, or
// nothing. Whatever arrives fills the reserved box, so nothing shifts. Games never render it;
// it belongs to the frame (D-07), and nothing it shows ever enters a game's canvas.
//
// The request carries the page's context only (ad-wire.ts): the slot, the kind of page and
// the game or category it is about. No cookies (`credentials: 'omit'`), no user or device id.
//
// Collapse rules, in `slotPresentation`:
// - the entitlement source says "hide" (ad-free, v2): the slot collapses;
// - the browser is offline: the slot collapses. Until the connectivity driver first reports,
//   the slot assumes it is online and keeps the box the server rendered; on a page the
//   service worker served offline (`data-offline` on <html>), tokens.css hides it instead
//   until it hears it is online (its `online` state), so nothing shifts at first paint;
// - the endpoint said "collapse", failed, or sent something that doesn't parse, or the
//   creative's image failed to load: the slot collapses;
// - otherwise it keeps its reserved box; at a width where the registry has no box (the rail
//   on narrow screens) CSS hides it.
//
// Impressions: a creative counts once, when its image has loaded and at least half of it is
// on screen; the slot then sends one beacon (monetization.md, "Counting"). House promotions
// aren't counted.
//
// The entitlement source, the connectivity signal, the ad request and the beacon are drivers,
// substituted by name: `provideAdEntitlement(element, source)` above the slots, `el.drivers`
// or `provideDrivers` in tests.
import {
  command,
  css,
  define,
  defineHook,
  defineDriver,
  html,
  nothing,
  prop,
  provideDrivers,
  subscription,
  type Command,
  type Next,
  type PropsOf,
} from '@gyral/core';
import {
  adQueryUrl,
  defaultSurface,
  isContextId,
  parseAdFill,
  SLOT_SURFACES,
  type AdFill,
  type AdQuery,
  type CreativeFill,
  type HouseFill,
} from './ad-wire.ts';
import { isSlotId, slot, slotBoxStyles, type SlotId, type SlotSurface } from './slots.ts';

/** Whether the visitor sees ads. 'hide' arrives with ad-free entitlements in v2. */
export type AdEntitlement = 'show' | 'hide';

/** Where `<ad-slot>` learns whether to show ads. */
export interface AdEntitlementSource {
  get(): AdEntitlement;
  /** Calls `listener` on every change; returns how to stop. */
  subscribe(listener: (entitlement: AdEntitlement) => void): () => void;
}

/** The v1 source: every visitor sees ads, so it never changes. */
export const alwaysShowAds: AdEntitlementSource = {
  get: () => 'show',
  subscribe: () => () => {},
};

const watchEntitlement = (source: AdEntitlementSource) =>
  subscription<AdEntitlement>('ad-entitlement', (emit) => {
    emit(source.get());
    return source.subscribe(emit);
  });

/** The default entitlement driver: `alwaysShowAds`. */
export const adEntitlement = watchEntitlement(alwaysShowAds);

/** Gives every `<ad-slot>` below `element` its entitlement from `source`. */
export const provideAdEntitlement = (element: Element, source: AdEntitlementSource): (() => void) =>
  provideDrivers(element, { 'ad-entitlement': watchEntitlement(source) });

/** `navigator.onLine` now and on every `online` / `offline` event. */
export const connectivity = subscription<boolean>('connectivity', (emit) => {
  const report = (): void => emit(navigator.onLine);
  report();
  addEventListener('online', report);
  addEventListener('offline', report);
  return () => {
    removeEventListener('online', report);
    removeEventListener('offline', report);
  };
});

/**
 * Asks the ad endpoint for a slot's fill and parses the answer at the boundary. No cookies go
 * with it. Fails on a network error, a non-2xx status or an answer that doesn't parse.
 */
export const adServer = defineDriver<string, AdFill, string>({
  name: 'ad-server',
  run: async (url, { signal }) => {
    const response = await fetch(url, { signal, credentials: 'omit', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`ad endpoint answered ${String(response.status)}`);
    const fill = parseAdFill(await response.json());
    if (fill === null) throw new Error('ad endpoint answer did not parse');
    return fill;
  },
  toError: (cause) => (cause instanceof Error ? cause.message : String(cause)),
});

/** Sends an impression beacon: a bodiless POST that outlives the page, without cookies. */
export const adBeacon = defineDriver<string, void, string>({
  name: 'ad-beacon',
  run: async (url) => {
    await fetch(url, { method: 'POST', keepalive: true, credentials: 'omit' });
  },
  toError: (cause) => (cause instanceof Error ? cause.message : String(cause)),
});

/** Where the slot's fill stands. */
export type AdLoad =
  /** Not near the viewport yet: nothing asked. */
  | { readonly _tag: 'Waiting' }
  | { readonly _tag: 'Loading'; readonly url: string }
  | { readonly _tag: 'Filled'; readonly url: string; readonly fill: CreativeFill | HouseFill; readonly seen: boolean }
  /** Nothing to show, or something failed: the slot collapses. */
  | { readonly _tag: 'Empty'; readonly url: string };

export interface AdSlotState {
  readonly entitlement: AdEntitlement;
  /** What the connectivity driver last said; null until it first reports (assumed online). */
  readonly online: boolean | null;
  /** The box has come near the viewport once. */
  readonly near: boolean;
  readonly ad: AdLoad;
}

export type AdSlotMsg =
  | { readonly _tag: 'Entitled'; readonly entitlement: AdEntitlement }
  | { readonly _tag: 'Connectivity'; readonly online: boolean }
  /** The box came within a screen's reach of the viewport. */
  | { readonly _tag: 'Near' }
  | { readonly _tag: 'Loaded'; readonly url: string; readonly fill: AdFill }
  | { readonly _tag: 'LoadFailed'; readonly url: string }
  /** The creative's image loaded and is at least half on screen, or it failed to load. */
  | { readonly _tag: 'Image'; readonly status: 'seen' | 'broken' };

/** What the slot shows: its reserved box (empty or filled), or nothing at all. Pure. */
export const slotPresentation = (s: AdSlotState): 'reserved' | 'collapsed' =>
  s.entitlement === 'hide' || s.online === false || s.ad._tag === 'Empty' ? 'collapsed' : 'reserved';

/** A Standard Schema from a type guard, so an invalid attribute is reported, not guessed at. */
const guard = <T extends string>(is: (value: unknown) => value is T, message: string) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'joystyk',
    validate: (value: unknown): { readonly value: T } | { readonly issues: readonly { readonly message: string }[] } =>
      is(value) ? { value } : { issues: [{ message }] },
  },
});

const isSurface = (value: unknown): value is SlotSurface => (SLOT_SURFACES as readonly unknown[]).includes(value);

const props = {
  /** The registry id (attribute `slot-id`; `slot` is taken by the platform). */
  slotId: prop.string({
    required: true,
    schema: guard<SlotId>(isSlotId, 'Expected a slot id from packages/ui/src/slots.ts.'),
  }),
  /** The kind of page the slot is on (attribute `page`). Default: the slot's first surface. */
  page: prop.string({ schema: guard(isSurface, `Expected one of ${SLOT_SURFACES.join(', ')}.`) }),
  /** The game the page or screen is about (attribute `game-id`). */
  gameId: prop.string({ schema: guard(isContextId, 'Expected a kebab-case game id.') }),
  /** The category the page is about (attribute `category`). */
  category: prop.string({ schema: guard(isContextId, 'Expected a kebab-case category id.') }),
};
export type AdSlotProps = PropsOf<typeof props>;

/** The context the slot sends: what the page is about, never who is looking. */
export const queryOf = (p: AdSlotProps): AdQuery => ({
  slot: p.slotId,
  page: p.page ?? defaultSurface(p.slotId),
  game: p.gameId ?? null,
  category: p.category ?? null,
});

const watchAds = (): Command<AdSlotMsg> =>
  command(adEntitlement, undefined, { onSuccess: (entitlement): AdSlotMsg => ({ _tag: 'Entitled', entitlement }) });
const watchConnectivity = (): Command<AdSlotMsg> =>
  command(connectivity, undefined, { onSuccess: (online): AdSlotMsg => ({ _tag: 'Connectivity', online }) });

/** Asks the endpoint for `url`'s fill; the latest request wins. */
export const requestFill = (url: string): Command<AdSlotMsg> =>
  command(adServer, url, {
    onSuccess: (fill): AdSlotMsg => ({ _tag: 'Loaded', url, fill }),
    onFailure: (): AdSlotMsg => ({ _tag: 'LoadFailed', url }),
    key: 'ad-server',
    concurrency: 'switch',
  });

/** Reports an impression. Nothing comes back: a lost beacon is a lost count, never an error shown. */
const sendBeacon = (url: string): Command<AdSlotMsg> =>
  command<string, void, string, AdSlotMsg>(adBeacon, url, { onFailure: () => undefined });

/** Starts the request once the box is near, ads are shown and the browser is online. */
const load = (s: AdSlotState, p: AdSlotProps): Next<AdSlotState, AdSlotMsg> => {
  if (!s.near || s.ad._tag !== 'Waiting' || s.entitlement === 'hide' || s.online === false) return s;
  const url = adQueryUrl(queryOf(p));
  return [{ ...s, ad: { _tag: 'Loading', url } }, [requestFill(url)]];
};

const urlOf = (ad: AdLoad): string | null => (ad._tag === 'Waiting' ? null : ad.url);

const NEAR_EVENT = 'jy-ad-near';
const IMAGE_EVENT = 'jy-ad-image';

const observers = new WeakMap<Element, () => void>();

/**
 * Tells the slot, once, when its box comes within 300 px of the viewport: the lazy load.
 * Dispatches `jy-ad-near` on the box.
 */
const nearViewport = defineHook<[]>({
  client: (el, _args, prev) => {
    if (prev !== undefined) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        el.dispatchEvent(new CustomEvent(NEAR_EVENT, { bubbles: true }));
      },
      { rootMargin: '300px' },
    );
    observer.observe(el);
    observers.set(el, () => observer.disconnect());
  },
  dispose: (el) => {
    observers.get(el)?.();
    observers.delete(el);
  },
});

/**
 * Reports a creative's image: `seen` once it has loaded and at least half of it is on
 * screen, `broken` if it fails to load. Dispatches `jy-ad-image` with the status as detail.
 */
const reportImage = defineHook<[src: string]>({
  client: (el, [src], prev) => {
    if (prev?.[0] === src) return;
    observers.get(el)?.();
    if (!(el instanceof HTMLImageElement)) return;
    let visible = false;
    let done = false;
    const report = (status: 'seen' | 'broken'): void => {
      if (done) return;
      done = true;
      stop();
      el.dispatchEvent(new CustomEvent(IMAGE_EVENT, { bubbles: true, detail: status }));
    };
    const check = (): void => {
      if (el.complete && el.naturalWidth > 0 && visible) report('seen');
    };
    const onError = (): void => report('broken');
    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        check();
      },
      { threshold: 0.5 },
    );
    const stop = (): void => {
      observer.disconnect();
      el.removeEventListener('load', check);
      el.removeEventListener('error', onError);
    };
    el.addEventListener('load', check);
    el.addEventListener('error', onError);
    observer.observe(el);
    observers.set(el, stop);
    if (el.complete && el.naturalWidth === 0 && el.getAttribute('src') !== '') {
      // Already failed before the listener was attached.
      queueMicrotask(() => {
        if (el.complete && el.naturalWidth === 0) onError();
      });
    }
  },
  dispose: (el) => {
    observers.get(el)?.();
    observers.delete(el);
  },
});

const styles = css`
  @layer components {
    :host {
      display: block;
      container-type: inline-size;
    }
    :host(:state(collapsed)) {
      display: none;
    }
    .box {
      box-sizing: border-box;
      min-block-size: 0;
      /* The same grid empty or filled: the label never moves when a fill arrives (no layout shift). */
      grid-template-rows: auto minmax(0, 1fr);
      gap: var(--jy-space-3xs, 0.25rem);
      margin-inline: auto;
      padding: var(--jy-space-2xs, 0.5rem);
      border: 1px dashed color-mix(in oklch, var(--jy-text, CanvasText) 30%, transparent);
      border-radius: var(--jy-radius-s, 0.5rem);
      background: repeating-linear-gradient(
        135deg,
        transparent 0 10px,
        color-mix(in oklch, var(--jy-text, CanvasText) 4%, transparent) 10px 20px
      );
      color: var(--jy-text-muted, GrayText);
      font-size: 0.8rem;
      text-align: center;
      overflow: clip;
      contain: layout paint;
    }
    .box.filled {
      border-style: solid;
      background: var(--jy-surface-raised, Canvas);
    }
    p {
      margin: 0;
    }
    /* The label reads before anything else in the slot, as the ASA's 2022 rulings ask: bold
       12 px capitals on a solid chip in the page's text colour (over 14:1 contrast in both
       schemes), unlike the slot's surface and outside the creative (advertising-policy.md, 5). */
    .label {
      justify-self: start;
      padding-inline: 0.5em;
      border-radius: 0.25rem;
      background: var(--jy-text, CanvasText);
      color: var(--jy-surface-raised, Canvas);
      font-family: var(--jy-font-mono, ui-monospace, monospace);
      font-size: 0.75rem;
      font-weight: 700;
      line-height: 1.4;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: start;
    }
    .fill {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: var(--jy-space-3xs, 0.25rem);
      min-block-size: 0;
      color: var(--jy-text, CanvasText);
      text-decoration: none;
      border-radius: var(--jy-radius-s, 0.5rem);
    }
    .fill:focus-visible {
      outline: 2px solid var(--jy-focus-ring, Highlight);
      outline-offset: 2px;
    }
    .fill:hover .headline,
    .fill:hover .cta {
      text-decoration: underline;
    }
    img {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      min-block-size: 0;
      object-fit: contain;
    }
    .headline {
      font-weight: 600;
      line-height: 1.25;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }
    .house {
      grid-template-rows: auto auto auto;
      align-content: center;
      justify-items: center;
    }
    .house .text {
      color: var(--jy-text-muted, GrayText);
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 5;
      line-clamp: 5;
      overflow: hidden;
    }
    .house .cta {
      color: var(--jy-accent, LinkText);
      font-weight: 600;
    }
    /* Short boxes (banners, the presenting line): image and words side by side. */
    .box[data-flow='row'] {
      padding-block: var(--jy-space-3xs, 0.25rem);
      gap: 0;
    }
    .box.filled[data-flow='row'] .fill {
      grid-template-rows: minmax(0, 1fr);
      grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
      align-items: center;
      text-align: start;
    }
    .box.filled[data-flow='row'] .house {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
      justify-items: start;
    }
    .box.filled[data-flow='row'] .house .text {
      grid-column: 1;
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
    .box.filled[data-flow='row'] .house .cta {
      grid-column: 2;
      grid-row: 1 / span 2;
    }
    .box.filled[data-flow='row'] .headline {
      -webkit-line-clamp: 1;
      line-clamp: 1;
    }
    @media (forced-colors: active) {
      .box {
        border-color: CanvasText;
      }
      .label {
        border: 1px solid CanvasText;
      }
    }
  }
`;

/** Banners and the presenting line are short: their fill lays out in a row. */
const flowOf = (slotId: SlotId): 'row' | 'column' => {
  const shape = slot(slotId).shape;
  return shape === 'medium rectangle' || shape === 'tall rail' ? 'column' : 'row';
};

// `sponsored` for search engines; `external` keeps the catalog's router from handling the click
// itself: the browser asks the server, which counts it and answers with "You're leaving Joystyk".
const creativeView = (f: CreativeFill, intent: string) => html`<a
  class="fill creative"
  href=${f.href}
  rel="sponsored noopener external"
  data-intent=${intent}
  data-intent-on="jy-ad-image"
>
  <img src=${f.image.src} alt=${f.alt} width=${f.image.width} height=${f.image.height} decoding="async" ${reportImage(f.image.src)} />
  <span class="headline">${f.headline}</span>
</a>`;

const houseView = (f: HouseFill) => html`<a class="fill house" href=${f.href}>
  <span class="headline">${f.headline}</span>
  <span class="text">${f.text}</span>
  <span class="cta">${f.cta}</span>
</a>`;

export const AdSlot = define<AdSlotState, AdSlotMsg, AdSlotProps>()('ad-slot', {
  props,
  init: () => ({ entitlement: 'show', online: null, near: false, ad: { _tag: 'Waiting' } }),
  subscriptions: () => [watchAds(), watchConnectivity()],
  // `online` only once the browser says so: tokens.css keeps a slot on a page served offline
  // hidden without it.
  states: (s) => ({ collapsed: slotPresentation(s) === 'collapsed', online: s.online === true }),
  intent: {
    Near: () => ({ _tag: 'Near' }),
    Image: ({ event }) => {
      const status = event instanceof CustomEvent ? (event.detail as unknown) : undefined;
      return status === 'seen' || status === 'broken' ? { _tag: 'Image', status } : undefined;
    },
  },
  update: {
    Entitled: (s, m, { props: p }) => load({ ...s, entitlement: m.entitlement }, p),
    Connectivity: (s, m, { props: p }) => load({ ...s, online: m.online }, p),
    Near: (s, _m, { props: p }) => load({ ...s, near: true }, p),
    Loaded: (s, m) =>
      urlOf(s.ad) !== m.url || s.ad._tag !== 'Loading'
        ? s
        : {
            ...s,
            ad:
              m.fill.kind === 'collapse'
                ? { _tag: 'Empty', url: m.url }
                : { _tag: 'Filled', url: m.url, fill: m.fill, seen: false },
          },
    LoadFailed: (s, m) =>
      urlOf(s.ad) !== m.url || s.ad._tag !== 'Loading' ? s : { ...s, ad: { _tag: 'Empty', url: m.url } },
    Image: (s, m) => {
      if (s.ad._tag !== 'Filled' || s.ad.fill.kind !== 'creative') return s;
      if (m.status === 'broken') return { ...s, ad: { _tag: 'Empty', url: s.ad.url } };
      return s.ad.seen ? s : [{ ...s, ad: { ...s.ad, seen: true } }, [sendBeacon(s.ad.fill.beacon)]];
    },
    // Client navigation can reuse the element for another game or category: ask again.
    PropsChanged: (s, { props: p }) => {
      const url = adQueryUrl(queryOf(p));
      return urlOf(s.ad) === url ? s : load({ ...s, ad: { _tag: 'Waiting' } }, p);
    },
  },
  view: (s, i, { props: p }) => {
    if (slotPresentation(s) === 'collapsed') return nothing;
    const fill = s.ad._tag === 'Filled' ? s.ad.fill : null;
    return html`<div
      class=${fill === null ? 'box' : 'box filled'}
      data-slot=${p.slotId}
      data-flow=${flowOf(p.slotId)}
      part="box"
      data-intent=${i.Near}
      data-intent-on="jy-ad-near"
      ${nearViewport()}
    >
      <p class="label">${slot(p.slotId).label}</p>
      ${fill === null ? nothing : fill.kind === 'creative' ? creativeView(fill, i.Image) : houseView(fill)}
    </div>`;
  },
  styles: [styles, slotBoxStyles()],
});

declare global {
  interface HTMLElementTagNameMap {
    'ad-slot': InstanceType<typeof AdSlot>;
  }
}
