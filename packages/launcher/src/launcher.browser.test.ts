import { ok, type GameOption, type Json, type Result } from '@joystyk/contracts';
// <jy-launcher> in real Chromium with the real stage, session runner and storage (on a memory
// backend), playing the Tally fixture: mode selection, mounting and disposal, resume, the
// hand-off screen, the overlay's focus trap and Escape, preferences and reduced motion,
// results over the final board, theme tokens, readable canvas text in both color schemes and
// safe points.
import { defineDriver, provideDrivers, settled } from '@gyral/core';
import {
  createMemoryBackend,
  createMemoryChangeHub,
  openStorage,
  type ChangeFeed,
  type StorageBackend,
} from '@joystyk/storage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@joystyk/ui/tokens.css';
import { createLauncherServices, provideLauncherServices, type GameLoaders } from './browser/index.ts';
import { tallyEngine, tallyEntry, tallyManifest, tallyProbe, type TallyState } from './fixture/index.ts';
import { tallyModule } from './fixture/module.ts';
import { Launcher } from './launcher.ts';
import { launcherGame, type LauncherGame, type OnlineRooms } from './model.ts';
import { requestSave, watchSafePoints, type SafePointDetail } from './safe-point.ts';
import { canvasTheme } from './theme.ts';

// `vi.waitFor` gives up after one second by default, which a loaded machine can spend on a
// single render. Waits here get most of the browser project's 60-second test timeout instead.
const WAIT = { timeout: 45_000 };

const GAMES: GameLoaders = { 'test-tally': { entry: async () => tallyEntry } };

let backend: StorageBackend;

beforeEach(() => {
  backend = createMemoryBackend();
  tallyProbe.reset();
});

afterEach(() => {
  document.body.replaceChildren();
});

type Launched = InstanceType<typeof Launcher>;

/** The room server's answer, in place of `GET /api/rooms/games`: it hosts the Tally fixture. */
const HOSTED: OnlineRooms = { _tag: 'Hosted', games: ['test-tally'], protocol: 1 };

/** Mounts a launcher for `game` under a container that provides services over `backend`. */
const mount = async (
  game: LauncherGame = launcherGame(tallyManifest),
  games: GameLoaders = GAMES,
  provide = true,
  online: OnlineRooms = HOSTED,
  changes?: ChangeFeed,
): Promise<Launched> => {
  const container = document.createElement('main');
  document.body.append(container);
  // No ad endpoint here: the results slot's request stays pending, so its reserved box shows.
  provideDrivers(container, {
    'ad-server': defineDriver<string, never>({ name: 'ad-server', run: () => new Promise<never>(() => {}) }),
  });
  if (provide) {
    provideLauncherServices(
      container,
      createLauncherServices({
        games,
        openStorage: async (onNotice) =>
          openStorage({ backend, onNotice, ...(changes === undefined ? {} : { changes }) }),
        aiDelayMs: 0,
      }),
    );
  }
  const el = new Launcher();
  el.game = game;
  el.drivers = {
    'launcher-online-rooms': defineDriver<undefined, OnlineRooms>({ name: 'launcher-online-rooms', run: () => online }),
  };
  container.append(el);
  await settled();
  return el;
};

const root = (el: Launched): ShadowRoot => {
  if (el.shadowRoot === null) throw new Error('no shadow root');
  return el.shadowRoot;
};
const stage = (el: Launched) => root(el).querySelector('jy-game-stage');
const board = (el: Launched) => stage(el)?.shadowRoot?.querySelector('.tally-board')?.shadowRoot ?? null;
const boardText = (el: Launched, selector: string) => board(el)?.querySelector(selector)?.textContent ?? null;
const focusedIn = (el: Launched) => root(el).activeElement;

/** Waits until the fixture's board is mounted and accepts moves. */
const playable = async (el: Launched) => {
  await vi.waitFor(() => {
    const button = board(el)?.querySelector<HTMLButtonElement>('[data-amount="2"]');
    expect(button?.disabled).toBe(false);
  }, WAIT);
};

const add = async (el: Launched, amount: 1 | 2) => {
  await playable(el);
  board(el)
    ?.querySelector<HTMLButtonElement>(`[data-amount="${String(amount)}"]`)
    ?.click();
  await settled();
};

