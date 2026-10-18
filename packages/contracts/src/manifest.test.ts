import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  defineManifest,
  isGameId,
  isJson,
  themeColorFor,
  undoPolicyFor,
  type GameManifest,
  type GameTheme,
  type Json,
  type Mode,
  type PlayerCounts,
  type ThemeColor,
  type UndoSetting,
} from './index.ts';

const base = {
  id: 'nim',
  name: 'Nim',
  summary: 'Take the last stone to win.',
  category: 'strategy',
  tags: ['abstract', 'two players'],
  modes: ['ai', 'pass-and-play', 'p2p'],
  players: { min: 2, max: 2 },
  ai: { levels: ['easy', 'hard'] },
  layers: { engine: true, simulation: false },
  privateState: false,
  handoff: false,
  essentialMotion: false,
  access: 'free',
  versions: { build: '1.0.0', rules: 1, save: 1, minProtocol: 1 },
  undo: 'unlimited',
  clock: { default: 30, presets: [15, 30, 60] },
  assets: '/games/nim/assets.json',
} as const satisfies GameManifest;

describe('defineManifest', () => {
  it('returns the manifest unchanged, keeping literal types', () => {
    const manifest = defineManifest({ ...base, rooms: { maxSpectators: 4 } });
    expect(manifest).toEqual({ ...base, rooms: { maxSpectators: 4 } });
    expectTypeOf(manifest.id).toEqualTypeOf<'nim'>();
    expectTypeOf(manifest.modes).toEqualTypeOf<readonly ['ai', 'pass-and-play', 'p2p']>();
  });

  it('is plain JSON', () => {
    expect(isJson(defineManifest(base))).toBe(true);
    expectTypeOf<GameManifest>().toExtend<Json>();
  });

  it('requires versions, the D-31 hand-off flag and the D-32 and D-34 fields', () => {
    const { versions, handoff, undo, clock, ...rest } = base;
    void [versions, handoff, undo, clock];
    // @ts-expect-error versions is required
    defineManifest({ ...rest, handoff, undo, clock });
    // @ts-expect-error handoff is required
    defineManifest({ ...rest, versions, undo, clock });
    // @ts-expect-error undo is required
    defineManifest({ ...rest, versions, handoff, clock });
    // @ts-expect-error clock is required (null for no clock)
    defineManifest({ ...rest, versions, handoff, undo });
    defineManifest({ ...rest, versions, handoff, undo, clock: null });
  });

  it('accepts the three undo policies and nothing else', () => {
    defineManifest({ ...base, undo: 'none' });
    defineManifest({ ...base, undo: { limited: 3 } });
    // @ts-expect-error a bare 'limited' needs a count
    defineManifest({ ...base, undo: 'limited' });
  });

  it('accepts undo rules per mode, and rejects unknown modes', () => {
    defineManifest({ ...base, undo: { vsAi: 'unlimited' } });
    defineManifest({ ...base, undo: { default: { limited: 3 }, daily: 'none', passAndPlay: 'unlimited' } });
    // @ts-expect-error the mode keys are solo, vsAi, daily and passAndPlay
    defineManifest({ ...base, undo: { vsai: 'unlimited' } });
    // @ts-expect-error each mode takes an undo policy
    defineManifest({ ...base, undo: { solo: 'limited' } });
  });

  it('accepts per-move clocks with or without a mode, and time banks with increment', () => {
    defineManifest({ ...base, clock: { mode: 'move', default: 60, presets: [30, 60, 120] } });
    const blitz = { initialMs: 300_000, incrementMs: 3_000 };
    const manifest = defineManifest({
      ...base,
      clock: { mode: 'bank', default: blitz, presets: [{ initialMs: 180_000, incrementMs: 2_000 }, blitz] },
    });
    expect(isJson(manifest)).toBe(true);
    // @ts-expect-error a bank preset is a starting bank and an increment, in milliseconds
    defineManifest({ ...base, clock: { mode: 'bank', default: 300, presets: [300] } });
  });

  it('leaves Off out of the manifest, so it can never be the default (D-42)', () => {
    // @ts-expect-error the platform adds Off in private rooms; it is never the default
    defineManifest({ ...base, clock: { default: 'off', presets: [15, 30] } });
    // @ts-expect-error presets are times; the platform adds Off
    defineManifest({ ...base, clock: { default: 30, presets: [30, null] } });
    defineManifest({
      ...base,
      // @ts-expect-error a time bank's default is a bank, never Off
      clock: { mode: 'bank', default: null, presets: [{ initialMs: 60_000, incrementMs: 0 }] },
    });
  });

  it('declares heavy AI, which is optional', () => {
    defineManifest({ ...base, ai: { levels: ['club', 'expert'], heavy: true } });
    expectTypeOf<NonNullable<GameManifest['ai']>['heavy']>().toEqualTypeOf<boolean | undefined>();
  });

  it('flags AI-generated content (D-44), which is optional', () => {
    const manifest = defineManifest({ ...base, aiContent: true });
    expect(isJson(manifest)).toBe(true);
    defineManifest({ ...base });
    expectTypeOf<GameManifest['aiContent']>().toEqualTypeOf<boolean | undefined>();
    // @ts-expect-error the flag is a boolean
    defineManifest({ ...base, aiContent: 'yes' });
  });

  it('takes an optional page title for search, kept as declared', () => {
    const manifest = defineManifest({ ...base, pageTitle: 'Nim Stones' });
    expect(manifest.pageTitle).toBe('Nim Stones');
    expect(isJson(manifest)).toBe(true);
    expectTypeOf(manifest.pageTitle).toEqualTypeOf<'Nim Stones'>();
    expectTypeOf<GameManifest['pageTitle']>().toEqualTypeOf<string | undefined>();
    // @ts-expect-error the page title is text
    defineManifest({ ...base, pageTitle: 1 });
    // @ts-expect-error a misspelled pageTitle is an unknown key
    defineManifest({ ...base, pagetitle: 'Nim Stones' });
  });

  it('takes an optional default player count, a number kept as declared', () => {
    const manifest = defineManifest({ ...base, players: { min: 1, max: 5, default: 5 } });
    expect(manifest.players).toEqual({ min: 1, max: 5, default: 5 });
    expect(isJson(manifest)).toBe(true);
    expectTypeOf(manifest.players.default).toEqualTypeOf<5>();
    expectTypeOf<GameManifest['players']>().toEqualTypeOf<PlayerCounts>();
    expectTypeOf<PlayerCounts['default']>().toEqualTypeOf<number | undefined>();
    // @ts-expect-error the default is a count, not a word
    defineManifest({ ...base, players: { min: 1, max: 5, default: 'five' } });
  });

  it('offers only free access in v1', () => {
    // @ts-expect-error 'premium' arrives in v2
    defineManifest({ ...base, access: 'premium' });
  });

  it('rejects keys the manifest does not know, such as the retired hiddenInformation', () => {
    // @ts-expect-error hiddenInformation was split into privateState and handoff
    defineManifest({ ...base, hiddenInformation: true });
  });

  it('takes a theme of single colors, as before, or light and dark pairs, with an optional ink', () => {
    defineManifest({ ...base, theme: { accent: 'oklch(70% 0.1 80)', surface: 'oklch(30% 0.05 50)' } });
    defineManifest({
      ...base,
      theme: { accent: 'oklch(70% 0.1 80)', surface: 'oklch(96% 0.03 145)', ink: 'oklch(22% 0.03 145)' },
    });
    defineManifest({
      ...base,
      theme: {
        accent: { light: 'oklch(48% 0.15 145)', dark: 'oklch(78% 0.15 145)' },
        surface: { light: 'oklch(96% 0.03 145)', dark: 'oklch(24% 0.04 145)' },
        ink: { light: 'oklch(24% 0.04 145)', dark: 'oklch(95% 0.02 145)' },
      },
    });
    // An accent alone: the canvas keeps the frame's surface and text colors.
    defineManifest({ ...base, theme: { accent: 'oklch(70% 0.1 80)' } });
    // @ts-expect-error a theme needs an accent
    defineManifest({ ...base, theme: { surface: 'oklch(30% 0.05 50)' } });
    // @ts-expect-error a pair names both schemes
    defineManifest({ ...base, theme: { accent: { light: 'oklch(48% 0.15 145)' } } });
    expect(
      isJson(defineManifest({ ...base, theme: { accent: { light: 'red', dark: 'pink' }, surface: 'white' } })),
    ).toBe(true);
    expectTypeOf<GameTheme['ink']>().toEqualTypeOf<ThemeColor | undefined>();
  });
});

