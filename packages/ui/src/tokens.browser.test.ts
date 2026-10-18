// The design tokens in real Chromium: they load, and each theme resolves its own colors.
import { afterEach, expect, it } from 'vitest';
import './tokens.css';

afterEach(() => {
  document.body.replaceChildren();
});

/** The oklch lightness (0–1) of an element's computed background. */
const lightness = (el: Element): number => {
  const color = getComputedStyle(el).backgroundColor;
  const match = /^oklch\(([\d.]+)/.exec(color);
  if (match?.[1] === undefined) throw new Error(`expected an oklch color, got ${color}`);
  return Number(match[1]);
};

/** A swatch of the surface token under a pinned color scheme. */
const surface = (scheme: 'light' | 'dark'): HTMLElement => {
  const el = document.createElement('div');
  el.style.colorScheme = scheme;
  el.style.background = 'var(--jy-surface)';
  document.body.append(el);
  return el;
};

it('gives the light theme a light surface and the dark theme a dark one', () => {
  expect(lightness(surface('light'))).toBeGreaterThan(0.9);
  expect(lightness(surface('dark'))).toBeLessThan(0.25);
});

it('follows the color scheme the visitor prefers', () => {
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const page = lightness(document.body);
  expect(prefersDark ? page < 0.25 : page > 0.9).toBe(true);
});