it('goes live with the modes from the manifest; server rooms play, P2P rooms are coming soon', async () => {
  const el = await mount({ ...launcherGame(tallyManifest), modes: [...tallyManifest.modes, 'p2p'] });
  expect(el.matches(':state(live)')).toBe(true);
  await expect.element(page.getByRole('radio', { name: 'Solo' })).toBeChecked();
  await expect.element(page.getByRole('radio', { name: 'Online with friends' })).toBeEnabled();
  await expect.element(page.getByRole('radio', { name: /Online, peer to peer/ })).toBeDisabled();
  await expect.element(page.getByText('Coming soon')).toBeVisible();
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeEnabled();
});

it('shows Online with friends as unavailable when the room server can’t be reached, and plays locally', async () => {
  const el = await mount(launcherGame(tallyManifest), GAMES, true, { _tag: 'Unreachable' });
  await expect.element(page.getByRole('radio', { name: 'Online with friends' })).toBeDisabled();
  await expect.element(page.getByText('Unavailable right now')).toBeVisible();
  await expect.element(page.getByRole('radio', { name: 'Solo' })).toBeChecked();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
});

it('shows Online with friends as coming soon for a game the room server doesn’t host (D-53)', async () => {
  await mount(launcherGame(tallyManifest), GAMES, true, { _tag: 'Hosted', games: ['nim'], protocol: 1 });
  await expect.element(page.getByRole('radio', { name: 'Online with friends' })).toBeDisabled();
  await expect.element(page.getByText('Coming soon')).toBeVisible();
  await expect.element(page.getByRole('radio', { name: 'Against the computer' })).toBeEnabled();
});

it('picks a mode from the keyboard and shows the choices that mode needs', async () => {
  const el = await mount();
  await userEvent.tab();
  expect(focusedIn(el)).toBe(page.getByRole('radio', { name: 'Solo' }).element());
  await userEvent.keyboard('{ArrowRight}');
  await expect.element(page.getByRole('radio', { name: 'Against the computer' })).toBeChecked();
  await expect.element(page.getByRole('combobox', { name: 'Computer level' })).toBeVisible();
  await userEvent.keyboard('{ArrowRight}');
  await expect.element(page.getByRole('radio', { name: 'Pass and play' })).toBeChecked();
  await expect.element(page.getByRole('textbox', { name: 'Player 1' })).toBeVisible();
  await expect.element(page.getByRole('textbox', { name: 'Player 2' })).toBeVisible();
});

it('starts the vs-computer player count at the game’s default, or at the fewest without one', async () => {
  // A wider table than Tally plays: only the setup screen is under test here.
  const wide = launcherGame({ ...tallyManifest, players: { min: 1, max: 5, default: 4 } });
  await mount(wide);
  await page.getByRole('radio', { name: 'Against the computer' }).click();
  const players = page.getByRole('combobox', { name: 'Players' });
  await expect.element(players).toHaveValue('4');
  // Pass and play counts people, so it starts at two; back against the computer, at the default again.
  await page.getByRole('radio', { name: 'Pass and play' }).click();
  await expect.element(players).toHaveValue('2');
  await page.getByRole('radio', { name: 'Against the computer' }).click();
  await expect.element(players).toHaveValue('4');
  document.body.replaceChildren();

  await mount({ ...wide, players: { min: 1, max: 5 } });
  await page.getByRole('radio', { name: 'Against the computer' }).click();
  await expect.element(page.getByRole('combobox', { name: 'Players' })).toHaveValue('2');
});

it('keeps Start disabled for a game that is coming soon', async () => {
  await mount({ ...launcherGame(tallyManifest), status: 'coming-soon' });
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeDisabled();
  await expect.element(page.getByText('Coming soon: not playable yet.')).toBeVisible();
});

