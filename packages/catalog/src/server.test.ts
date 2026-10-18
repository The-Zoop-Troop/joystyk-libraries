// The request-time renderer, called directly: status, redirects, headers and the markup
// crawlers see, with no server and no browser.
import { describe, expect, it } from 'vitest';
import { SLOTS } from '@joystyk/ui/slots';
import {
  ADVERTISE_EMAIL,
  CONTACT_HANDLED_RETENTION_DAYS,
  CONTACT_RETENTION_MONTHS,
  MEDIA_RATINGS,
  PROHIBITED,
  REFUND_RULES,
  REPLY_BUSINESS_DAYS,
} from './advertise.ts';
import { TEST_ENTRIES } from './fixtures.test-util.ts';
import { createRegistry } from './registry.ts';
import { pageFor } from './routes.ts';
import { createCatalogRenderer, seedFor } from './server.ts';

const ORIGIN = 'https://joystyk.test';
const registry = createRegistry(TEST_ENTRIES);
const render = createCatalogRenderer({
  origin: ORIGIN,
  registry,
  clientEntry: '/assets/entry-client-abc12345.js',
  styles: [':root { color: red; }'],
});
const get = (path: string) => render(new URL(path, ORIGIN));
/** The markup without the renderer's hydration comments, for matching text across interpolations. */
const plain = (html: string): string => html.replace(/<!--[^>]*-->/g, '');

