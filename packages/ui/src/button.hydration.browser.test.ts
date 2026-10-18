// Server-render the actual shared button in Node, then hydrate the same DOM in Chromium.
import { OUTPUT_EVENT, settled, type OutputEvent } from '@gyral/core';
import { hydrated, mountSsr } from '@gyral/testing';
import type {} from '@gyral/testing/vitest';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ButtonOutput } from './button.ts';

it('hydrates the pressed server button in place and toggles it on a click', async () => {
  const page = mountSsr(
    await commands.renderOnServer({ module: './button.ts', export: 'Button', props: { toggle: true, pressed: true } }),
  );
  try {
    const host = page.root.querySelector('jy-button');
    const button = host?.shadowRoot?.querySelector('button');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    const outputs: ButtonOutput[] = [];
    host?.addEventListener(OUTPUT_EVENT, (event) => outputs.push((event as OutputEvent<ButtonOutput>).detail));
    await import('./button.ts');
    await hydrated(page);
    expect(host?.shadowRoot?.querySelector('button')).toBe(button);
    button?.click();
    await settled();
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(outputs).toEqual([{ _tag: 'Toggled', pressed: false }]);
  } finally {
    page.unmount();
  }
});
