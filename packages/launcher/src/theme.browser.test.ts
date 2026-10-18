// The theme tokens in real Chromium: the CSS fallback `readableInk` writes for colors it can't
// read resolves to the ink it would have picked, and `light-dark()` pairs follow the
// element's color scheme.
import { afterEach, expect, it } from 'vitest';
import { canvasTheme, readableInk } from './theme.ts';

afterEach(() => {
  document.body.replaceChildren();
});

/** The computed `color` of an element whose `color` is `value`, under `scheme`. */
const computed = (value: string, scheme: 'light' | 'dark' = 'light'): string => {
  const el = document.createElement('p');
  el.style.colorScheme = scheme;
  el.style.color = value;
  document.body.append(el);
  return getComputedStyle(el).color;
};

it.each([
  ['linen', 'oklch(0.2 0 0)'],
  ['rgb(250 250 250)', 'oklch(0.2 0 0)'],
  ['navy', 'oklch(0.97 0 0)'],
  ['rgb(20 20 40)', 'oklch(0.97 0 0)'],
])('picks a readable ink in CSS for %s', (surface, ink) => {
  expect(computed(readableInk(surface))).toBe(ink);
});

it('resolves a pair of inks by the color scheme', () => {
  const { ink } = canvasTheme({
    accent: 'gold',
    surface: { light: 'oklch(96% 0.03 145)', dark: 'oklch(25% 0.04 145)' },
  });
  expect(computed(ink, 'light')).toBe(computed('oklch(20% 0.02 145)'));
  expect(computed(ink, 'dark')).toBe(computed('oklch(97% 0.01 145)'));
});
