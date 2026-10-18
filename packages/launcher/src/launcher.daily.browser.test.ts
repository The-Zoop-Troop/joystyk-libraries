// The launcher's daily mode in real Chromium (D-46, content-pipeline.md): the Tally fixture as
// a daily AI-content game, its puzzle served by a fake `fetch` and decoded by
// `@joystyk/daily/browser`. Nothing downloads before the AI-content notice is accepted; the
// game plays on the published config; the results record the streak and show the share text;
// a second visit the same day shows that result instead of a new game; and a device offline
// with nothing cached says so plainly.
import { settled } from '@gyral/core';
import type { GameEntry, Json } from '@joystyk/contracts';
import { contentHashOf, createDailyResults, DAILY_MESSAGES } from '@joystyk/daily/browser';
import { createMemoryBackend, openStorage, type StorageBackend } from '@joystyk/storage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@joystyk/ui/tokens.css';
import {
  createLauncherServices,
  dailyPrefetchers,
  provideLauncherServices,
  type GameLoaders,
} from './browser/index.ts';
import { tallyEngine, tallyEntry, tallyManifest, tallyProbe } from './fixture/index.ts';
import { Launcher } from './launcher.ts';
import { launcherGame } from './model.ts';

const WAIT = { timeout: 45_000 };

/** Tally as a daily AI-content game: the same engine and canvas, a daily-only manifest. */
const dailyManifest = { ...tallyManifest, modes: ['daily'] as const, aiContent: true };
const dailyEntry: GameEntry<HTMLElement> = { ...tallyEntry, manifest: dailyManifest };
const GAMES: GameLoaders = { 'test-tally': { entry: async () => dailyEntry } };
let games = GAMES;

/** 12:00 UTC on 2026-10-08: the puzzle date is 2026-10-08 everywhere. */
const NOW = Date.UTC(2026, 9, 8, 12);
const DATE = '2026-10-08';
let dailyNow = NOW;
const CONFIG: Json = { target: 3 };

let backend: StorageBackend;
let requests: string[];
let offline: boolean;

const fakeFetch = async (url: string): Promise<Response> => {
  requests.push(url);
  if (offline) throw new TypeError('Failed to fetch');
  const hash = (await contentHashOf(CONFIG)) ?? '000000000000';
  const file = { schemaVersion: 1, puzzleId: `test-tally:${DATE}`, date: DATE, contentHash: hash, config: CONFIG };
  if (url.endsWith('/index.json')) {
    const size = JSON.stringify(file).length;
    return Response.json({ schemaVersion: 1, gameId: 'test-tally', dates: [{ date: DATE, hash, size }] });
  }
  if (url.endsWith(`/${DATE}.${hash}.json`)) return Response.json(file);
  return new Response('Not found', { status: 404 });
};

beforeEach(() => {
  games = GAMES;
  dailyNow = NOW;
  backend = createMemoryBackend();
  requests = [];
  offline = false;
  tallyProbe.reset();
});

afterEach(() => {
  document.body.replaceChildren();
});

type Launched = InstanceType<typeof Launcher>;

const services = () =>
  createLauncherServices({
    games,
    openStorage: async (onNotice) => openStorage({ backend, onNotice }),
    aiDelayMs: 0,
    daily: { fetch: fakeFetch, now: () => dailyNow },
  });

const mount = async (manifest = dailyManifest): Promise<Launched> => {
  const container = document.createElement('main');
  document.body.append(container);
  provideLauncherServices(container, services());
  const el = new Launcher();
  el.game = launcherGame(manifest);
  container.append(el);
  await settled();
  return el;
};

const root = (el: Launched): ShadowRoot => el.shadowRoot as ShadowRoot;
const board = (el: Launched) =>
  root(el).querySelector('jy-game-stage')?.shadowRoot?.querySelector('.tally-board')?.shadowRoot ?? null;

const add = async (el: Launched, amount: 1 | 2) => {
  await vi.waitFor(
    () =>
      expect(board(el)?.querySelector<HTMLButtonElement>(`[data-amount="${String(amount)}"]`)?.disabled).toBe(false),
    WAIT,
  );
  board(el)
    ?.querySelector<HTMLButtonElement>(`[data-amount="${String(amount)}"]`)
    ?.click();
  await settled();
};