it('starts with native game options and resumes the saved configuration after setup changes', async () => {
  const options: readonly GameOption[] = [
    {
      key: 'target',
      kind: 'select',
      label: 'Target score',
      default: 5,
      modes: ['solo'],
      choices: [
        { value: 3, label: '3' },
        { value: 5, label: '5' },
      ],
    },
    { key: 'bonus', kind: 'toggle', label: 'Bonus rounds', default: false, modes: ['solo'] },
  ];
  const manifest = { ...tallyManifest, options };
  let supplied: Json = null;
  const games: GameLoaders = {
    'test-tally': {
      entry: async () => ({
        ...tallyEntry,
        manifest,
        load: async () => ({
          ...tallyModule,
          configFromSetup: (setup) => {
            supplied = setup;
            return ok(setup);
          },
        }),
      }),
    },
  };
  const el = await mount(launcherGame(manifest), games);
  await page.getByRole('combobox', { name: 'Target score' }).selectOptions('3');
  await page.getByRole('checkbox', { name: 'Bonus rounds' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await add(el, 1);
  expect(supplied).toEqual({ target: 3, bonus: true });
  expect(boardText(el, 'h3')).toBe('First to 3');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await page.getByRole('combobox', { name: 'Target score' }).selectOptions('5');
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Resume' }).click();
  await playable(el);
  expect(boardText(el, 'h3')).toBe('First to 3');
  expect(boardText(el, '.scores')).toMatch(/: 1$/);
  await add(el, 2);
  await expect.element(page.getByRole('heading', { name: 'Complete!' })).toBeVisible();
});

it('offers a one-human computer mode and passes its selected level without adding an AI seat', async () => {
  const manifest = { ...tallyManifest, players: { min: 1, max: 1 }, modes: ['solo', 'ai'] as const };
  let supplied: Json = null;
  const games: GameLoaders = {
    'test-tally': {
      entry: async () => ({
        ...tallyEntry,
        manifest,
        load: async () => ({
          ...tallyModule,
          configFromSetup: (setup) => {
            supplied = setup;
            return ok(setup);
          },
        }),
      }),
    },
  };
  const el = await mount(launcherGame(manifest), games);
  await page.getByRole('radio', { name: 'Against the computer' }).click();
  await page.getByRole('combobox', { name: 'Computer level' }).selectOptions('easy');
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  expect(supplied).toEqual({ level: 'easy' });
  expect(board(el)?.querySelectorAll('.scores li')).toHaveLength(1);
});

it('mounts the game with its theme, plays to the results over the final board, and disposes it on Play again', async () => {
  const reports: SafePointDetail[] = [];
  const stop = watchSafePoints((detail) => reports.push(detail));
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  expect(tallyProbe.mounts).toBe(1);
  expect(focusedIn(el)).toBe(stage(el));

  // Theme handoff: the canvas carries the game's tokens; the frame keeps Joystyk's.
  const canvas = stage(el)?.shadowRoot?.querySelector('.canvas');
  if (!(canvas instanceof HTMLElement)) throw new Error('no canvas');
  const tokens = canvasTheme(tallyManifest.theme);
  expect(getComputedStyle(canvas).getPropertyValue('--game-accent').trim()).toBe(tokens.accent);
  expect(getComputedStyle(canvas).getPropertyValue('--game-surface').trim()).toBe(tokens.surface);
  expect(getComputedStyle(canvas).getPropertyValue('--game-ink').trim()).toBe(tokens.ink);
  expect(getComputedStyle(root(el).querySelector('.launcher') as Element).getPropertyValue('--game-accent')).toBe('');
  // The guest plays under their generated display name, and the game's storage is scoped to it.
  expect(boardText(el, '.scores')).toMatch(/^[A-Za-z]+ [A-Za-z]+ \d+: 0$/);
  await vi.waitFor(() => expect(tallyProbe.plays).toEqual([1]), WAIT);

  await add(el, 2);
  await add(el, 2);
  const before = stage(el)?.getBoundingClientRect();
  await add(el, 1);
  await expect.element(page.getByRole('heading', { name: 'Complete!' })).toBeVisible();
  await expect.element(page.getByRole('dialog', { name: 'Complete!' })).toBeVisible();
  expect(root(el).querySelector('.summary')?.textContent).toBe('Reached 5 in 3 moves.');
  expect(root(el).querySelector('.results time')?.getAttribute('datetime')).toMatch(/^PT\d+S$/);
  expect(root(el).querySelector('.assisted')).toBeNull();
  expect(focusedIn(el)).toBe(root(el).querySelector('#results-title'));
  const ad = root(el).querySelector('ad-slot[slot-id="results"]');
  expect(ad?.shadowRoot?.querySelector('.label')?.textContent).toBe('Advertisement');
  expect(ad?.shadowRoot?.querySelector('.box')?.getBoundingClientRect()).toMatchObject({ width: 300, height: 250 });
  // The final board stays mounted, in place, behind the results, and can't be used.
  expect(tallyProbe.disposals).toBe(0);
  expect(stage(el)?.hidden).toBe(false);
  expect(stage(el)?.inert).toBe(true);
  expect(stage(el)?.getBoundingClientRect().toJSON()).toEqual(before?.toJSON());
  expect(boardText(el, '.scores')).toMatch(/: 5$/);
  expect(boardText(el, '.turn')).toMatch(/ reached 5\.$/);
  // The results don't take the page: everything outside them stays usable.
  expect(root(el).querySelector('dialog.results')?.matches(':modal')).toBe(false);
  expect(reports.map((r) => r.safe)).toEqual([true, false, true]);

  // Other keys do nothing; Escape closes the results to the board, which can be read again.
  await userEvent.keyboard('{Enter}');
  await userEvent.keyboard('{Escape}');
  await settled();
  const dialog = root(el).querySelector<HTMLDialogElement>('dialog.results');
  expect(dialog?.open).toBe(false);
  expect(stage(el)?.inert).toBe(false);
  expect(focusedIn(el)).toBe(stage(el));
  expect(stage(el)?.getBoundingClientRect().toJSON()).toEqual(before?.toJSON());
  expect(board(el)?.querySelector<HTMLButtonElement>('[data-amount="1"]')?.disabled).toBe(true);
  // Show results brings them back, with the same ad slot.
  const ad2 = root(el).querySelector('ad-slot[slot-id="results"]');
  expect(ad2).toBe(ad);
  await page.getByRole('button', { name: 'Show results' }).click();
  expect(dialog?.open).toBe(true);
  expect(focusedIn(el)).toBe(root(el).querySelector('#results-title'));
  expect(stage(el)?.inert).toBe(true);
  await page.getByRole('button', { name: 'Review the board' }).click();
  expect(dialog?.open).toBe(false);
  await page.getByRole('button', { name: 'Show results' }).click();
  // Hiding and showing the results is still a safe point; nothing new is reported.
  expect(reports.map((r) => r.safe)).toEqual([true, false, true]);
  stop();

  await page.getByRole('button', { name: 'Play again' }).click();
  await playable(el);
  // Play again disposes the finished game and mounts a new one.
  expect(tallyProbe.disposals).toBe(1);
  expect(tallyProbe.mounts).toBe(2);
  expect(root(el).querySelector('dialog.results')).toBeNull();
  // A finished game is never offered for resuming.
  expect(root(el).querySelector('.resume')).toBeNull();
});

it('marks an assisted result', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  board(el)?.querySelector<HTMLButtonElement>('[data-hint]')?.click();
  await add(el, 2);
  await add(el, 2);
  await add(el, 2);
  await expect.element(page.getByText('Assisted: hints')).toBeVisible();
});

it('saves on exit and offers to resume, or to start a new game', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await add(el, 2);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await settled();
  expect(stage(el)).toBeNull();
  expect(tallyProbe.disposals).toBe(1);
  expect(focusedIn(el)).toBe(root(el).querySelector('.start'));

  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'Continue your saved game?' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await playable(el);
  expect(boardText(el, '.scores')).toMatch(/: 2$/);

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Start a new game' }).click();
  await playable(el);
  expect(boardText(el, '.scores')).toMatch(/: 0$/);
});

