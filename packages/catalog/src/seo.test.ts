import { describe, expect, it } from 'vitest';
import { TEST_ENTRIES } from './fixtures.test-util.ts';
import { createRegistry } from './registry.ts';
import { pageFor } from './routes.ts';
import { headFor, playModes } from './seo.ts';
import { emptyCatalog, type CatalogState } from './store.ts';

const ORIGIN = 'https://joystyk.test';
const registry = createRegistry(TEST_ENTRIES);
const dice = registry.detail('test-dice');
if (dice === undefined) throw new Error('test dice missing');
const cards = registry.detail('test-cards');
if (cards === undefined) throw new Error('test cards missing');
const state: CatalogState = {
  ...emptyCatalog(ORIGIN, registry.categories()),
  games: { 'test-dice': dice, 'test-cards': cards },
};

describe('headFor', () => {
  it('gives the index a canonical URL and WebSite structured data', () => {
    const head = headFor(pageFor('/'), state);
    expect(head).toMatchObject({ canonical: `${ORIGIN}/`, robots: 'index', ogType: 'website' });
    expect(head.jsonLd).toMatchObject({ '@type': 'WebSite', url: `${ORIGIN}/` });
  });

  it('describes a game with VideoGame and a three-step BreadcrumbList', () => {
    const head = headFor(pageFor('/games/test-dice'), state);
    expect(head.title).toBe('Test Dice: free online dice game | Joystyk');
    expect(head.description).toBe(`${dice.summary} Free in your browser, 2–8 players.`);
    expect(head.canonical).toBe(`${ORIGIN}/games/test-dice`);
    const graph = (head.jsonLd as { '@graph': Record<string, unknown>[] })['@graph'];
    expect(graph[0]).toMatchObject({
      '@type': 'VideoGame',
      name: 'Test Dice',
      genre: 'Dice',
      url: `${ORIGIN}/games/test-dice`,
      playMode: ['MultiPlayer'],
      numberOfPlayers: { '@type': 'QuantitativeValue', minValue: 2, maxValue: 8 },
      isAccessibleForFree: true,
    });
    expect(graph[1]).toMatchObject({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { position: 1, name: 'Games', item: `${ORIGIN}/` },
        { position: 2, name: 'Dice', item: `${ORIGIN}/categories/dice` },
        { position: 3, name: 'Test Dice', item: `${ORIGIN}/games/test-dice` },
      ],
    });
  });

  it('names a game by its page title in the title and VideoGame, and by its display name in the breadcrumbs', () => {
    const head = headFor(pageFor('/games/test-cards'), state);
    expect(head.title).toBe('Test Cards Showdown: free online card game | Joystyk');
    expect(head.title.length).toBeLessThanOrEqual(60);
    const graph = (head.jsonLd as { '@graph': Record<string, unknown>[] })['@graph'];
    expect(graph[0]).toMatchObject({ '@type': 'VideoGame', name: 'Test Cards Showdown', alternateName: 'Test Cards' });
    expect(graph[1]).toMatchObject({
      itemListElement: [{ name: 'Games' }, { name: 'Cards' }, { position: 3, name: 'Test Cards' }],
    });
    // Without a page title there is nothing to add.
    const dicePage = (headFor(pageFor('/games/test-dice'), state).jsonLd as { '@graph': Record<string, unknown>[] })[
      '@graph'
    ][0];
    expect(dicePage).not.toHaveProperty('alternateName');
  });

  it('describes a category with its own description and breadcrumbs', () => {
    const head = headFor(pageFor('/categories/cards'), state);
    expect(head.title).toBe('Cards games: play free in your browser | Joystyk');
    expect(head.canonical).toBe(`${ORIGIN}/categories/cards`);
    expect(head.jsonLd).toMatchObject({ '@type': 'BreadcrumbList' });
  });

  it('keeps unknown pages, games and categories out of the index', () => {
    for (const path of ['/nope', '/categories/board']) {
      expect(headFor(pageFor(path), state)).toMatchObject({ robots: 'noindex', canonical: null, jsonLd: null });
    }
    expect(headFor(pageFor('/games/gone'), { ...state, missing: ['gone'] })).toMatchObject({
      robots: 'noindex',
      canonical: null,
    });
  });

  it('marks a game that is still loading as such, without a canonical', () => {
    expect(headFor(pageFor('/games/shift-23'), state)).toMatchObject({ title: 'Loading… | Joystyk', canonical: null });
  });
});

describe('playModes', () => {
  it('maps manifest modes to schema.org play modes', () => {
    expect(playModes(['solo'])).toEqual(['SinglePlayer']);
    expect(playModes(['ai', 'pass-and-play'])).toEqual(['SinglePlayer', 'MultiPlayer']);
    expect(playModes(['server'])).toEqual(['MultiPlayer']);
  });
});
