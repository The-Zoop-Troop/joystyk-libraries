// <jy-button> in real Chromium: role, name, keyboard, focus and outputs.
import { OUTPUT_EVENT, settled, type OutputEvent } from '@gyral/core';
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import './tokens.css';
import { Button, type ButtonOutput } from './button.ts';

afterEach(() => {
  document.body.replaceChildren();
});

/** Mounts `<jy-button>` with the given attributes and label, and records its outputs. */
const mount = async (attributes: string, label: string) => {
  document.body.insertAdjacentHTML('beforeend', `<jy-button ${attributes}>${label}</jy-button>`);
  const el = document.body.lastElementChild;
  if (!(el instanceof Button)) throw new Error('jy-button did not upgrade');
  const outputs: ButtonOutput[] = [];
  el.addEventListener(OUTPUT_EVENT, (event) => {
    outputs.push((event as OutputEvent<ButtonOutput>).detail);
  });
  await settled();
  return { el, outputs };
};

it('is a button named by its content', async () => {
  await mount('', 'Play');
  const button = page.getByRole('button', { name: 'Play' });
  await expect.element(button).toBeVisible();
  await expect.element(button).not.toHaveAttribute('aria-pressed');
});

it('reports a click', async () => {
  const { outputs } = await mount('', 'Play');
  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(() => outputs).toEqual([{ _tag: 'Activated' }]);
});

it('toggles from the keyboard and says whether it is pressed', async () => {
  const { el, outputs } = await mount('toggle', 'Sound');
  const button = page.getByRole('button', { name: 'Sound' });
  await expect.element(button).toHaveAttribute('aria-pressed', 'false');

  await userEvent.tab();
  // Focus sits on the native button inside the shadow root; the document sees the host.
  expect(document.activeElement).toBe(el);
  expect(el.shadowRoot?.activeElement).toBe(button.element());
  await userEvent.keyboard('{Enter}');
  await expect.element(button).toHaveAttribute('aria-pressed', 'true');
  await userEvent.keyboard(' ');
  await expect.element(button).toHaveAttribute('aria-pressed', 'false');

  expect(outputs).toEqual([
    { _tag: 'Toggled', pressed: true },
    { _tag: 'Toggled', pressed: false },
  ]);
});

it('starts pressed when asked to', async () => {
  await mount('toggle pressed', 'Hints');
  await expect.element(page.getByRole('button', { name: 'Hints', pressed: true })).toBeVisible();
});

it('meets the minimum touch target size', async () => {
  const { el } = await mount('', 'Go');
  const inner = el.shadowRoot?.querySelector('button');
  if (inner === null || inner === undefined) throw new Error('no inner button');
  const { width, height } = inner.getBoundingClientRect();
  expect(Math.min(width, height)).toBeGreaterThanOrEqual(44);
});