it('offers no "Continue" for a game left untouched, when the engine says it isn\'t worth saving', async () => {
  const engine = { ...tallyEngine, worthSaving: (state: TallyState) => state.moves > 0 };
  const games: GameLoaders = {
    'test-tally': {
      entry: async () => ({
        ...tallyEntry,
        load: async () => ({ ...tallyModule, engine: engine as unknown as typeof tallyModule.engine }),
      }),
    },
  };
  const el = await mount(launcherGame(tallyManifest), games);
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await settled();
  expect(stage(el)).toBeNull();

  // Nothing was played, so Start begins a new game straight away.
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  expect(root(el).querySelector('.resume')).toBeNull();
  expect(boardText(el, '.scores')).toMatch(/: 0$/);

  // One move makes the game worth resuming.
  await add(el, 2);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'Continue your saved game?' })).toBeVisible();
});

it('saves the position and stops play when a forced update asks (requestSave)', async () => {
  const el = await mount();
  // Nothing in play: the request settles at once.
  await requestSave();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await add(el, 2);
  await requestSave();
  // Play stays paused until the page reloads.
  await vi.waitFor(
    () => expect(board(el)?.querySelector<HTMLButtonElement>('[data-amount="2"]')?.disabled).toBe(true),
    WAIT,
  );

  // After a reload, the new release offers the saved game, at the saved position.
  document.body.replaceChildren();
  const reloaded = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'Continue your saved game?' })).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await vi.waitFor(() => expect(boardText(reloaded, '.scores')).toMatch(/: 2$/), WAIT);
});

