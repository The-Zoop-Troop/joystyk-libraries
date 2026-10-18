import type { AnyGameSession, AudioApi, PlatformApi, Validator } from '@joystyk/contracts';
import { decode, isRecord } from '../values.ts';
import { CUSTOM_AUDIO_GAMES, SOUND_PROFILES, eventCue, tonesFor, type SoundFamily } from './audio-sounds.ts';

export interface GameAudioService extends AudioApi {
  dispose(): void;
}
/** Browser ports are injectable so lifecycle races can be checked without pretending to hear sound. */
export type AudioEnvironment = {
  readonly document: EventTarget & { readonly hidden: boolean };
  readonly window: EventTarget;
  createContext(): AudioContext;
};

/** One context per mounted game. Muting never queues sounds for a later unmute. */
export const createGameAudio = (
  preferences: PlatformApi['preferences'],
  gameId: string,
  environment: AudioEnvironment = { document, window, createContext: () => new AudioContext() },
): GameAudioService => {
  const family: SoundFamily = SOUND_PROFILES[gameId] ?? 'wood';
  const { document: doc, window: win } = environment;
  let disposed = false,
    unlocked = false,
    context: AudioContext | null = null,
    master: GainNode | null = null;
  let resuming: Promise<void> | null = null,
    epoch = 0,
    windowStart = -Infinity,
    count = 0;
  const voices = new Map<OscillatorNode, GainNode>();
  const permitted = (): boolean => {
    const p = preferences.get();
    return !disposed && !doc.hidden && p.sound && Number.isFinite(p.volume) && p.volume > 0;
  };
  const silence = (): void => {
    epoch += 1;
    for (const [oscillator, gain] of voices) {
      oscillator.onended = null;
      try {
        oscillator.stop();
      } catch {
        /* Already finished. */
      }
      oscillator.disconnect();
      gain.disconnect();
    }
    voices.clear();
    if (context?.state === 'running') void context.suspend().catch(() => {});
  };
  const applyPreferences = (): void => {
    if (!permitted()) {
      silence();
      return;
    }
    if (context !== null && master !== null)
      master.gain.setValueAtTime(Math.max(0, Math.min(1, preferences.get().volume)), context.currentTime);
  };
  const wake = (): Promise<void> => {
    if (!unlocked || !permitted()) return Promise.resolve();
    try {
      if (context === null) {
        context = environment.createContext();
        master = context.createGain();
        master.connect(context.destination);
        applyPreferences();
      }
      if (context.state === 'suspended') {
        resuming ??= context
          .resume()
          .then(() => {
            if (!permitted()) silence();
          })
          .catch(() => {})
          .finally(() => {
            resuming = null;
          });
        return resuming;
      }
    } catch {
      /* Unsupported audio and autoplay refusal leave the game playable. */
    }
    return Promise.resolve();
  };
  const gesture = (event: Event): void => {
    if (
      !event.isTrusted ||
      (event instanceof KeyboardEvent && (event.repeat || event.ctrlKey || event.metaKey || event.altKey))
    )
      return;
    unlocked = true;
    void wake();
  };
  const hidden = (): void => {
    if (doc.hidden) silence();
  };
  doc.addEventListener('pointerdown', gesture, { capture: true });
  doc.addEventListener('keydown', gesture, { capture: true });
  doc.addEventListener('visibilitychange', hidden);
  win.addEventListener('pagehide', silence);
  win.addEventListener('blur', silence);
  const unsubscribe = preferences.subscribe(applyPreferences);

  return {
    play: (cue, variation = 0) => {
      if (!unlocked || !permitted()) return;
      const requestedAt = epoch;
      void wake().then(() => {
        const ctx = context,
          bus = master;
        if (requestedAt !== epoch || !permitted() || ctx === null || bus === null || ctx.state !== 'running') return;
        // Dense cascades and catch-up frames remain gentle, bounded effects.
        if (ctx.currentTime - windowStart >= 0.1) {
          windowStart = ctx.currentTime;
          count = 0;
        }
        if (count >= 8) return;
        const tones = tonesFor(family, cue, variation);
        if (voices.size + tones.length > 16) return;
        count += 1;
        try {
          for (const tone of tones) {
            const oscillator = ctx.createOscillator(),
              gain = ctx.createGain(),
              now = ctx.currentTime + tone.delay;
            oscillator.type = tone.wave;
            oscillator.frequency.setValueAtTime(tone.from, now);
            oscillator.frequency.exponentialRampToValueAtTime(tone.to, now + tone.duration);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.linearRampToValueAtTime(tone.strength, now + 0.004);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.duration);
            oscillator.connect(gain);
            gain.connect(bus);
            voices.set(oscillator, gain);
            oscillator.onended = () => {
              voices.delete(oscillator);
              oscillator.disconnect();
              gain.disconnect();
            };
            oscillator.start(now);
            oscillator.stop(now + tone.duration + 0.01);
          }
        } catch {
          /* An audio-device change must not turn a harmless effect into a game error. */
        }
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      silence();
      unsubscribe();
      doc.removeEventListener('pointerdown', gesture, { capture: true });
      doc.removeEventListener('keydown', gesture, { capture: true });
      doc.removeEventListener('visibilitychange', hidden);
      win.removeEventListener('pagehide', silence);
      win.removeEventListener('blur', silence);
      master?.disconnect();
      master = null;
      const closing = context;
      context = null;
      if (closing !== null && closing.state !== 'closed') void closing.close().catch(() => {});
    },
  };
};

type AudioSnapshot = {
  readonly revision: number;
  readonly paused: boolean;
  readonly types: readonly string[];
  readonly outcome: string | null;
  readonly refused: boolean;
};
/** A narrow Standard Schema projection: game-specific schemas already validated the public events. */
const audioSnapshot: Validator<AudioSnapshot> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) => {
      const invalid = { issues: [{ message: 'Invalid audio snapshot.' }] };
      if (!isRecord(raw) || !isRecord(raw['meta'])) return invalid;
      const meta = raw['meta'],
        revision = meta['revision'];
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return invalid;
      const types: string[] = [];
      for (const event of Array.isArray(raw['events']) ? raw['events'] : []) {
        if (!isRecord(event)) return invalid;
        const type = event['type'] ?? event['_tag'];
        if (typeof type !== 'string') return invalid;
        types.push(type);
      }
      for (const beat of Array.isArray(raw['beats']) ? raw['beats'] : []) {
        if (!isRecord(beat) || !isRecord(beat['event'])) return invalid;
        const type = beat['event']['type'] ?? beat['event']['_tag'];
        if (typeof type !== 'string') return invalid;
        types.push(type);
      }
      const outcome =
        isRecord(meta['outcome']) && typeof meta['outcome']['result'] === 'string' ? meta['outcome']['result'] : null;
      return {
        value: {
          revision,
          paused: raw['paused'] === true,
          types,
          outcome,
          refused: meta['notice'] !== null && meta['notice'] !== undefined,
        },
      };
    },
  },
};

/** The frame's generic game sound path. Games with local sound controls keep their own driver. */
export const watchGameAudio = (session: AnyGameSession, platform: PlatformApi, gameId: string): (() => void) => {
  if (platform.audio === undefined || CUSTOM_AUDIO_GAMES.has(gameId)) return () => {};
  let previous: AudioSnapshot | null = null;
  return session.subscribe((raw) => {
    const parsed = decode(audioSnapshot, raw, 'sound snapshot');
    if (!parsed.ok) return;
    const next = parsed.value,
      before = previous;
    previous = next;
    // Restored snapshots and repeated presentation/notice snapshots are silent.
    if (before === null || next.revision <= before.revision || next.paused) return;
    const cues = next.types.flatMap((type) => {
      const cue = eventCue(gameId, type);
      return cue === null ? [] : [cue];
    });
    if (next.outcome !== null && before.outcome === null && !cues.some((cue) => cue === 'success' || cue === 'lose'))
      cues.push(next.outcome === 'lost' || next.outcome === 'abandoned' ? 'lose' : 'success');
    for (const cue of cues.slice(0, 8)) platform.audio?.play(cue);
  });
};
