import { describe, expect, it } from 'vitest';
import { canvasTheme, FRAME_THEME, INK_CROSSOVER_L, parseLightness, readableInk } from './theme.ts';

describe('parseLightness', () => {
  it('reads oklch() lightness as a percentage or a number, with its hue', () => {
    expect(parseLightness('oklch(96% 0.03 145)')).toEqual({ l: 0.96, h: 145 });
    expect(parseLightness('oklch(0.25 0.04 145deg / 0.5)')).toEqual({ l: 0.25, h: 145 });
    expect(parseLightness('  OKLCH(16.5% 0.018 165) ')).toEqual({ l: 0.165, h: 165 });
  });

  it('treats an achromatic or hueless color as having no hue', () => {
    expect(parseLightness('oklch(50% 0 120)')).toEqual({ l: 0.5, h: null });
    expect(parseLightness('oklch(50% 0.1 none)')).toEqual({ l: 0.5, h: null });
  });

  it('reads hex colors through OKLab', () => {
    expect(parseLightness('#fff')?.l).toBeCloseTo(1, 3);
    expect(parseLightness('#000000')?.l).toBeCloseTo(0, 3);
    expect(parseLightness('#111418')?.l).toBeCloseTo(0.19, 2);
    expect(parseLightness('#d4b06aff')?.l).toBeCloseTo(0.77, 2);
  });

  it('leaves other syntaxes to CSS', () => {
    for (const color of ['linen', 'rgb(0 0 0)', 'var(--x)', 'oklch(50%)', '#12345'])
      expect(parseLightness(color)).toBeNull();
  });
});

describe('readableInk', () => {
  it('gives a light surface near-black ink and a dark surface near-white ink, tinted with its hue', () => {
    expect(readableInk('oklch(96% 0.03 145)')).toBe('oklch(20% 0.02 145)');
    expect(readableInk('oklch(21% 0.035 265)')).toBe('oklch(97% 0.01 265)');
    expect(readableInk('#111418')).toBe('oklch(97% 0 0)');
    expect(readableInk('#fafafa')).toBe('oklch(20% 0 0)');
  });

  it('switches at the lightness where both inks contrast equally', () => {
    expect(INK_CROSSOVER_L).toBeGreaterThan(0.55);
    expect(INK_CROSSOVER_L).toBeLessThan(0.6);
    expect(readableInk(`oklch(${String((INK_CROSSOVER_L - 0.01) * 100)}% 0 0)`)).toBe('oklch(97% 0 0)');
    expect(readableInk(`oklch(${String((INK_CROSSOVER_L + 0.01) * 100)}% 0 0)`)).toBe('oklch(20% 0 0)');
  });

  it('makes the same choice in CSS for a color it cannot read', () => {
    expect(readableInk('linen')).toBe(
      `oklch(from linen clamp(0.2, (${INK_CROSSOVER_L.toFixed(4)} - l) * 1000, 0.97) 0 0)`,
    );
  });
});

describe('canvasTheme', () => {
  it('uses the frame’s surface and text, which follow the same scheme, for a game without a theme', () => {
    expect(canvasTheme(undefined)).toEqual(FRAME_THEME);
    expect(FRAME_THEME).toEqual({
      accent: 'var(--jy-accent, LinkText)',
      surface: 'var(--jy-surface, Canvas)',
      ink: 'var(--jy-text, CanvasText)',
    });
  });

  it('keeps the frame’s surface and text for a theme without a surface, ignoring its ink', () => {
    expect(canvasTheme({ accent: 'oklch(70% 0.1 80)', ink: 'oklch(20% 0 0)' })).toEqual({
      ...FRAME_THEME,
      accent: 'oklch(70% 0.1 80)',
    });
  });

  it('picks one readable ink for a single surface, never the system’s CanvasText', () => {
    const theme = canvasTheme({ accent: 'oklch(62% 0.19 145)', surface: 'oklch(96% 0.03 145)' });
    expect(theme).toEqual({
      accent: 'oklch(62% 0.19 145)',
      surface: 'oklch(96% 0.03 145)',
      ink: 'oklch(20% 0.02 145)',
    });
    expect(theme.ink).not.toContain('light-dark');
  });

  it('uses a game’s own single ink', () => {
    expect(canvasTheme({ accent: 'gold', surface: '#111418', ink: 'oklch(92% 0.01 80)' }).ink).toBe(
      'oklch(92% 0.01 80)',
    );
  });

  it('never pairs a single surface with an ink that changes with the scheme', () => {
    const theme = canvasTheme({
      accent: 'gold',
      surface: 'oklch(96% 0.03 145)',
      ink: { light: 'oklch(20% 0 0)', dark: 'oklch(95% 0 0)' },
    });
    expect(theme.surface).toBe('oklch(96% 0.03 145)');
    expect(theme.ink).toBe('oklch(20% 0.02 145)');
  });

  it('pairs surfaces and inks by scheme with light-dark()', () => {
    expect(
      canvasTheme({
        accent: { light: 'oklch(46% 0.15 145)', dark: 'oklch(80% 0.16 145)' },
        surface: { light: 'oklch(96% 0.03 145)', dark: 'oklch(25% 0.04 145)' },
        ink: { light: 'oklch(24% 0.04 145)', dark: 'oklch(95% 0.02 145)' },
      }),
    ).toEqual({
      accent: 'light-dark(oklch(46% 0.15 145), oklch(80% 0.16 145))',
      surface: 'light-dark(oklch(96% 0.03 145), oklch(25% 0.04 145))',
      ink: 'light-dark(oklch(24% 0.04 145), oklch(95% 0.02 145))',
    });
  });

  it('picks an ink per scheme for a surface pair without ink', () => {
    const theme = canvasTheme({
      accent: 'gold',
      surface: { light: 'oklch(96% 0.03 145)', dark: 'oklch(25% 0.04 145)' },
    });
    expect(theme.ink).toBe('light-dark(oklch(20% 0.02 145), oklch(97% 0.01 145))');
  });

  it('applies a single ink to both surfaces of a pair', () => {
    const theme = canvasTheme({ accent: 'gold', surface: { light: 'white', dark: 'white' }, ink: 'black' });
    expect(theme).toEqual({ accent: 'gold', surface: 'white', ink: 'black' });
  });
});
