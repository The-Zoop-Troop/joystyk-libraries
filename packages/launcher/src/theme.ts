// The theme handoff (game-contract.md, "Theme"): the CSS values the stage sets on the canvas
// as `--game-accent`, `--game-surface` and `--game-ink`. Pure, so it runs in Node tests.
//
// The rule is that a surface and its ink always follow the same color scheme. A game's
// single surface gets a single ink, its own or one picked for contrast; a pair of surfaces
// gets an ink per scheme; and a game with no surface gets the frame's surface and text
// tokens, which both follow the player's scheme. The system's `CanvasText` never meets a
// game's fixed surface: on a light surface in dark mode it would be white on near-white.
import type { GameTheme, SchemeColors, ThemeColor } from '@joystyk/contracts';

/** The values of the canvas's three theme tokens. */
export type CanvasTheme = {
  readonly accent: string;
  readonly surface: string;
  readonly ink: string;
};

/**
 * The frame's own colors, for a game without a theme or without a surface. The fallbacks are
 * system colors, which also follow the canvas's color scheme together.
 */
export const FRAME_THEME: CanvasTheme = {
  accent: 'var(--jy-accent, LinkText)',
  surface: 'var(--jy-surface, Canvas)',
  ink: 'var(--jy-text, CanvasText)',
};

/** The lightness of the inks the launcher picks: near-black and near-white. */
const DARK_INK_L = 0.2;
const LIGHT_INK_L = 0.97;

/** Relative luminance of a neutral color with OKLab lightness `l` (OKLab L is the cube root of Y). */
const luminance = (l: number): number => l ** 3;

/** The WCAG contrast ratio between two relative luminances. */
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The surface lightness at which both inks contrast equally; darker surfaces get the light
 * ink. About 0.57: mid-tones are the hardest surfaces to write on.
 */
export const INK_CROSSOVER_L = Math.cbrt(
  Math.sqrt((luminance(DARK_INK_L) + 0.05) * (luminance(LIGHT_INK_L) + 0.05)) - 0.05,
);

/** The OKLCH lightness (0 to 1) and hue (degrees, or null when achromatic or unknown) of a color. */
export type Lightness = { readonly l: number; readonly h: number | null };

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const OKLCH = new RegExp(
  String.raw`^oklch\(\s*(none|${NUMBER}%?)\s+(none|${NUMBER}%?)\s+(none|${NUMBER}(?:deg)?)\s*(?:\/\s*[^)]*)?\)$`,
  'i',
);
const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** OKLab lightness of an sRGB color with channels 0 to 1 (Björn Ottosson's matrices). */
const oklabLightness = (r: number, g: number, b: number): number => {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
};

/**
 * Reads the lightness of an `oklch()` or hex color. Null for anything else (named colors,
 * `rgb()`, `var()`), which the launcher leaves to CSS.
 */
export const parseLightness = (color: string): Lightness | null => {
  const text = color.trim();
  const oklch = OKLCH.exec(text);
  if (oklch !== null) {
    const [, lightness = 'none', chroma = 'none', hue = 'none'] = oklch;
    const l =
      lightness === 'none'
        ? 0
        : lightness.endsWith('%')
          ? Number.parseFloat(lightness) / 100
          : Number.parseFloat(lightness);
    const c = chroma === 'none' ? 0 : Number.parseFloat(chroma);
    const h = hue === 'none' || c === 0 ? null : Number.parseFloat(hue);
    return { l: Math.min(1, Math.max(0, l)), h };
  }
  const hex = HEX.exec(text)?.[1];
  if (hex !== undefined) {
    const digits = hex.length <= 4 ? [...hex].map((d) => d + d) : (hex.match(/../g) ?? []);
    const [r = 0, g = 0, b = 0] = digits.slice(0, 3).map((d) => Number.parseInt(d, 16) / 255);
    return { l: oklabLightness(r, g, b), h: null };
  }
  return null;
};

/** An ink of lightness `l`, neutral or faintly tinted with `hue`. */
const inkOf = (l: number, hue: number | null): string => {
  const percent = `${String(Math.round(l * 100))}%`;
  return hue === null ? `oklch(${percent} 0 0)` : `oklch(${percent} ${l < 0.5 ? '0.02' : '0.01'} ${String(hue)})`;
};

/**
 * A readable ink for a surface: near-black or near-white, whichever contrasts more, tinted
 * with the surface's hue. A surface it can't read gets the same choice made in CSS, through
 * relative color syntax.
 */
export const readableInk = (surface: string): string => {
  const parsed = parseLightness(surface);
  if (parsed === null) {
    const threshold = INK_CROSSOVER_L.toFixed(4);
    return `oklch(from ${surface} clamp(${String(DARK_INK_L)}, (${threshold} - l) * 1000, ${String(LIGHT_INK_L)}) 0 0)`;
  }
  const y = luminance(parsed.l);
  const light = ratio(y, luminance(LIGHT_INK_L)) > ratio(y, luminance(DARK_INK_L));
  return inkOf(light ? LIGHT_INK_L : DARK_INK_L, parsed.h);
};

const pair = (color: ThemeColor): SchemeColors => (typeof color === 'string' ? { light: color, dark: color } : color);

/** One value when both schemes agree, otherwise `light-dark()`, resolved by the canvas's `color-scheme`. */
const cssValue = ({ light, dark }: SchemeColors): string => (light === dark ? light : `light-dark(${light}, ${dark})`);

/** The canvas's theme tokens for a manifest's theme. */
export const canvasTheme = (theme: GameTheme | undefined): CanvasTheme => {
  if (theme === undefined) return FRAME_THEME;
  const accent = cssValue(pair(theme.accent));
  if (theme.surface === undefined) return { ...FRAME_THEME, accent };
  const surface = pair(theme.surface);
  // A single surface never gets an ink that changes with the scheme.
  const own =
    theme.ink === undefined || (typeof theme.surface === 'string' && typeof theme.ink !== 'string')
      ? null
      : pair(theme.ink);
  const ink = own ?? { light: readableInk(surface.light), dark: readableInk(surface.dark) };
  return { accent, surface: cssValue(surface), ink: cssValue(ink) };
};
