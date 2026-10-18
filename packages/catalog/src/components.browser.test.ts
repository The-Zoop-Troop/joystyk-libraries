// The catalog's metadata adapter uses Gyral's shared head command in a real browser.
import { define, html, settled } from '@gyral/core';
import { setHead } from '@gyral/router';
import { expect, it } from 'vitest';
import { toGyralHead } from './head.ts';
import type { Head } from './seo.ts';

const HeadProbe = define<object, { readonly _tag: 'Set'; readonly head: Head }>()('jy-head-probe', {
  init: () => ({}),
  update: { Set: (s, m) => [s, [setHead(toGyralHead(m.head))]] },
  view: () => html``,
});

it('setHead rewrites canonical, robots, Open Graph and JSON-LD, and removes what a page lacks', async () => {
  const probe = new HeadProbe();
  document.body.append(probe);
  const game: Head = {
    title: 'Greed | Joystyk',
    description: 'Dice.',
    canonical: 'https://joystyk.test/games/greed',
    robots: 'index',
    ogType: 'article',
    jsonLd: { '@type': 'VideoGame' },
  };
  probe.send({ _tag: 'Set', head: game });
  await settled();
  const q = (selector: string) => document.head.querySelector(selector);
  expect(document.title).toBe('Greed | Joystyk');
  expect(q('link[rel="canonical"]')?.getAttribute('href')).toBe('https://joystyk.test/games/greed');
  expect(q('meta[property="og:url"]')?.getAttribute('content')).toBe('https://joystyk.test/games/greed');
  expect(q('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow');
  expect(JSON.parse(q('script[type="application/ld+json"]')?.textContent ?? '{}')).toEqual({ '@type': 'VideoGame' });

  probe.send({
    _tag: 'Set',
    head: { ...game, title: 'Page not found | Joystyk', canonical: null, robots: 'noindex', jsonLd: null },
  });
  await settled();
  expect(q('link[rel="canonical"]')).toBeNull();
  expect(q('meta[property="og:url"]')).toBeNull();
  expect(q('script[type="application/ld+json"]')).toBeNull();
  expect(q('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
  expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  probe.remove();
});
