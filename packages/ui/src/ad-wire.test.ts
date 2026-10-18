// The ad endpoint's wire format: canonical request URLs, the query the server accepts, and
// the answers the browser accepts.
import { describe, expect, it } from 'vitest';
import { adQueryUrl, parseAdFill, parseAdQuery } from './ad-wire.ts';

const query = (search: string) => parseAdQuery(new URLSearchParams(search));

describe('adQueryUrl', () => {
  it('writes the parameters in one order and leaves out empty ones', () => {
    expect(adQueryUrl({ slot: 'game-page', page: 'game', game: 'nim', category: 'board' })).toBe(
      '/api/ads/slot?slot=game-page&page=game&game=nim',
    );
    expect(adQueryUrl({ slot: 'category-rail', page: 'category', game: null, category: 'cards' })).toBe(
      '/api/ads/slot?slot=category-rail&page=category&category=cards',
    );
    expect(adQueryUrl({ slot: 'index-hero', page: 'home', game: null, category: null })).toBe(
      '/api/ads/slot?slot=index-hero&page=home',
    );
  });
});

describe('parseAdQuery', () => {
  it('reads a valid query, dropping the category when a game is given', () => {
    expect(query('slot=game-page&page=game&game=nim&category=board')).toEqual({
      slot: 'game-page',
      page: 'game',
      game: 'nim',
      category: null,
    });
    expect(query('slot=category-rail&page=home')).toEqual({
      slot: 'category-rail',
      page: 'home',
      game: null,
      category: null,
    });
  });

  it('refuses unknown slots, pages a slot never appears on and malformed ids', () => {
    expect(query('slot=popup&page=home')).toBeNull();
    expect(query('slot=index-hero&page=game')).toBeNull();
    expect(query('slot=game-page')).toBeNull();
    expect(query('slot=game-page&page=game&game=Nim')).toBeNull();
    expect(query('slot=game-page&page=game&game=../etc')).toBeNull();
    expect(query(`slot=game-page&page=game&game=${'a'.repeat(65)}`)).toBeNull();
  });
});

describe('parseAdFill', () => {
  const creative = {
    kind: 'creative',
    id: 3,
    image: { src: '/ads/creative/abc.webp', width: 300, height: 250 },
    alt: 'A plain shape',
    headline: 'A headline',
    href: '/ads/click/3?slot=game-page',
    beacon: '/api/ads/impression?creative=3&slot=game-page',
  };

  it('accepts the three kinds of answer', () => {
    expect(parseAdFill(creative)).toEqual(creative);
    expect(
      parseAdFill({
        kind: 'house',
        headline: 'Advertise with us',
        text: 'Reach families.',
        cta: 'Find out how',
        href: '/advertise',
      })?.kind,
    ).toBe('house');
    expect(parseAdFill({ kind: 'collapse' })).toEqual({ kind: 'collapse' });
  });

  it('refuses links and images that leave the site, and anything incomplete', () => {
    expect(parseAdFill({ ...creative, href: 'https://elsewhere.example/' })).toBeNull();
    expect(parseAdFill({ ...creative, href: '//elsewhere.example/' })).toBeNull();
    expect(parseAdFill({ ...creative, image: { ...creative.image, src: 'javascript:alert(1)' } })).toBeNull();
    expect(parseAdFill({ ...creative, alt: '' })).toBeNull();
    expect(parseAdFill({ kind: 'html', markup: '<script></script>' })).toBeNull();
    expect(parseAdFill('nope')).toBeNull();
  });
});
