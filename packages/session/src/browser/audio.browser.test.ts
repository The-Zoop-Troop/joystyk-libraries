import type { Preferences } from '@joystyk/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createGameAudio, type AudioEnvironment } from './audio.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  document.body.replaceChildren();
});
const setup = (defer = false) => {
  let preferences: Preferences = {
    sound: true,
    volume: 0.8,
    reducedMotion: false,
    singleKeyShortcuts: true,
    colorScheme: 'light',
    locale: 'en',
  };
  let listener: ((p: Preferences) => void) | null = null;
  let made = 0,
    played = 0,
    stopped = 0,
    closed = 0,
    suspended = 0;
  let state = 'suspended';
  const gains: number[] = [];
  let resume: (() => void) | null = null;
  const node = () => ({
    connect: () => {},
    disconnect: () => {},
    gain: {
      setValueAtTime: (n: number) => {
        gains.push(n);
      },
      linearRampToValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {},
    },
  });
  const context = {
    get state() {
      return state;
    },
    currentTime: 1,
    destination: {},
    createGain: node,
    resume: () =>
      defer
        ? new Promise<void>((resolve) => {
            resume = () => {
              state = 'running';
              resolve();
            };
          })
        : ((state = 'running'), Promise.resolve()),
    suspend: () => {
      suspended += 1;
      state = 'suspended';
      return Promise.resolve();
    },
    close: () => {
      closed += 1;
      state = 'closed';
      return Promise.resolve();
    },
    createOscillator: () => ({
      connect: () => {},
      disconnect: () => {},
      type: 'sine',
      onended: null,
      frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      start: () => {
        played += 1;
      },
      stop: () => {
        stopped += 1;
      },
    }),
  };
  const doc = {
    hidden: false,
    addEventListener: document.addEventListener.bind(document),
    removeEventListener: document.removeEventListener.bind(document),
    dispatchEvent: document.dispatchEvent.bind(document),
  } as EventTarget & { hidden: boolean };
  const audio = createGameAudio(
    {
      get: () => preferences,
      subscribe: (f) => {
        listener = f;
        return () => {
          listener = null;
        };
      },
    },
    'letter-drop',
    {
      document: doc,
      window,
      createContext: () => {
        made += 1;
        return context as unknown as AudioContext;
      },
    } satisfies AudioEnvironment,
  );
  cleanup.push(() => audio.dispose());
  const button = document.createElement('button');
  button.textContent = 'Play a word';
  document.body.append(button);
  return {
    audio,
    button,
    doc,
    preference: (p: Partial<Preferences>) => {
      preferences = { ...preferences, ...p };
      listener?.(preferences);
    },
    ready: () => resume?.(),
    counts: () => ({ made, played, stopped, closed, suspended, gains, subscribed: listener !== null }),
  };
};

describe('shared browser audio lifecycle', () => {
  it('waits for a trusted gesture, follows live volume/mute and stops every active voice on disposal', async () => {
    const s = setup();
    s.audio.play('move');
    await Promise.resolve();
    expect(s.counts().made).toBe(0);
    s.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    s.audio.play('move');
    await Promise.resolve();
    expect(s.counts().made).toBe(0);
    await userEvent.click(s.button);
    s.audio.play('move');
    await expect.poll(() => s.counts().played).toBe(1);
    s.preference({ volume: 0.25 });
    expect(s.counts().gains).toContain(0.25);
    s.preference({ sound: false });
    expect(s.counts().stopped).toBeGreaterThan(1);
    s.audio.play('success');
    await Promise.resolve();
    expect(s.counts().played).toBe(1);
    s.preference({ sound: true, volume: 0 });
    s.audio.play('move');
    await Promise.resolve();
    expect(s.counts().played).toBe(1);
    s.preference({ volume: 0.7 });
    await Promise.resolve();
    expect(s.counts().played).toBe(1);
    s.audio.play('clear');
    await expect.poll(() => s.counts().played).toBe(2);
    s.audio.dispose();
    s.audio.dispose();
    s.audio.play('level');
    await Promise.resolve();
    expect(s.counts()).toMatchObject({ played: 2, closed: 1, subscribed: false });
  });
  it('does not play a pending resume after mute, or revive a disposed context', async () => {
    const s = setup(true);
    await userEvent.click(s.button);
    s.audio.play('clear');
    s.preference({ sound: false });
    s.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.counts().played).toBe(0);
    s.audio.dispose();
    s.audio.play('success');
    expect(s.counts().closed).toBe(1);
    const second = setup(true);
    await userEvent.click(second.button);
    second.audio.play('capture');
    second.audio.dispose();
    second.ready();
    await Promise.resolve();
    await Promise.resolve();
    expect(second.counts()).toMatchObject({ played: 0, closed: 1 });
  });
  it('silences on hide/pagehide and never queues hidden effects for a later return', async () => {
    const s = setup();
    await userEvent.click(s.button);
    s.audio.play('move');
    await expect.poll(() => s.counts().played).toBe(1);
    s.doc.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    s.audio.play('level');
    await Promise.resolve();
    expect(s.counts().played).toBe(1);
    s.doc.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(s.counts().played).toBe(1);
    s.audio.play('clear');
    await expect.poll(() => s.counts().played).toBe(2);
    window.dispatchEvent(new Event('pagehide'));
    expect(s.counts().suspended).toBeGreaterThan(0);
  });
  it('bounds dense celebratory effects and leaves unsupported audio harmless', async () => {
    const s = setup();
    await userEvent.click(s.button);
    for (let n = 0; n < 30; n += 1) s.audio.play('success');
    await Promise.resolve();
    await Promise.resolve();
    expect(s.counts().played).toBeGreaterThan(0);
    expect(s.counts().played).toBeLessThanOrEqual(16);
    const audio = createGameAudio(
      {
        get: () => ({
          sound: true,
          volume: 1,
          reducedMotion: false,
          singleKeyShortcuts: true,
          colorScheme: 'light',
          locale: 'en',
        }),
        subscribe: () => () => {},
      },
      'greed',
      {
        document,
        window,
        createContext: () => {
          throw new Error('No audio device');
        },
      },
    );
    cleanup.push(() => audio.dispose());
    await userEvent.click(s.button);
    audio.play('dice');
    await Promise.resolve();
    audio.dispose();
  });
});
