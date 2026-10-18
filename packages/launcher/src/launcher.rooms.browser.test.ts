// Online with friends in real Chromium: the real launcher, stage and remote session against
// the real room core running in the page (`__tests__/loopback-room.ts`), playing Tally. The
// host creates a room, sees the invite, fills a seat with the computer, readies, starts, plays
// to the results over the board, offers a rematch (the computer accepts) and leaves; a guest
// joins from an invite with a spectator watching and accepts the host's rematch; and a guest asks
// to end a match, withdraws, is declined, then ends it with the host's accept (D-61). apps/site's
// rooms.e2e.test.ts plays the same flow on real servers.
import { defineDriver, settled } from '@gyral/core';
import type { AnyDiscreteEngine } from '@joystyk/contracts';
import { createMemoryBackend, openStorage } from '@joystyk/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@joystyk/ui/tokens.css';
import { loopbackRoom } from './__tests__/loopback-room.ts';
import {
  createLauncherServices,
  provideLauncherServices,
  type GameLoaders,
  type RoomServices,
} from './browser/index.ts';
import { tallyEngine, tallyEntry, tallyManifest } from './fixture/index.ts';
import { Launcher } from './launcher.ts';
import { launcherGame, type OnlineRooms } from './model.ts';

const GAMES: GameLoaders = { 'test-tally': { entry: async () => tallyEntry } };
const engine = tallyEngine as unknown as AnyDiscreteEngine;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

type Launched = InstanceType<typeof Launcher>;

/** Mounts a launcher whose room services are the loopback, with the URL and clipboard drivers faked. */
const mount = async (rooms: RoomServices, invite: string | null = null, aiContent = false) => {
  const urls: (string | null)[] = [];
  const container = document.createElement('main');
  document.body.append(container);
  const backend = createMemoryBackend();
  const games: GameLoaders = aiContent
    ? { 'test-tally': { entry: async () => ({ ...tallyEntry, manifest: { ...tallyManifest, aiContent: true } }) } }
    : GAMES;
  provideLauncherServices(
    container,
    createLauncherServices({
      games,
      openStorage: async (onNotice) => openStorage({ backend, onNotice }),
      aiDelayMs: 0,
      rooms,
    }),
  );
  const el = new Launcher();
  el.game = { ...launcherGame(tallyManifest), aiContent };
  el.drivers = {
    'launcher-online-rooms': defineDriver<undefined, OnlineRooms>({
      name: 'launcher-online-rooms',
      run: () => ({ _tag: 'Hosted', games: ['test-tally'], protocol: 1 }),
    }),
    'launcher-invite': defineDriver<undefined, string | null>({ name: 'launcher-invite', run: () => invite }),
    'launcher-room-url': defineDriver<string | null, void>({
      name: 'launcher-room-url',
      run: (code) => void urls.push(code),
    }),
    'launcher-clipboard': defineDriver<string, void>({ name: 'launcher-clipboard', run: () => {} }),
  };
  container.append(el);
  await settled();
  return { el, urls };
};

const root = (el: Launched): ShadowRoot => {
  if (el.shadowRoot === null) throw new Error('no shadow root');
  return el.shadowRoot;
};
const board = (el: Launched) =>
  root(el).querySelector('jy-game-stage')?.shadowRoot?.querySelector('.tally-board')?.shadowRoot ?? null;

/** The polite live region's text, and the offer line in the results or the bar. */
const polite = (el: Launched): string => root(el).querySelector('[aria-live="polite"]')?.textContent?.trim() ?? '';
const offerLine = (el: Launched, selector: '.offer-state' | '.offer-text'): string =>
  root(el).querySelector(selector)?.textContent?.trim() ?? '';

const add = async (el: Launched, amount: 1 | 2) => {
  await vi.waitFor(() =>
    expect(board(el)?.querySelector<HTMLButtonElement>('[data-amount="2"]')?.disabled).toBe(false),
  );
  board(el)
    ?.querySelector<HTMLButtonElement>(`[data-amount="${String(amount)}"]`)
    ?.click();
  await settled();
};

