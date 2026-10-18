import type { AnyGameSession, PlatformApi, SoundCue } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { SOUND_PROFILES, eventCue, tonesFor } from './audio-sounds.ts';
import { watchGameAudio } from './audio.ts';

describe('game sound selection', () => {
  it('has a deliberate sound palette for every registered game and safe original tones', () => {
    expect(Object.keys(SOUND_PROFILES)).toHaveLength(70);
    for (const family of Object.values(SOUND_PROFILES))
      for (const cue of ['move', 'card', 'clear', 'success', 'lose', 'level', 'dice', 'trace', 'water'] as const)
        for (const tone of tonesFor(family, cue, Infinity)) {
          expect(tone.from).toBeGreaterThan(0);
          expect(tone.to).toBeGreaterThan(0);
          expect(tone.duration).toBeLessThan(0.4);
          expect(tone.strength).toBeLessThan(0.1);
        }
    expect(eventCue('crossword', 'cleared')).toBe('tick');
    expect(eventCue('containment', 'sealed')).toBe('capture');
    expect(eventCue('shift-23', 'Dice')).toBe('dice');
    expect(eventCue('greed', 'renamed')).toBeNull();
    expect(eventCue('chess', 'seat')).toBeNull();
  });
  it('uses only new public events, stays silent on restore/repeated or malformed snapshots and removes subscriptions', () => {
    const port: { listener: ((raw: unknown) => void) | null } = { listener: null };
    const first = { meta: { revision: 4, outcome: null, notice: null }, beats: [{ event: { type: 'placed' } }] };
    const session = {
      get: () => first,
      subscribe: (f: (raw: unknown) => void) => {
        port.listener = f;
        f(first);
        return () => {
          port.listener = null;
        };
      },
      dispatch: () => {},
      dispose: () => {},
    } as unknown as AnyGameSession;
    const cues: SoundCue[] = [];
    const platform = {
      audio: {
        play: (cue: SoundCue) => {
          cues.push(cue);
        },
      },
    } as PlatformApi;
    const stop = watchGameAudio(session, platform, 'tic-tac-toe');
    expect(cues).toEqual([]);
    port.listener?.({ meta: { revision: 5, outcome: null, notice: null }, beats: [{ event: { type: 'placed' } }] });
    port.listener?.({ meta: { revision: 5, outcome: null, notice: null }, beats: [{ event: { type: 'placed' } }] });
    port.listener?.({ meta: { revision: 6, outcome: null, notice: null }, beats: [{ event: { type: 99 } }] });
    port.listener?.({ meta: { revision: 7, outcome: null, notice: null }, paused: true, events: [{ type: 'placed' }] });
    port.listener?.({
      meta: { revision: 8, outcome: { result: 'won' }, notice: null },
      beats: [{ event: { type: 'won' } }],
    });
    expect(cues).toEqual(['move', 'success']);
    stop();
    stop();
    expect(port.listener).toBeNull();
    expect(watchGameAudio(session, platform, 'circuit-84')()).toBeUndefined();
    expect(port.listener).toBeNull();
  });
});