it('drops the finished game when the player changes mode, or the game asks to exit from its final board', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  for (const amount of [2, 2, 1] as const) await add(el, amount);
  await page.getByRole('button', { name: 'Change mode' }).click();
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeVisible();
  expect(stage(el)).toBeNull();
  expect(tallyProbe.disposals).toBe(1);

  await page.getByRole('button', { name: 'Start Tally' }).click();
  for (const amount of [2, 2, 1] as const) await add(el, amount);
  await page.getByRole('button', { name: 'Review the board' }).click();
  board(el)?.querySelector<HTMLButtonElement>('[data-quit]')?.click();
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeVisible();
  expect(tallyProbe.disposals).toBe(2);
});

it("drops the frame's motion from the results when the player asks for reduced motion", async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('combobox', { name: 'Motion' }).selectOptions('reduce');
  await page.getByRole('button', { name: 'Resume' }).click();
  for (const amount of [2, 2, 1] as const) await add(el, amount);
  await expect.element(page.getByRole('heading', { name: 'Complete!' })).toBeVisible();
  const still = (e: Element | null | undefined) =>
    e != null &&
    getComputedStyle(e)
      .transitionDuration.split(',')
      .every((d) => d.trim() === '0s');
  expect(still(root(el).querySelector('dialog.results'))).toBe(true);
  expect(still(stage(el))).toBe(true);
});

it('lets the game ask to exit', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  board(el)?.querySelector<HTMLButtonElement>('[data-quit]')?.click();
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeVisible();
  expect(stage(el)).toBeNull();
});

it('hides each seat behind the hand-off screen in pass-and-play (D-31)', async () => {
  const el = await mount();
  await page.getByRole('radio', { name: 'Pass and play' }).click();
  await page.getByRole('textbox', { name: 'Player 1' }).fill('Ada');
  await page.getByRole('textbox', { name: 'Player 2' }).fill('Bob');
  await page.getByRole('button', { name: 'Start Tally' }).click();

  await expect.element(page.getByRole('heading', { name: 'Pass to Ada, then tap to reveal' })).toBeVisible();
  await vi.waitFor(() => expect(focusedIn(el)).toBe(root(el).querySelector('.reveal')), WAIT);
  // Nothing private is on the page, even hidden: the stage is hidden and shows the spectator view.
  expect(stage(el)?.hidden).toBe(true);
  expect(boardText(el, '.secret')).toBe('');
  await expect.element(page.getByRole('button', { name: 'Menu' })).toBeDisabled();

  await userEvent.keyboard('{Enter}');
  await playable(el);
  expect(stage(el)?.hidden).toBe(false);
  expect(boardText(el, '.secret')).toMatch(/^Your secret number is \d+\.$/);

  await add(el, 1);
  await expect.element(page.getByRole('heading', { name: 'Pass to Bob, then tap to reveal' })).toBeVisible();
  expect(boardText(el, '.secret')).toBe('');
  await page.getByRole('button', { name: 'Tap to reveal' }).click();
  await playable(el);
  expect(boardText(el, '.secret')).toMatch(/^Your secret number is \d+\.$/);
  expect(boardText(el, '.scores')).toBe('Ada: 1Bob: 0');
  expect(boardText(el, '.turn')).toBe('Bob to play.');
});

