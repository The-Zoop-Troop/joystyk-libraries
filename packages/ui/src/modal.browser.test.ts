// gp-077: native opening must follow insertion and precede focus commands.
import { define, focus, html, keyed, nothing, prop, settled } from '@gyral/core';
import { collectErrors } from '@gyral/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';

type State = { readonly open: boolean; readonly generation: number };
type Msg = { readonly _tag: 'Open' } | { readonly _tag: 'Close' } | { readonly _tag: 'Replace' };
type Props = { readonly initiallyOpen: boolean };

const Probe = define<State, Msg, Props>()('jy-modal-regression', {
  props: { initiallyOpen: prop.boolean() },
  init: (props) => ({ open: props.initiallyOpen, generation: 0 }),
  intent: { Open: true, Close: true, Replace: true },
  update: {
    Open: (s) => [{ ...s, open: true }, [focus('#confirm')]],
    Close: (s) => [{ ...s, open: false }, [focus('#open')]],
    Replace: (s) => [{ ...s, generation: s.generation + 1 }, [focus('#confirm')]],
  },
  view: (s, i) => html`
    <button type="button" id="open" data-intent=${i.Open}>Open confirmation</button>
    ${
      s.open
        ? keyed(
            s.generation,
            html`
      <dialog ?modal=${true} aria-labelledby="confirmation-title" data-intent-close=${i.Close}>
        <h2 id="confirmation-title">Confirm action ${s.generation}</h2>
        <button type="button" id="confirm" data-intent=${i.Close}>Keep playing</button>
        <button type="button" data-intent=${i.Replace}>Replace confirmation</button>
      </dialog>
    `,
          )
        : nothing
    }
  `,
});

let errors: ReturnType<typeof collectErrors>;
beforeEach(() => {
  errors = collectErrors();
});
afterEach(async () => {
  document.body.replaceChildren();
  await settled();
  try {
    expect(errors.errors).toEqual([]);
  } finally {
    errors.stop();
  }
});

const mount = async (initiallyOpen = false) => {
  const host = new Probe();
  if (initiallyOpen) host.setAttribute('initially-open', '');
  document.body.append(host);
  await settled();
  return host;
};

it('opens a conditional dialog in the top layer before running its focus command', async () => {
  const host = await mount();
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await settled();
  const dialog = host.shadowRoot?.querySelector('dialog');
  expect(dialog?.isConnected).toBe(true);
  expect(dialog?.matches(':modal')).toBe(true);
  expect(host.shadowRoot?.activeElement).toBe(dialog?.querySelector('#confirm'));
  await page.getByRole('button', { name: 'Keep playing' }).click();
  await settled();
  expect(host.shadowRoot?.querySelector('dialog')).toBeNull();
  expect(host.shadowRoot?.activeElement).toBe(host.shadowRoot?.querySelector('#open'));
});

it('opens an initially active dialog after its component connects', async () => {
  const host = await mount(true);
  expect(host.shadowRoot?.querySelector('dialog')?.matches(':modal')).toBe(true);
});

it('opens keyed replacements and leaves the removed dialog outside the top layer', async () => {
  const host = await mount(true);
  const previous = host.shadowRoot?.querySelector('dialog');
  await page.getByRole('button', { name: 'Replace confirmation' }).click();
  await settled();
  const current = host.shadowRoot?.querySelector('dialog');
  expect(current).not.toBe(previous);
  expect(previous?.isConnected).toBe(false);
  expect(previous?.matches(':modal')).toBe(false);
  expect(current?.matches(':modal')).toBe(true);
  expect(host.shadowRoot?.activeElement).toBe(current?.querySelector('#confirm'));
});

it('synchronizes native Escape closing and permits a fresh conditional dialog', async () => {
  const host = await mount();
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => host.shadowRoot?.querySelector('dialog')).toBeNull();
  expect(host.shadowRoot?.activeElement).toBe(host.shadowRoot?.querySelector('#open'));
  await page.getByRole('button', { name: 'Open confirmation' }).click();
  await settled();
  expect(host.shadowRoot?.querySelector('dialog')?.matches(':modal')).toBe(true);
});

it('synchronizes programmatic native close with the conditional model', async () => {
  const host = await mount(true);
  host.shadowRoot?.querySelector('dialog')?.close();
  await expect.poll(() => host.shadowRoot?.querySelector('dialog')).toBeNull();
});
