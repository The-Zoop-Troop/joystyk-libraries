// DOM-free model tests: the catalog store, the <jy-app> shell and what the launcher is given.
import { http } from '@gyral/http';
import { isLauncherGame } from '@joystyk/launcher';
import { initial, inputsFor, reject, resolve, step, stepStore, subscriptionsFor } from '@gyral/testing';
import { describe, expect, it } from 'vitest';
import { App } from './components/app.ts';
import { launcherGameOf } from './components/views.ts';
import { TEST_ENTRIES } from './fixtures.test-util.ts';
import { createRegistry } from './registry.ts';
import { pageFor } from './routes.ts';
import { catalog, emptyCatalog, type CatalogState } from './store.ts';

const registry = createRegistry(TEST_ENTRIES);
const base = emptyCatalog('https://joystyk.test', registry.categories());
const location = (pathname: string) => ({
  href: `https://joystyk.test${pathname}`,
  pathname,
  search: '',
  hash: '',
  seq: 1,
});
const driverNames = (commands: ReadonlyArray<{ readonly driver: { readonly name: string } }>) =>
  commands.map((c) => c.driver.name);

describe('catalog store', () => {
  it('loads one game through /api/games/:id, once', () => {
    const next = stepStore(catalog, base, { _tag: 'LoadGame', id: 'test-dice' });
    expect(inputsFor(next.commands, http)).toMatchObject([{ url: '/api/games/test-dice' }]);
    expect(next.state.gameLoads).toEqual({ 'test-dice': 'loading' });
    expect(stepStore(catalog, next.state, { _tag: 'LoadGame', id: 'test-dice' }).commands).toEqual([]);
  });

  it('ignores ids that are not game ids', () => {
    expect(stepStore(catalog, base, { _tag: 'LoadGame', id: '../etc' }).commands).toEqual([]);
  });

  it('records a 404 as a missing game and any other failure as failed', () => {
    const [command] = stepStore(catalog, base, { _tag: 'LoadGame', id: 'gone' }).commands;
    if (command === undefined) throw new Error('expected a request');
    const status = (code: number) =>
      ({ _tag: 'HttpStatusError', url: '/api/games/gone', status: code, statusText: '', body: undefined }) as const;
    expect(reject(command, status(404))).toEqual({ _tag: 'GameMissing', id: 'gone' });
    expect(reject(command, status(500))).toEqual({ _tag: 'LoadFailed', id: 'gone' });
    expect(resolve(command, registry.detail('test-dice'))).toMatchObject({ _tag: 'GameLoaded' });
  });

  it('stores a loaded game and a missing one', () => {
    const dice = registry.detail('test-dice');
    if (dice === undefined) throw new Error('test dice missing');
    const loaded = stepStore(catalog, base, { _tag: 'GameLoaded', game: dice }).state;
    expect(loaded.games['test-dice']).toEqual(dice);
    const missing = stepStore(catalog, base, { _tag: 'GameMissing', id: 'gone' }).state;
    expect(missing.missing).toEqual(['gone']);
  });

  it('loads the summaries only when it has none', () => {
    expect(inputsFor(stepStore(catalog, base, { _tag: 'LoadSummaries' }).commands, http)).toMatchObject([
      { url: '/api/games' },
    ]);
    const seeded: CatalogState = { ...base, summaries: [...registry.summaries()] };
    expect(stepStore(catalog, seeded, { _tag: 'LoadSummaries' }).commands).toEqual([]);
  });

  it('validates its seed with the same schema the browser uses', () => {
    expect(catalog.spec.schema?.['~standard'].validate(base)).toEqual({ value: base });
    const bad = catalog.spec.schema?.['~standard'].validate({ ...base, summaries: [{ id: 'x' }] });
    expect(bad).toHaveProperty('issues');
  });
});

describe('<jy-app> model', () => {
  const home = { page: pageFor('/'), focusPending: false, live: true };
  const seeded: CatalogState = { ...base, summaries: [...registry.summaries()] };

  it('starts on the server-rendered page and listens to the router', () => {
    const start = initial(App.spec, { path: '/games/test-dice' });
    expect(start.state).toEqual({ page: { _tag: 'Game', id: 'test-dice' }, focusPending: false, live: false });
    expect(start.commands).toEqual([]);
    expect(driverNames(subscriptionsFor(App.spec, start.state, { path: '/games/test-dice' }))).toEqual(['router']);
  });

  it("ignores the router's first report of the page it already shows", () => {
    expect(
      step(App.spec, home, { _tag: 'Routed', location: location('/') }, { path: '/' }, [catalog.instance(seeded)])
        .state,
    ).toBe(home);
  });

  it('loads a game it lacks, updates the head, and waits to move focus', () => {
    const store = catalog.instance(seeded);
    const next = step(App.spec, home, { _tag: 'Routed', location: location('/games/test-dice') }, { path: '/' }, [
      store,
    ]);
    expect(next.state).toMatchObject({ page: { _tag: 'Game', id: 'test-dice' }, focusPending: true });
    expect(inputsFor(next.commands, catalog)).toEqual([{ _tag: 'LoadGame', id: 'test-dice' }]);
    expect(driverNames(next.commands)).toContain('router');
  });

  it('moves focus at once when the new page is already in the store', () => {
    const next = step(
      App.spec,
      { ...home, page: pageFor('/games/test-dice') },
      { _tag: 'Routed', location: location('/categories/dice') },
      { path: '/' },
      [catalog.instance(seeded)],
    );
    expect(next.state.focusPending).toBe(false);
    expect(driverNames(next.commands)).toEqual(['router', '@gyral/focus']);
  });
});

describe('the launcher on a game page', () => {
  it('gets the manifest facts it picks modes from, and whether the game is playable', () => {
    const detail = registry.detail('test-cards');
    if (detail === undefined) throw new Error('missing test-cards');
    const game = launcherGameOf(detail);
    expect(game).toEqual({
      id: 'test-cards',
      name: 'Test Cards',
      modes: ['ai', 'pass-and-play', 'server'],
      players: { min: 1, max: 5 },
      aiLevels: ['standard'],
      status: 'coming-soon',
      aiContent: false,
    });
    expect(isLauncherGame(game)).toBe(true);
  });
});