describe('themeColorFor', () => {
  it('gives a single color in both schemes and a pair by scheme', () => {
    expect(themeColorFor('oklch(30% 0.05 50)', 'light')).toBe('oklch(30% 0.05 50)');
    expect(themeColorFor('oklch(30% 0.05 50)', 'dark')).toBe('oklch(30% 0.05 50)');
    expect(themeColorFor({ light: 'white', dark: 'black' }, 'light')).toBe('white');
    expect(themeColorFor({ light: 'white', dark: 'black' }, 'dark')).toBe('black');
  });
});

describe('undoPolicyFor', () => {
  const modes: readonly Mode[] = ['solo', 'ai', 'daily', 'pass-and-play', 'p2p', 'server'];
  const table = (undo: UndoSetting) => modes.map((mode) => undoPolicyFor(undo, mode));

  it('applies a single policy to solo, vs-AI and daily play, never to pass-and-play or rooms', () => {
    expect(table('unlimited')).toEqual(['unlimited', 'unlimited', 'unlimited', 'none', 'none', 'none']);
    expect(table({ limited: 2 })).toEqual([{ limited: 2 }, { limited: 2 }, { limited: 2 }, 'none', 'none', 'none']);
  });

  it('reads each mode, falling back to the default, then to none', () => {
    expect(table({ vsAi: 'unlimited' })).toEqual(['none', 'unlimited', 'none', 'none', 'none', 'none']);
    expect(table({ default: 'unlimited', daily: 'none' })).toEqual([
      'unlimited',
      'unlimited',
      'none',
      'none',
      'none',
      'none',
    ]);
  });

  it('allows pass-and-play only when named, and rooms never', () => {
    expect(table({ passAndPlay: { limited: 1 } })).toEqual(['none', 'none', 'none', { limited: 1 }, 'none', 'none']);
  });
});

describe('isGameId', () => {
  it.each(['nim', 'shift-23', 'containment', '2048'])('accepts %s', (id) => {
    expect(isGameId(id)).toBe(true);
  });

  it.each(['', 'Nim', 'shift_23', '-nim', 'nim-', 'a--b', 'light trails', 42])('rejects %j', (id) => {
    expect(isGameId(id)).toBe(false);
  });
});
