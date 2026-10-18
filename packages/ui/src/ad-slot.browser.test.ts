// <ad-slot> in real Chromium: the reserved box per slot and width, the label, the lazy
// request, the filled box keeping its size, the impression beacon, the collapse rules and
// axe. The ad endpoint and the beacon are substituted drivers, except in the test of the
// real request, which stubs `fetch`.
import { settled, subscription } from '@gyral/core';
import { fakeDriver } from '@gyral/testing';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';
import './tokens.css';
import { AdSlot, provideAdEntitlement, type AdEntitlement } from './ad-slot.ts';
import type { AdFill, CreativeFill } from './ad-wire.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-offline');
});

type Slot = InstanceType<typeof AdSlot>;
const WAIT = { timeout: 45_000 }; // Observer delivery shares a busy browser; fail on the condition, not a one-second deadline.

/** Fakes for the endpoint and the beacon; requests wait until the test answers them. */
const fakes = () => ({
  server: fakeDriver<string, AdFill, string>('ad-server'),
  beacon: fakeDriver<string, void, string>('ad-beacon', { impl: () => undefined }),
});

/** Mounts `<ad-slot>` inside a container of the given width. */
const mount = async (
  slotId: string,
  width: number,
  setup?: (el: Slot, container: HTMLElement) => void,
  drivers: ReturnType<typeof fakes> = fakes(),
) => {
  // Inside a landmark, as on every page that renders a slot.
  const main = document.createElement('main');
  const container = document.createElement('div');
  container.style.inlineSize = `${String(width)}px`;
  main.append(container);
  document.body.append(main);
  const el = new AdSlot();
  el.setAttribute('slot-id', slotId);
  el.drivers = { 'ad-server': drivers.server, 'ad-beacon': drivers.beacon };
  setup?.(el, container);
  container.append(el);
  await settled();
  return el;
};

const boxOf = (el: Element) => el.shadowRoot?.querySelector('.box')?.getBoundingClientRect() ?? null;

/** A small PNG drawn on a canvas, as a data URL (the fakes skip the wire's same-site check). */
const png = (width: number, height: number): string => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('no 2d context');
  g.fillStyle = '#7aa6d8';
  g.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png');
};

const creative = (src: string, width = 300, height = 200): CreativeFill => ({
  kind: 'creative',
  id: 4,
  image: { src, width, height },
  alt: 'A pale blue rectangle',
  headline: 'A sample sponsor with a deliberately long headline that has to be clamped to fit the box',
  href: '/ads/click/4?slot=results',
  beacon: '/api/ads/impression?creative=4&slot=results',
});

const axeViolations = async (root: Element): Promise<string[]> => {
  const results = await axe.run(root, {
    runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
  });
  return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
};

it('reserves the medium rectangle and labels it as advertising', async () => {
  const el = await mount('results', 800);
  expect(boxOf(el)).toMatchObject({ width: 300, height: 250 });
  expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('Advertisement');
  expect(el.getBoundingClientRect().height).toBe(250);
});

/** A CSS colour as sRGB bytes, by painting it: computed styles may keep oklch(). */
const rgbOf = (color: string): readonly [number, number, number] => {
  const g = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (g === null) throw new Error('no 2d context');
  g.fillStyle = color;
  g.fillRect(0, 0, 1, 1);
  const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
  return [r, gr, b];
};