it('downloads nothing before the notice, plays the published puzzle, and records the streak and share text', async () => {
  const el = await mount();
  await expect.element(page.getByRole('radio', { name: 'Daily puzzle' })).toBeChecked();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'This game uses AI-made content' })).toBeVisible();
  expect(requests).toEqual([]);

  await page.getByRole('button', { name: 'Accept and play' }).click();
  // The published config (target 3) replaced the game's own default of 5.
  await add(el, 2);
  await add(el, 1);
  await expect.element(page.getByRole('heading', { name: 'Complete!' })).toBeVisible();
  expect(requests.some((url) => url === '/daily/test-tally/index.json')).toBe(true);
  await vi.waitFor(() => expect(root(el).querySelector('.daily-facts')?.textContent).toContain('1 day (best 1)'), WAIT);
  expect(root(el).querySelector('.next')?.textContent).toMatch(/^New puzzle at .+ \(in .+\)$/);
  const preview = root(el).querySelector('.share-preview pre')?.textContent ?? '';
  expect(preview.split('\n')[0]).toBe(`Tally ${DATE} Reached 3 in 2 moves.`);
  expect(preview).not.toContain('?');
  await expect.element(page.getByRole('button', { name: 'Share' })).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Copy as text' })).toBeVisible();
  // One puzzle a day: no Play again, and only one mode to change to.
  expect(page.getByRole('button', { name: 'Play again' }).query()).toBeNull();
  expect(page.getByRole('button', { name: 'Change mode' }).query()).toBeNull();
});

for (const assisted of [false, true])
  it(`passes counted undo to the game's share policy and records assisted=${assisted}`, async () => {
    const base = await dailyEntry.load();
    const share = vi.fn((_state: unknown, outcome?: { undosUsed?: number }) => ({
      assisted,
      headline: 'Done',
      rows: [{ symbols: '↩️', words: `${outcome?.undosUsed ?? 0} undo` }],
    }));
    const custom: GameEntry<HTMLElement> = {
      ...dailyEntry,
      manifest: { ...dailyManifest, undo: 'unlimited' },
      load: async () => ({
        ...base,
        engine: { ...tallyEngine, share },
        mount: (slot, session, platform) => {
          const mounted = base.mount(slot, session, platform),
            undo = document.createElement('button');
          undo.type = 'button';
          undo.textContent = 'Undo test move';
          undo.onclick = () => {
            (session.dispatch as (input: unknown) => void)({ kind: 'undo' });
          };
          slot.append(undo);
          return {
            dispose: () => {
              undo.remove();
              mounted.dispose();
            },
          };
        },
      }),
    };
    games = { 'test-tally': { entry: async () => custom } };
    const el = await mount();
    await page.getByRole('button', { name: 'Start Tally' }).click();
    await page.getByRole('button', { name: 'Accept and play' }).click();
    await add(el, 2);
    await page.getByRole('button', { name: 'Undo test move' }).click();
    await settled();
    await add(el, 2);
    await add(el, 1);
    await expect.element(page.getByRole('heading', { name: 'Complete!' })).toBeVisible();
    await vi.waitFor(() => expect(share).toHaveBeenCalled(), WAIT);
    expect(share.mock.calls[0]?.[1]?.undosUsed).toBe(1);
    const player = await services().openPlayer();
    if (player.device === undefined) throw new Error('No device storage');
    await vi.waitFor(async () => {
      const result = await createDailyResults(player.device!, player.playerId).get(`test-tally:${DATE}`, null);
      expect(result.ok && result.value?.assisted).toBe(assisted);
    }, WAIT);
  });

it("shows today's earlier result on a second visit instead of starting a new game", async () => {
  const first = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Accept and play' }).click();
  await add(first, 2);
  await add(first, 1);
  await vi.waitFor(() => expect(root(first).querySelector('.daily-facts')).not.toBeNull(), WAIT);
  document.body.replaceChildren();
  tallyProbe.reset();

  const second = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: "You've played today's puzzle" })).toBeVisible();
  expect(root(second).querySelector('.summary')?.textContent).toBe('Reached 3 in 2 moves.');
  expect(root(second).querySelector('.daily-facts')?.textContent).toContain('1 day (best 1)');
  expect(tallyProbe.mounts).toBe(0);
  // There is no board to review behind an earlier result.
  expect(page.getByRole('button', { name: 'Review the board' }).query()).toBeNull();
});

it('says plainly that the puzzle needs a connection when offline with nothing cached', async () => {
  offline = true;
  await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Accept and play' }).click();
  await expect.element(page.getByText(DAILY_MESSAGES.Offline)).toBeVisible();
  expect(tallyProbe.mounts).toBe(0);
});