describe('createCatalogRenderer', () => {
  it('renders the index with a 200, revalidating HTML and a CSP that hashes the styles', async () => {
    const response = get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toMatch(/style-src[^;]*'sha256-/);
    const html = await response.text();
    expect(html).toContain('<link rel="canonical" href="https://joystyk.test/"');
    expect(html).toContain('<script type="module" src="/assets/entry-client-abc12345.js"');
    expect(html).toContain('<ad-slot slot-id="index-hero"');
  });

  it('renders a game page with its title, Open Graph tags, JSON-LD and the launcher', async () => {
    const html = await get('/games/test-dice').text();
    expect(html).toContain('<title>Test Dice: free online dice game | Joystyk</title>');
    expect(html).toContain('<meta property="og:url" content="https://joystyk.test/games/test-dice"');
    expect(html).toContain('"@type":"VideoGame"');
    expect(html).toMatch(/<jy-launcher[^>]*><template shadowrootmode="open">/);
    // Without JavaScript the launcher shows a disabled Start button and says why.
    expect(html).toMatch(/<button type="submit" class="start primary" aria-label="Start Test Dice"[^>]* disabled/);
    expect(html).toContain('JavaScript is needed to play.');
    expect(html).toMatch(/<ad-slot slot-id="game-page"[^>]*><template shadowrootmode="open">/);
    expect(html).toContain('data-slot="game-page"');
  });

  it('names a game by its page title in the title, Open Graph and heading, and by its name everywhere else', async () => {
    const html = await get('/games/test-cards').text();
    expect(html).toContain('<title>Test Cards Showdown: free online card game | Joystyk</title>');
    expect(html).toContain('<meta property="og:title" content="Test Cards Showdown: free online card game | Joystyk"');
    expect(html).toContain('"name":"Test Cards Showdown","alternateName":"Test Cards"');
    expect(html).toMatch(/<h1 id="game-title"[^>]*>Test Cards Showdown<\/h1>/);
    expect(html).toMatch(/<h2 id="play-heading"[^>]*>Play Test Cards<\/h2>/);
    expect(html).toMatch(/<a[^>]* aria-current="page"[^>]*>Test Cards<\/a>/);
    expect(html).toMatch(/aria-label="Start Test Cards"/);
    // The cards that link to it keep the display name.
    const index = await get('/').text();
    expect(index).toContain('>Test Cards</a>');
    expect(index).not.toContain('Showdown');
  });

  it('answers 404 with noindex for unknown pages, games and empty categories', async () => {
    for (const path of ['/nope', '/games/nope', '/games/Bad_Id', '/categories/board']) {
      const response = get(path);
      expect(response.status, path).toBe(404);
      const html = await response.text();
      expect(html, path).toContain('<meta name="robots" content="noindex"');
      expect(html, path).not.toContain('rel="canonical"');
    }
  });

  it('redirects a trailing slash to the canonical path with a 301, keeping the query', () => {
    const response = get('/games/test-dice/?ref=feed');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/games/test-dice?ref=feed');
  });
});

describe('the advertise pages', () => {
  it('renders Advertise with us: indexable, with the slot gallery, rates, rules and a form that posts without JavaScript', async () => {
    const response = get('/advertise');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>Advertise with us: ad slots, audience and rules | Joystyk</title>');
    expect(html).toContain('<link rel="canonical" href="https://joystyk.test/advertise"');
    expect(html).toContain('<meta name="robots" content="index, follow"');
    expect(html).toContain('<meta name="description" content="Put your brand beside free games');
    expect(html).toMatch(/<h1[^>]*>Advertise with us<\/h1>/);
    // One card per slot in the registry, with its sizes.
    for (const s of SLOTS) expect(html).toContain(`id="slot-${s.id}"`);
    expect(html).toContain('728 × 90 px');
    expect(html).toContain('Contact us for rates.');
    expect(html).toContain('href="/advertise/policy"');
    // The form: a plain POST back here, every field labelled, the honeypot hidden by CSS.
    expect(html).toMatch(/<form class="contact-form" method="post"[^>]* action="\/advertise"/);
    for (const id of [
      'contact-name',
      'contact-company',
      'contact-email',
      'contact-start',
      'contact-end',
      'contact-message',
      'contact-website',
    ]) {
      expect(html).toContain(`<label for="${id}"`);
    }
    expect(html.match(/<input type="checkbox" name="slots"/g)).toHaveLength(SLOTS.length);
    expect(html).toContain('<div class="trap">');
    expect(plain(html)).toContain(
      `We delete each message ${String(CONTACT_HANDLED_RETENTION_DAYS)} days after we've dealt with it`,
    );
    expect(plain(html)).toContain(`always within ${String(CONTACT_RETENTION_MONTHS)} months of its arrival`);
    expect(plain(html)).toContain("if you're under 18, please don't use it.");
    // The address as selectable text, and as a mailto: link.
    expect(plain(html)).toContain(`<a href="mailto:${ADVERTISE_EMAIL}">${ADVERTISE_EMAIL}</a>`);
    expect(plain(html)).toContain(`within ${String(REPLY_BUSINESS_DAYS)} business days`);
    expect(plain(html)).toContain("We don't publish traffic figures yet.");
    expect(plain(html)).toContain(`only when rated ${MEDIA_RATINGS}`);
    expect(html).not.toContain('form-errors');
    // Every page links here from the footer.
    expect(html).toMatch(/<nav class="footer-nav" aria-label="Footer">[\s\S]*href="\/advertise"/);
  });

  it('re-renders the form after a rejected post with the values, the errors and the given status', async () => {
    const response = render(new URL('/advertise', ORIGIN), {
      contact: {
        form: {
          values: { name: 'Ada', email: 'nope', slots: ['results'], message: 'Hi <there>' },
          errors: { email: ['Enter an email address.'], '': ['Try later.'] },
        },
        status: 422,
      },
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('<a href="#contact-email">Enter an email address.</a>');
    expect(html).toContain('<li>Try later.</li>');
    expect(html).toContain('value="Ada"');
    expect(html).toContain('Hi &lt;there&gt;</textarea>');
    expect(html).toMatch(/value="results"[^>]* checked/);
    expect(html).toMatch(/id="contact-email"[^>]*aria-describedby="contact-email-error"/);
  });

  it('ignores form state on any other page', async () => {
    const response = render(new URL('/advertise/policy', ORIGIN), {
      contact: { form: { values: {}, errors: {} }, status: 422 },
    });
    expect(response.status).toBe(200);
  });

  it('renders the creative policy with every prohibited category and the spec table from the registry', async () => {
    const html = await get('/advertise/policy').text();
    expect(html).toContain('<title>Creative policy for advertisers | Joystyk</title>');
    expect(html).toContain('<link rel="canonical" href="https://joystyk.test/advertise/policy"');
    for (const p of PROHIBITED) expect(html).toContain(`<dt>${p.name}</dt>`);
    expect(plain(html)).toContain(`rated above ${MEDIA_RATINGS}`);
    expect(html).not.toContain('PEGI 7');
    expect(plain(html)).toContain(">If an ad doesn't run</h2>");
    expect(plain(html)).toContain(REFUND_RULES[1]);
    expect(html.match(/<th scope="row">/g)).toHaveLength(SLOTS.length);
  });

  it('renders the thank-you page, kept out of search results', async () => {
    const response = get('/advertise/thanks');
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<h1[^>]*>Thanks for getting in touch<\/h1>/);
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toContain('rel="canonical"');
    expect(plain(html)).toContain(`we'll reply by email within ${String(REPLY_BUSINESS_DAYS)} business days.`);
    expect(plain(html)).toContain(`<a href="mailto:${ADVERTISE_EMAIL}">${ADVERTISE_EMAIL}</a>`);
  });

  it('renders "You’re leaving Joystyk" for an ad click, in the site frame and kept out of search results', async () => {
    const leaving = {
      id: '7',
      href: 'https://www.example.com/kites?x=1&y=2',
      domain: 'example.com',
      back: '/games/test-dice',
    };
    const response = render(new URL('/ads/click/7?slot=results', ORIGIN), { leaving });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toContain('<title>You’re leaving Joystyk</title>');
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toContain('rel="canonical"');
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(plain(html)).toMatch(/<h1[^>]*>You’re leaving Joystyk<\/h1>/);
    expect(plain(html)).toContain(
      'The ad you chose goes to <strong class="leaving-domain">example.com</strong>, a website Joystyk doesn’t run.',
    );
    expect(html).toContain(
      '<a class="cta" rel="sponsored noopener" href="https://www.example.com/kites?x=1&amp;y=2">Continue to example.com</a>',
    );
    expect(plain(html)).toContain('<a class="back" href="/games/test-dice">Back to Joystyk</a>');
    // The frame: masthead, main landmark and footer, as on every page.
    expect(html).toContain('<header class="masthead">');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<footer class="site-footer">');
  });

  it('answers 404 at a click URL without a destination for that creative', async () => {
    expect(get('/ads/click/7').status).toBe(404);
    const other = render(new URL('/ads/click/8', ORIGIN), {
      leaving: { id: '7', href: 'https://example.com/', domain: 'example.com', back: '/' },
    });
    expect(other.status).toBe(404);
    expect(await other.text()).not.toContain('example.com');
    expect(get('/ads/click/0').status).toBe(404);
  });
});

describe('seedFor', () => {
  it('seeds exactly what each page shows', () => {
    expect(seedFor(pageFor('/'), registry, ORIGIN).state.games).toEqual({});
    const game = seedFor(pageFor('/games/test-dice'), registry, ORIGIN).state;
    expect(Object.keys(game.games)).toEqual(['test-dice']);
    expect(game.summaries).toHaveLength(2);
    const missing = seedFor(pageFor('/games/gone'), registry, ORIGIN);
    expect(missing).toMatchObject({ status: 404, state: { missing: ['gone'], summaries: null } });
    expect(seedFor(pageFor('/nope'), registry, ORIGIN).state.categories).toHaveLength(2);
  });
});

it('renders source credits without JavaScript and links them from every page', async () => {
  const response = get('/licenses'),
    body = plain(await response.text());
  expect(response.status).toBe(200);
  expect(body).toContain('<title>Source licenses and credits | Joystyk</title>');
  expect(body).toContain('Made with Natural Earth');
  expect(body).toContain('v5.1.2');
  expect(body).toContain('public domain');
  expect(body).toContain('SCOWL 2020.12.07');
  expect(body).toContain('Shutterstock');
  expect(body).toContain('creativecommons.org/licenses/by/4.0/');
  expect(body).toContain('href="https://joystyk.test/licenses"');
  expect(await get('/').text()).toContain('href="/licenses"');
});