it('names the winner in pass-and-play results', async () => {
  const el = await mount();
  await page.getByRole('radio', { name: 'Pass and play' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  for (const amount of [2, 1, 2, 1, 2] as const) {
    await page.getByRole('button', { name: 'Tap to reveal' }).click();
    await add(el, amount);
  }
  await expect.element(page.getByRole('heading', { name: 'Player 1 wins!' })).toBeVisible();
});

it('swaps who moves first when playing again, as the engine says', async () => {
  const el = await mount();
  await page.getByRole('radio', { name: 'Pass and play' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  for (const amount of [2, 1, 2, 1, 2] as const) {
    await page.getByRole('button', { name: 'Tap to reveal' }).click();
    await add(el, amount);
  }
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect.element(page.getByRole('heading', { name: 'Pass to Player 2, then tap to reveal' })).toBeVisible();
});

it('keeps an AI-content game locked until the notice is accepted, then remembers it (D-44)', async () => {
  const aiManifest = { ...tallyManifest, aiContent: true };
  const games: GameLoaders = { 'test-tally': { entry: async () => ({ ...tallyEntry, manifest: aiManifest }) } };
  const el = await mount(launcherGame(aiManifest), games);
  await expect
    .element(page.getByText("This game uses AI-made content. You'll see a short notice before it starts."))
    .toBeVisible();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'This game uses AI-made content' })).toBeVisible();
  expect(stage(el)?.hidden).toBe(true);
  expect(tallyProbe.mounts).toBe(0);
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeVisible();

  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Accept and play' }).click();
  await playable(el);
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect.element(page.getByRole('checkbox', { name: 'Allow games with AI-made content' })).toBeChecked();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  // Accepted once, it doesn't ask again.
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'Continue your saved game?' })).toBeVisible();
  await page.getByRole('button', { name: 'Start a new game' }).click();
  await playable(el);
  // Turned off in Preferences, it asks again next time.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('checkbox', { name: 'Allow games with AI-made content' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: 'This game uses AI-made content' })).toBeVisible();
});

it('plays against the computer at the chosen level', async () => {
  const el = await mount();
  await page.getByRole('radio', { name: 'Against the computer' }).click();
  await page.getByRole('combobox', { name: 'Computer level' }).selectOptions('hard');
  await page.getByRole('button', { name: 'Start Tally' }).click();
  for (let n = 0; n < 3; n += 1) await add(el, 1);
  await expect.element(page.getByRole('heading', { name: 'You lost' })).toBeVisible();
  expect(root(el).querySelector('.summary')?.textContent).toBe('Computer reached 5 first.');
});

it('traps focus in the overlay, pauses the game, and closes on Escape', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  const dialog = root(el).querySelector('dialog');
  expect(dialog?.open).toBe(true);
  await expect.element(page.getByRole('dialog', { name: 'Paused' })).toBeVisible();
  expect(focusedIn(el)).toBe(page.getByRole('button', { name: 'Resume' }).element());
  // The game is paused behind the overlay.
  await vi.waitFor(
    () => expect(board(el)?.querySelector<HTMLButtonElement>('[data-amount="1"]')?.disabled).toBe(true),
    WAIT,
  );
  // Tab cycles through the dialog and never reaches the page behind it (which is inert); past
  // the last control the browser may take focus to its own toolbar, then back to the dialog.
  const visited = new Set<Element>();
  for (let n = 0; n < 16; n += 1) {
    await userEvent.tab();
    const outer = document.activeElement;
    if (outer === document.body || outer === null) continue;
    expect(outer).toBe(el);
    const inner = focusedIn(el);
    expect(inner !== null && dialog?.contains(inner)).toBe(true);
    if (inner !== null) visited.add(inner);
  }
  expect(visited.size).toBeGreaterThanOrEqual(7);
  await userEvent.keyboard('{Escape}');
  await settled();
  expect(dialog?.open).toBe(false);
  expect(el.matches(':state(playing)')).toBe(true);
  expect(focusedIn(el)).toBe(menu.element());
  await playable(el);
});

it('passes preference changes to the game, including single-key shortcuts and reduced motion', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  expect(tallyProbe.preferences[0]).toMatchObject({ singleKeyShortcuts: true, sound: true });

  // A single-key shortcut works while it is on.
  stage(el)
    ?.shadowRoot?.querySelector<HTMLElement>('.tally-board')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
  await vi.waitFor(() => expect(boardText(el, '.scores')).toMatch(/: 1$/), WAIT);

  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('checkbox', { name: 'Single-key shortcuts' }).click();
  await page.getByRole('combobox', { name: 'Motion' }).selectOptions('reduce');
  await vi.waitFor(
    () => expect(tallyProbe.preferences.at(-1)).toMatchObject({ singleKeyShortcuts: false, reducedMotion: true }),
    WAIT,
  );

  // The frame drops its decorative motion too.
  expect(el.matches(':state(reduce-motion)')).toBe(true);
  const dialog = root(el).querySelector('dialog');
  if (dialog === null) throw new Error('no dialog');
  expect(
    getComputedStyle(dialog)
      .transitionDuration.split(',')
      .every((d) => d.trim() === '0s'),
  ).toBe(true);
  await page.getByRole('button', { name: 'Resume' }).click();
  await playable(el);
  expect(stage(el)?.shadowRoot?.querySelector('.tally-board')?.hasAttribute('data-reduced-motion')).toBe(true);

  // Off, the shortcut does nothing.
  stage(el)
    ?.shadowRoot?.querySelector<HTMLElement>('.tally-board')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
  await settled();
  expect(boardText(el, '.scores')).toMatch(/: 1$/);

  // The choice is stored: the next game starts with it.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await page.getByRole('button', { name: 'Start a new game' }).click();
  await playable(el);
  expect(tallyProbe.preferences.at(-1)).toMatchObject({ singleKeyShortcuts: false, reducedMotion: true });
});