it('creates a room, fills a seat with the computer, plays to the results, offers a rematch the computer accepts, and leaves', async () => {
  const loop = loopbackRoom(engine, tallyManifest);
  cleanups.push(loop.dispose);
  const { el, urls } = await mount(loop.rooms);
  await page.getByRole('radio', { name: 'Online with friends' }).click();
  await expect.element(page.getByRole('textbox', { name: 'Room code or invite link' })).toBeVisible();
  await page.getByRole('button', { name: 'Create a room' }).click();

  await expect.element(page.getByRole('heading', { name: 'Tally room K7M 2QX' })).toBeVisible();
  await vi.waitFor(() => expect(root(el).activeElement?.id).toBe('lobby-title'));
  await expect
    .element(page.getByRole('textbox', { name: 'Invite link' }))
    .toHaveValue('https://joystyk.test/games/test-tally?room=K7M2QX');
  expect(urls).toEqual(['K7M2QX']);
  await expect.element(page.getByRole('button', { name: 'Start the match' })).toBeDisabled();
  await expect
    .element(page.getByText('Waiting for another player. Share the link, or add the computer.'))
    .toBeVisible();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect.element(page.getByText('Invite link copied.')).toBeInTheDocument();

  await page.getByRole('button', { name: 'Add the computer to seat 2' }).click();
  await expect.element(page.getByText('the computer, easy')).toBeVisible();
  await expect.element(page.getByText('Waiting for', { exact: false })).toBeVisible();
  const ready = page.getByRole('button', { name: 'Ready' });
  await expect.element(ready).toHaveAttribute('aria-pressed', 'false');
  await ready.click();
  await expect.element(ready).toHaveAttribute('aria-pressed', 'true');
  await expect.element(page.getByText('Everyone is ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Start the match' }).click();

  // The computer adds 1 a turn; 2 + 2 + 1 reaches 5 first.
  await add(el, 2);
  await add(el, 2);
  await add(el, 1);
  await expect.element(page.getByRole('heading', { name: 'You won!' })).toBeVisible();
  expect(root(el).querySelector('jy-game-stage')?.inert).toBe(true);
  expect(offerLine(el, '.offer-state')).toBe('Any player can offer a rematch. It starts when everyone accepts.');
  // The computer accepts at once, so the rematch starts.
  await page.getByRole('button', { name: 'Offer a rematch' }).click();
  await vi.waitFor(() => expect(root(el).querySelector('#results-title')).toBeNull());
  await vi.waitFor(() => expect(board(el)?.querySelector('[data-amount="1"]')).not.toBeNull());

  await page.getByRole('button', { name: 'Menu' }).click();
  await expect.element(page.getByText('The match goes on while this menu is open.')).toBeVisible();
  await page.getByRole('button', { name: 'Leave room' }).click();
  await expect.element(page.getByRole('button', { name: 'Create a room' })).toBeVisible();
  expect(urls).toEqual(['K7M2QX', null]);
});

it('joins from an invite as a guest, with a spectator watching, and plays the host to the end', async () => {
  const loop = loopbackRoom(engine, tallyManifest);
  cleanups.push(loop.dispose);
  const ana = await loop.hostedBy('Ana');
  cleanups.push(() => ana.dispose());
  await vi.waitFor(() => expect(ana.get().meta.connection).toBe('online'));
  const { el } = await mount(loop.rooms, 'K7M2QX');

  await expect.element(page.getByRole('radio', { name: 'Online with friends' })).toBeChecked();
  await expect.element(page.getByRole('textbox', { name: 'Room code or invite link' })).toHaveValue('K7M2QX');
  await vi.waitFor(() => expect(root(el).activeElement?.textContent).toBe('Join room'));
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect.element(page.getByRole('heading', { name: 'Tally room K7M 2QX' })).toBeVisible();
  await expect.element(page.getByText('host · not ready')).toBeVisible();
  await expect.element(page.getByText('The host starts the match once everyone is ready.')).toBeVisible();
  expect(root(el).querySelector('.start-match')).toBeNull();

  const cy = loop.player('Cy', true);
  cleanups.push(() => cy.dispose());
  await expect.element(page.getByText('1 person is watching.')).toBeVisible();

  await page.getByRole('button', { name: 'Ready' }).click();
  await vi.waitFor(() => expect(ana.get().room?.seats[1]?.ready).toBe(true));
  ana.dispatch({ kind: 'control', control: { kind: 'ready', ready: true } });
  await vi.waitFor(() => expect(ana.get().room?.seats[0]?.ready).toBe(true));
  ana.dispatch({ kind: 'control', control: { kind: 'start' } });
  await vi.waitFor(() => expect(cy.get().view).not.toBeNull());

  // Ana moves first and adds 1; the guest adds 2 and wins on the third move.
  for (let turn = 0; turn < 3; turn += 1) {
    await vi.waitFor(() => expect(ana.get().pending).toEqual([0]));
    ana.dispatch({ kind: 'command', command: { type: 'add', amount: 1 } });
    await add(el, 2);
  }
  await expect.element(page.getByRole('heading', { name: 'You won!' })).toBeVisible();
  await vi.waitFor(() => expect(cy.get().meta.outcome?.placements.find((p) => p.place === 1)?.seat).toBe(1));

  // The host offers a rematch: the guest hears it, sees how to answer, and accepts.
  ana.dispatch({ kind: 'control', control: { kind: 'offer', offer: 'rematch' } });
  await vi.waitFor(() => expect(offerLine(el, '.offer-state')).toBe('Ana offers a rematch.'));
  expect(polite(el)).toBe('Ana offers a rematch.');
  await expect.element(page.getByRole('button', { name: 'Decline the rematch' })).toBeVisible();
  expect(root(el).querySelector('.offer-rematch')).toBeNull();
  await page.getByRole('button', { name: 'Accept the rematch' }).click();
  await vi.waitFor(() => expect(root(el).querySelector('#results-title')).toBeNull());
  await vi.waitFor(() => expect(ana.get().room?.match).toBe(2));
  expect(ana.get().room?.offer).toBeNull();
});