/** WCAG 2 contrast ratio between two colours. */
const contrast = (a: string, b: string): number => {
  const luminance = (rgb: readonly number[]) => {
    const [r = 0, g = 0, bl = 0] = rgb.map((v) =>
      v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(rgbOf(a)), luminance(rgbOf(b))].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

// The ASA's 2022 rulings found small labels in colours like the ad's too weak
// (advertising-policy.md, section 5): the label is a solid, high-contrast chip of readable size.
it.each([
  ['results', 800, 'light'],
  ['daily-presenting', 360, 'light'],
  ['index-hero', 1000, 'dark'],
] as const)('makes the label prominent in %s at %ipx, %s scheme', async (slotId, width, scheme) => {
  document.documentElement.style.colorScheme = scheme;
  try {
    const el = await mount(slotId, width);
    const label = el.shadowRoot?.querySelector('.label');
    const box = el.shadowRoot?.querySelector('.box');
    if (!(label instanceof HTMLElement) || !(box instanceof HTMLElement)) throw new Error('no label');
    const style = getComputedStyle(label);
    expect(Number.parseFloat(style.fontSize)).toBeGreaterThanOrEqual(12);
    expect(Number(style.fontWeight)).toBeGreaterThanOrEqual(700);
    expect(contrast(style.color, style.backgroundColor)).toBeGreaterThanOrEqual(7);
    // Its chip stands apart from the slot's own surface, so it doesn't blend into the box.
    expect(contrast(style.backgroundColor, getComputedStyle(document.body).backgroundColor)).toBeGreaterThanOrEqual(7);
    // A chip, not a full-width band, at the top of the box.
    expect(label.getBoundingClientRect().width).toBeLessThan(box.getBoundingClientRect().width / 2);
    expect(label.getBoundingClientRect().top - box.getBoundingClientRect().top).toBeLessThanOrEqual(12);
  } finally {
    document.documentElement.style.colorScheme = '';
  }
});

it('takes the wide banner when its space fits it, and the narrow one otherwise', async () => {
  expect(boxOf(await mount('index-hero', 1000))).toMatchObject({ width: 728, height: 90 });
  expect(boxOf(await mount('index-hero', 360))).toMatchObject({ width: 320, height: 100 });
});

it('hides the rail where the registry gives it no narrow box', async () => {
  const narrow = await mount('category-rail', 120);
  expect(narrow.getBoundingClientRect().height).toBe(0);
  const wide = await mount('category-rail', 160);
  expect(boxOf(wide)).toMatchObject({ width: 160, height: 600 });
});

it('labels the daily sponsorship as sponsored', async () => {
  const el = await mount('daily-presenting', 500);
  expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('Sponsored');
});

it('asks only once it comes near the viewport, with the page context in the URL', async () => {
  const drivers = fakes();
  const el = await mount(
    'game-page',
    800,
    (slotEl, container) => {
      slotEl.setAttribute('page', 'game');
      slotEl.setAttribute('game-id', 'nim');
      const spacer = document.createElement('div');
      spacer.style.blockSize = '4000px';
      container.append(spacer);
    },
    drivers,
  );
  // An observer reports its first sighting within a frame or two of observing.
  for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
  await settled();
  expect(drivers.server.inputs).toEqual([]);
  el.scrollIntoView();
  await vi.waitFor(() => {
    expect(drivers.server.inputs).toEqual(['/api/ads/slot?slot=game-page&page=game&game=nim']);
  }, WAIT);
});

it('fills the reserved box with a creative without changing its size, and sends one beacon once seen', async () => {
  const drivers = fakes();
  const el = await mount('results', 800, undefined, drivers);
  const before = boxOf(el);
  await vi.waitFor(() => {
    expect(drivers.server.inputs).toHaveLength(1);
  }, WAIT);
  drivers.server.resolveNext(creative(png(300, 200)));
  await settled();
  const link = el.shadowRoot?.querySelector<HTMLAnchorElement>('a.creative');
  expect(link?.getAttribute('href')).toBe('/ads/click/4?slot=results');
  expect(link?.rel).toBe('sponsored noopener external');
  expect(el.shadowRoot?.querySelector('.label')?.textContent).toBe('Advertisement');
  expect(el.shadowRoot?.querySelector('img')?.alt).toBe('A pale blue rectangle');
  await vi.waitFor(() => {
    expect(drivers.beacon.inputs).toEqual(['/api/ads/impression?creative=4&slot=results']);
  }, WAIT);
  expect(boxOf(el)?.toJSON()).toEqual(before?.toJSON());
  expect(el.getBoundingClientRect().height).toBe(250);
  await settled();
  expect(drivers.beacon.inputs).toHaveLength(1);
  expect(await axeViolations(document.body)).toEqual([]);
});

it('keeps a banner’s box when filled, in both widths', async () => {
  for (const [width, box] of [
    [1000, { width: 728, height: 90 }],
    [360, { width: 320, height: 100 }],
  ] as const) {
    const drivers = fakes();
    const el = await mount('index-hero', width, undefined, drivers);
    await vi.waitFor(() => {
      expect(drivers.server.inputs).toHaveLength(1);
    }, WAIT);
    drivers.server.resolveNext(creative(png(728, 90), 728, 90));
    await settled();
    expect(el.shadowRoot?.querySelector('img')).not.toBeNull();
    expect(boxOf(el)).toMatchObject(box);
  }
});

it('shows a house promotion with no beacon, and passes axe', async () => {
  const drivers = fakes();
  const el = await mount('game-page', 800, undefined, drivers);
  await vi.waitFor(() => {
    expect(drivers.server.inputs).toHaveLength(1);
  }, WAIT);
  drivers.server.resolveNext({
    kind: 'house',
    headline: 'Advertise with us',
    text: 'Family-friendly billboards, booked directly with our team.',
    cta: 'Find out how',
    href: '/advertise',
  });
  await settled();
  const link = el.shadowRoot?.querySelector<HTMLAnchorElement>('a.house');
  expect(link?.getAttribute('href')).toBe('/advertise');
  expect(link?.textContent).toContain('Advertise with us');
  expect(boxOf(el)).toMatchObject({ width: 300, height: 250 });
  expect(drivers.beacon.inputs).toEqual([]);
  expect(await axeViolations(document.body)).toEqual([]);
});

it('collapses when nothing is booked, when the request fails, and when the image breaks', async () => {
  const told = fakes();
  const empty = await mount('results', 800, undefined, told);
  await vi.waitFor(() => {
    expect(told.server.inputs).toHaveLength(1);
  }, WAIT);
  told.server.resolveNext({ kind: 'collapse' });
  await settled();
  expect(empty.matches(':state(collapsed)')).toBe(true);
  expect(empty.getBoundingClientRect().height).toBe(0);

  const failing = fakes();
  const failed = await mount('results', 800, undefined, failing);
  await vi.waitFor(() => {
    expect(failing.server.inputs).toHaveLength(1);
  }, WAIT);
  failing.server.rejectNext('offline');
  await settled();
  expect(failed.matches(':state(collapsed)')).toBe(true);

  const breaking = fakes();
  const broken = await mount('results', 800, undefined, breaking);
  await vi.waitFor(() => {
    expect(breaking.server.inputs).toHaveLength(1);
  }, WAIT);
  breaking.server.resolveNext(creative('/no-such-creative.png'));
  await vi.waitFor(() => {
    expect(broken.matches(':state(collapsed)')).toBe(true);
  }, WAIT);
  expect(breaking.beacon.inputs).toEqual([]);
});

it('parses the real answer at the boundary and collapses on one that doesn’t fit', async () => {
  const fetches: string[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    fetches.push(`${url} ${init?.credentials ?? ''}`);
    return Promise.resolve(
      new Response(JSON.stringify({ kind: 'creative', id: 1, href: 'https://elsewhere.example/' }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  const container = document.createElement('div');
  document.body.append(container);
  const el = new AdSlot();
  el.setAttribute('slot-id', 'results');
  el.setAttribute('game-id', 'nim');
  container.append(el);
  await vi.waitFor(() => {
    expect(el.matches(':state(collapsed)')).toBe(true);
  }, WAIT);
  expect(fetches).toEqual(['/api/ads/slot?slot=results&page=results&game=nim omit']);
});

it('collapses when the entitlement source says to hide ads, and returns when it changes back', async () => {
  let current: AdEntitlement = 'hide';
  const listeners = new Set<(e: AdEntitlement) => void>();
  const drivers = fakes();
  const el = await mount(
    'game-page',
    800,
    (_el, container) => {
      provideAdEntitlement(container, {
        get: () => current,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      });
    },
    drivers,
  );
  expect(el.matches(':state(collapsed)')).toBe(true);
  expect(el.getBoundingClientRect().height).toBe(0);
  expect(el.shadowRoot?.querySelector('.box')).toBeNull();
  current = 'show';
  for (const listener of listeners) listener(current);
  await settled();
  expect(el.matches(':state(collapsed)')).toBe(false);
  expect(boxOf(el)).toMatchObject({ width: 300, height: 250 });
});

it('collapses while offline', async () => {
  let report: (online: boolean) => void = () => {};
  const drivers = fakes();
  const el = await mount(
    'results',
    800,
    (slotEl) => {
      slotEl.drivers = {
        'ad-server': drivers.server,
        'ad-beacon': drivers.beacon,
        connectivity: subscription<boolean>('connectivity', (emit) => {
          report = emit;
          emit(true);
          return () => {};
        }),
      };
    },
    drivers,
  );
  expect(el.matches(':state(collapsed)')).toBe(false);
  report(false);
  await settled();
  expect(el.matches(':state(collapsed)')).toBe(true);
  report(true);
  await settled();
  expect(el.matches(':state(collapsed)')).toBe(false);
});

it('takes no space on a page served offline until it hears it is online', async () => {
  // The service worker marks a page it answers from its cache (@joystyk/pwa, offline-mark.ts).
  document.documentElement.setAttribute('data-offline', '');
  let report: (online: boolean) => void = () => {};
  const drivers = fakes();
  const connectivity = subscription<boolean>('connectivity', (emit) => {
    report = emit;
    return () => {};
  });
  const el = await mount(
    'results',
    800,
    (slotEl) => {
      slotEl.drivers = { 'ad-server': drivers.server, 'ad-beacon': drivers.beacon, connectivity };
    },
    drivers,
  );
  // Not heard yet: tokens.css hides it, as it hides the server's markup at first paint.
  expect(el.matches(':state(online)')).toBe(false);
  expect(el.getBoundingClientRect().height).toBe(0);
  report(false);
  await settled();
  expect(el.matches(':state(collapsed)')).toBe(true);
  expect(el.getBoundingClientRect().height).toBe(0);
  // The connection returns: the box is reserved again.
  report(true);
  await settled();
  expect(el.matches(':state(online)')).toBe(true);
  expect(boxOf(el)).toMatchObject({ width: 300, height: 250 });
  expect(el.getBoundingClientRect().height).toBe(250);
});

it('keeps its box before the first connectivity report on a page from the network', async () => {
  const drivers = fakes();
  const silent = subscription<boolean>('connectivity', () => () => {});
  const el = await mount(
    'results',
    800,
    (slotEl) => {
      slotEl.drivers = { 'ad-server': drivers.server, 'ad-beacon': drivers.beacon, connectivity: silent };
    },
    drivers,
  );
  expect(el.matches(':state(online)')).toBe(false);
  expect(el.getBoundingClientRect().height).toBe(250);
});