it('prefetches for the PWA only once the AI-content notice is accepted, and only listed days', async () => {
  const [prefetcher] = dailyPrefetchers(services(), ['test-tally']);
  if (prefetcher === undefined) throw new Error('no prefetcher');
  expect(await prefetcher.prefetch(DATE)).toBeNull();
  expect(requests).toEqual([]);

  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Accept and play' }).click();
  await add(el, 2);
  requests = [];
  const [accepted] = dailyPrefetchers(services(), ['test-tally']);
  // Today is already cached from playing; tomorrow isn't listed yet.
  expect(await accepted?.prefetch(DATE)).toMatchObject({ cached: [DATE], unavailable: ['2026-10-09'], failed: [] });
});

it('runs a daily simulation on the published config and uses its share summary', async () => {
  const base = await tallyEntry.load();
  const { engine: _engine, ...canvas } = base;
  const simulation: import('@joystyk/contracts').FixedStepSimulation<
    import('./fixture/engine.ts').TallyState,
    import('./fixture/engine.ts').TallyCommand,
    import('./fixture/engine.ts').TallyView,
    import('./fixture/engine.ts').TallyEvent,
    import('./fixture/engine.ts').TallyConfig
  > = {
    rulesVersion: 1,
    stepHz: 60,
    schemas: {
      config: tallyEngine.schemas.config,
      state: tallyEngine.schemas.state,
      input: tallyEngine.schemas.command,
      event: tallyEngine.schemas.event,
    },
    init: (config, rng) => tallyEngine.init(config, [{ id: 0, name: 'Player', controller: 'human' }], rng),
    step: (state, inputs, rng) => {
      let next = state;
      for (const command of inputs) {
        const applied = tallyEngine.apply(next, { kind: 'command', seat: 0, command }, rng);
        if (applied.ok) next = applied.value.state;
      }
      return { state: next };
    },
    view: (state) => tallyEngine.viewFor(state, 0),
    outcome: (state) => tallyEngine.outcome(state),
    share: () => ({ headline: 'Simulation complete', rows: [{ symbols: '⭐', words: 'Published course completed' }] }),
  };
  let runner:
    | import('@joystyk/session').FixedStepRunner<
        import('./fixture/engine.ts').TallyCommand,
        import('./fixture/engine.ts').TallyView,
        import('./fixture/engine.ts').TallyEvent
      >
    | null = null;
  const entry: GameEntry<HTMLElement> = {
    ...dailyEntry,
    manifest: { ...dailyManifest, layers: { engine: false, simulation: true } },
    load: async () => ({
      ...canvas,
      simulation,
      mount: (slot, session) => {
        runner = session as unknown as NonNullable<typeof runner>;
        const button = document.createElement('button');
        button.textContent = 'Finish simulation';
        const send = session.dispatch as (
          input: import('@joystyk/session').FixedStepInput<import('./fixture/engine.ts').TallyCommand>,
        ) => void;
        button.onclick = () => {
          send({ kind: 'input', input: { type: 'add', amount: 2 } });
          send({ kind: 'input', input: { type: 'add', amount: 1 } });
        };
        slot.append(button);
        return { dispose: () => button.remove() };
      },
    }),
  };
  games = { 'test-tally': { entry: async () => entry } };
  await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Accept and play' }).click();
  const active = (): NonNullable<typeof runner> => {
    if (runner === null) throw Error('No simulation runner');
    return runner;
  };
  await vi.waitFor(() => expect(runner).not.toBeNull(), WAIT);
  active().dispatch({ kind: 'input', input: { type: 'add', amount: 2 } });
  await vi.waitFor(() => expect(active().get().view.scores[0]).toBe(2), WAIT);
  active().dispatch({ kind: 'pause' });
  const player = await services().openPlayer();
  await vi.waitFor(async () => {
    const save = await player.storage.saves.read('test-tally', 'daily');
    expect(save.ok && save.value?.envelope.daily?.puzzleId).toBe(`test-tally:${DATE}`);
  }, WAIT);
  document.body.replaceChildren();
  runner = null;
  dailyNow = NOW + 86400000;
  const resumed = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await vi.waitFor(() => expect(runner).not.toBeNull(), WAIT);
  await vi.waitFor(() => expect(active().get().paused).toBe(true), WAIT);
  expect(active().get().view.scores[0]).toBe(2);
  active().dispatch({ kind: 'resume' });
  await page.getByRole('button', { name: 'Finish simulation' }).click();
  await expect.element(page.getByRole('heading', { name: 'Complete!' })).toBeVisible();
  await vi.waitFor(() => expect(root(resumed).querySelector('.share-preview')?.textContent).toContain('⭐'), WAIT);
  const result = await createDailyResults(player.device!, player.playerId).get(`test-tally:${DATE}`, null);
  expect(result.ok && result.value?.puzzleId).toBe(`test-tally:${DATE}`);
});