it('follows a preference changed in another tab, in the game and in the frame (gp-d4v)', async () => {
  // A second storage over the same backend, on the same change hub, is the other tab.
  const hub = createMemoryChangeHub();
  const el = await mount(launcherGame(tallyManifest), GAMES, true, HOSTED, hub.feed());
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  expect(tallyProbe.preferences.at(-1)).toMatchObject({ reducedMotion: false, colorScheme: 'light' });
  const otherTab = openStorage({ backend, changes: hub.feed() });
  const { createBrowserIdentity } = await import('@joystyk/identity/browser');
  const player = await createBrowserIdentity(otherTab).current();
  await otherTab.player(player.id).preferences.update({ reducedMotion: 'reduce', theme: 'dark' });
  await vi.waitFor(
    () => expect(tallyProbe.preferences.at(-1)).toMatchObject({ reducedMotion: true, colorScheme: 'dark' }),
    WAIT,
  );
  await vi.waitFor(() => expect(el.matches(':state(reduce-motion)')).toBe(true), WAIT);
  // The menu shows the other tab's choice, and this tab doesn't write it back over a newer one.
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect.element(page.getByRole('combobox', { name: 'Motion' })).toHaveValue('reduce');
  otherTab.close();
});

/** The sRGB channels (0 to 1) of a computed color, read back from a one-pixel canvas. */
const srgbOf = (color: string): readonly [number, number, number] => {
  const pixel = document.createElement('canvas');
  pixel.width = 1;
  pixel.height = 1;
  const context = pixel.getContext('2d', { willReadFrequently: true });
  if (context === null) throw new Error('no 2D context');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
};

/** WCAG 2 contrast ratio between two CSS colors. */
const contrast = (a: string, b: string): number => {
  const luminance = (color: string): number => {
    const [r, g, b] = srgbOf(color).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
      number,
      number,
      number,
    ];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** Tally with the theme it had when its board was unreadable in dark mode: one light surface, no ink. */
const lightOnlyTally = { ...tallyManifest, theme: { accent: 'oklch(46% 0.15 145)', surface: 'oklch(96% 0.03 145)' } };

it.each([
  ['one light surface and no ink', lightOnlyTally],
  ['surfaces and inks for light and dark', tallyManifest],
])('keeps the canvas text readable in the light and dark schemes for a theme with %s', async (_, manifest) => {
  const games: GameLoaders = { 'test-tally': { entry: async () => ({ ...tallyEntry, manifest }) } };
  const el = await mount(launcherGame(manifest), games);
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  const canvas = stage(el)?.shadowRoot?.querySelector('.canvas');
  const section = board(el)?.querySelector('section');
  if (!(canvas instanceof HTMLElement) || !(section instanceof HTMLElement)) throw new Error('no board');

  const seen: { scheme: string; ink: string; surface: string }[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('combobox', { name: 'Game colors' }).selectOptions(scheme);
    await vi.waitFor(() => expect(getComputedStyle(section).colorScheme).toBe(scheme), WAIT);
    const style = getComputedStyle(section);
    seen.push({ scheme, ink: style.color, surface: style.backgroundColor });
    // WCAG AA for body text; the old fallback, CanvasText on this surface, measured about 1.1 in dark.
    expect(
      contrast(style.color, style.backgroundColor),
      `${scheme}: ${style.color} on ${style.backgroundColor}`,
    ).toBeGreaterThanOrEqual(4.5);
    // The canvas's own text, outside the game's board, is readable on the same surface.
    expect(contrast(getComputedStyle(canvas).color, getComputedStyle(canvas).backgroundColor)).toBeGreaterThanOrEqual(
      4.5,
    );
    await page.getByRole('button', { name: 'Resume' }).click();
    await playable(el);
  }
  // A single surface keeps one ink in both schemes; a pair changes both together.
  const [light, dark] = seen;
  expect(light?.surface === dark?.surface).toBe(manifest === lightOnlyTally);
  expect(light?.ink === dark?.ink).toBe(manifest === lightOnlyTally);
});

it('animates the overlay only when motion is allowed', async () => {
  const el = await mount();
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await playable(el);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('combobox', { name: 'Motion' }).selectOptions('no-preference');
  await settled();
  const dialog = root(el).querySelector('dialog');
  if (dialog === null) throw new Error('no dialog');
  expect(el.matches(':state(allow-motion)')).toBe(true);
  expect(
    getComputedStyle(dialog)
      .transitionDuration.split(',')
      .some((d) => d.trim() !== '0s'),
  ).toBe(true);
});

it('says so when the page provides no services or the game is unknown', async () => {
  await mount(launcherGame(tallyManifest), GAMES, false);
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByRole('heading', { name: "The game couldn't start" })).toBeVisible();
  document.body.replaceChildren();

  const other = await mount(launcherGame(tallyManifest), {});
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await expect.element(page.getByText("This game isn't available here yet.")).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeVisible();
  expect(other.matches(':state(live)')).toBe(true);
});

