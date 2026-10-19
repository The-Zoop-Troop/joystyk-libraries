import { defineSimulation, ok, type PlatformApi } from '@joystyk/contracts';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { mountArcade, type ArcadeView } from './game.ts';

it('shows graphics notices only while they contain a message', async () => {
  const view: ArcadeView = { phase: 'ready', pace: 'standard', daily: false, course: 0 };
  const simulation = defineSimulation({
    rulesVersion: 1,
    stepHz: 60,
    schemas: { config: z.object({}), state: z.object({}), input: z.never(), event: z.never() },
    init: () => ok({}),
    step: (state) => ({ state, events: [] }),
    view: () => view,
    outcome: () => null,
  });
  const snapshot = {
    view,
    tick: 0,
    paused: false,
    events: [],
    meta: {
      connection: 'local' as const,
      seat: 0,
      revision: 0,
      seats: [],
      outcome: null,
      safePoint: true,
      notice: null,
    },
  };
  const session = {
    get: () => snapshot,
    subscribe(listener: (value: typeof snapshot) => void) {
      listener(snapshot);
      return () => {};
    },
    dispatch: () => {},
    dispose: () => {},
    alpha: () => 1,
  };
  const platform: PlatformApi = {
    storage: { get: async () => null, set: async () => {}, delete: async () => {} },
    preferences: {
      get: () => ({
        reducedMotion: false,
        sound: false,
        volume: 0,
        colorScheme: 'dark',
        locale: 'en',
        singleKeyShortcuts: true,
      }),
      subscribe: () => () => {},
    },
    announce: () => {},
    requestExit: () => {},
  };
  const slot = document.createElement('div');
  document.body.append(slot);
  let notice: HTMLParagraphElement | undefined;
  const mounted = mountArcade(slot, session, platform, {
    gameId: 'notice-fixture',
    title: 'Graphics notice fixture',
    help: 'A renderer supplies its graphics status as a paragraph.',
    simulation,
    score: () => 0,
    status: () => 'Ready',
    action: () => [],
    gesture: 'tap',
    render: async (host) => {
      notice = document.createElement('p');
      host.append(notice);
      return { draw() {}, graphics() {}, dispose() {} };
    },
  });
  try {
    await expect.poll(() => notice).toBeDefined();
    const message = notice!;
    for (const scheme of ['light', 'dark']) {
      slot.style.colorScheme = scheme;
      expect(getComputedStyle(message).display).toBe('none');
      expect(message.getBoundingClientRect().height).toBe(0);
      message.textContent = 'Graphics interrupted. Your game is paused.';
      expect(getComputedStyle(message).display).not.toBe('none');
      expect(message.getBoundingClientRect().height).toBeGreaterThan(0);
      message.textContent = '';
      expect(getComputedStyle(message).display).toBe('none');
    }
  } finally {
    mounted.dispose();
    slot.remove();
  }
});