it('asks to end a match from the menu, withdraws, is declined, then ends it with no result when the host accepts', async () => {
  const loop = loopbackRoom(engine, tallyManifest);
  cleanups.push(loop.dispose);
  const ana = await loop.hostedBy('Ana');
  cleanups.push(() => ana.dispose());
  await vi.waitFor(() => expect(ana.get().meta.connection).toBe('online'));
  const { el } = await mount(loop.rooms, 'K7M2QX');
  await vi.waitFor(() => expect(root(el).activeElement?.textContent).toBe('Join room'));
  await page.getByRole('button', { name: 'Join room' }).click();
  await page.getByRole('button', { name: 'Ready' }).click();
  await vi.waitFor(() => expect(ana.get().room?.seats[1]?.ready).toBe(true));
  ana.dispatch({ kind: 'control', control: { kind: 'ready', ready: true } });
  await vi.waitFor(() => expect(ana.get().room?.seats[0]?.ready).toBe(true));
  ana.dispatch({ kind: 'control', control: { kind: 'start' } });
  await vi.waitFor(() => expect(board(el)?.querySelector('[data-amount="1"]')).not.toBeNull());

  const ask = async () => {
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect
      .element(page.getByText('It ends with no result if the others agree, or if nobody declines within a minute.'))
      .toBeVisible();
    await page.getByRole('button', { name: 'Ask to end the match' }).click();
    await vi.waitFor(() => expect(ana.get().room?.offer).toMatchObject({ kind: 'end', by: 1, status: 'open' }));
    await vi.waitFor(() =>
      expect(offerLine(el, '.offer-text')).toMatch(
        /^You asked to end the match\. It ends in [01]:\d\d unless someone declines\.$/,
      ),
    );
    expect(polite(el)).toBe('You asked to end the match.');
  };
  const answer = (kind: 'accept' | 'decline') =>
    ana.dispatch({ kind: 'control', control: { kind, offer: ana.get().room?.offer?.id ?? -1 } });

  await ask();
  await expect.element(page.getByRole('group', { name: 'Offer to end the match' })).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw the offer' }).click();
  await vi.waitFor(() => expect(offerLine(el, '.offer-text')).toBe('You withdrew your offer to end the match.'));
  await vi.waitFor(() => expect(ana.get().room?.offer?.status).toBe('withdrawn'));

  await ask();
  answer('decline');
  await vi.waitFor(() => expect(offerLine(el, '.offer-text')).toBe('Ana declined to end the match.'));
  expect(polite(el)).toBe('Ana declined to end the match.');
  expect(ana.get().room?.phase).toBe('playing');

  await ask();
  answer('accept');
  await expect.element(page.getByRole('heading', { name: 'Game over' })).toBeVisible();
  expect(root(el).querySelector('.results .summary')?.textContent).toBe('The players agreed to end the match early.');
  await vi.waitFor(() => expect(ana.get().meta.outcome?.result).toBe('abandoned'));
});

it('explains a code that is malformed or names no room', async () => {
  const loop = loopbackRoom(engine, tallyManifest);
  cleanups.push(loop.dispose);
  await mount(loop.rooms);
  await page.getByRole('radio', { name: 'Online with friends' }).click();
  await page.getByRole('textbox', { name: 'Room code or invite link' }).fill('nope');
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect
    .element(page.getByText('Enter the six-character code from the invite, or paste the invite link.'))
    .toBeVisible();
  await expect
    .element(page.getByRole('textbox', { name: 'Room code or invite link' }))
    .toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'Room code or invite link' }).fill('ABC-DEF');
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect.element(page.getByText('No room has that code. Check it, or ask for a new link.')).toBeVisible();
});

it('opens the lobby after the AI-content notice for a game that needs it', async () => {
  const loop = loopbackRoom(engine, tallyManifest);
  cleanups.push(loop.dispose);
  await mount(loop.rooms, null, true);
  await page.getByRole('radio', { name: 'Online with friends' }).click();
  await page.getByRole('button', { name: 'Create a room' }).click();
  await expect.element(page.getByRole('heading', { name: 'This game uses AI-made content' })).toBeVisible();
  await page.getByRole('button', { name: 'Accept and play' }).click();
  await expect.element(page.getByRole('heading', { name: 'Tally room K7M 2QX' })).toBeVisible();
});