it('starts games that implement Layer 1 themselves', async () => {
  const disposed: string[] = [];
  const games: GameLoaders = {
    'test-tally': {
      entry: async () => ({
        manifest: tallyManifest,
        load: async () => ({
          migrations: [],
          createSession: (context) => {
            const snapshot = {
              meta: {
                connection: 'local' as const,
                seat: 0,
                revision: 0,
                seats: context.seats,
                outcome: null,
                safePoint: true,
                notice: null,
              },
            };
            return {
              get: () => snapshot,
              subscribe: (listener: (s: typeof snapshot) => void) => {
                listener(snapshot);
                return () => {};
              },
              dispatch: () => {},
              dispose: () => disposed.push('session'),
            };
          },
          mount: (slot: HTMLElement, session) => {
            const p = document.createElement('p');
            p.className = 'layer-one';
            p.textContent = `Hello, ${session.get().meta.seats[0]?.name ?? ''}`;
            slot.append(p);
            return { dispose: () => disposed.push('mount') };
          },
        }),
      }),
    },
  };
  const el = await mount(launcherGame(tallyManifest), games);
  await page.getByRole('button', { name: 'Start Tally' }).click();
  await vi.waitFor(
    () => expect(stage(el)?.shadowRoot?.querySelector('.layer-one')?.textContent).toMatch(/^Hello, \w+/),
    WAIT,
  );
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Save and exit' }).click();
  await settled();
  expect(disposed).toEqual(['mount', 'session']);
});

it('awaits and disposes asynchronous preparation, including cancellation before a late reply', async () => {
  for (const cancel of [false, true]) {
    tallyProbe.reset();
    backend = createMemoryBackend();
    let resolve!: (result: Result<Json>) => void;
    const disposed = vi.fn(),
      prepare = vi.fn(
        () =>
          new Promise<Result<Json>>((done) => {
            resolve = done;
          }),
      );
    const entry = {
      ...tallyEntry,
      loadAsyncPreparer: async () => ({ setup: tallyEngine.schemas.config, prepare, dispose: disposed }),
    };
    const el = await mount(launcherGame(tallyManifest), { 'test-tally': { entry: async () => entry } });
    await expect.element(page.getByRole('button', { name: 'Start Tally' })).toBeEnabled();
    await page.getByRole('button', { name: 'Start Tally' }).click();
    await expect.poll(() => prepare.mock.calls.length).toBe(1);
    expect(tallyProbe.mounts).toBe(0);
    if (cancel) {
      el.remove();
      await expect.poll(() => disposed.mock.calls.length).toBe(1);
    }
    resolve(ok({ target: 3 }));
    if (!cancel) {
      await expect.poll(() => board(el)).not.toBeNull();
      expect(disposed).toHaveBeenCalledTimes(1);
      el.remove();
    } else {
      await settled();
      expect(tallyProbe.mounts).toBe(0);
    }
  }
});
