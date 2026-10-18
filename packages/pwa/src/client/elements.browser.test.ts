// The PWA's two elements in Chromium.
import { afterEach, describe, expect, it } from 'vitest';
import { definePwaElements } from './elements.ts';
import { toastPrompt } from './register.ts';

definePwaElements();

afterEach(() => {
  document.body.replaceChildren();
});

describe('<jy-update-toast>', () => {
  it('announces the update politely and reports the choice', async () => {
    const choices: string[] = [];
    const toast = document.createElement('jy-update-toast');
    toast.onChoice = (choice) => choices.push(choice);
    document.body.append(toast);
    const root = toast.shadowRoot;
    expect(root?.querySelector('[role="status"]')?.textContent).toBe(
      'Update ready. Refresh to get the newest Joystyk.',
    );
    const [refresh, later] = [...(root?.querySelectorAll('button') ?? [])];
    expect([refresh?.textContent, later?.textContent]).toEqual(['Refresh', 'Later']);
    // It never takes focus from the page or the game.
    expect(document.activeElement).toBe(document.body);
    later?.click();
    refresh?.click();
    expect(choices).toEqual(['later', 'refresh']);
  });

  it('is shown and hidden by the default prompt', async () => {
    const prompt = toastPrompt();
    prompt.show(() => undefined);
    await expect.poll(() => document.querySelectorAll('jy-update-toast').length).toBe(1);
    prompt.show(() => undefined);
    await expect.poll(() => document.querySelectorAll('jy-update-toast').length).toBe(1);
    prompt.hide();
    expect(document.querySelectorAll('jy-update-toast').length).toBe(0);
  });
});

describe('<jy-offline-toggle>', () => {
  it('stays empty, its box reserved, until a service worker is active', async () => {
    const toggle = document.createElement('jy-offline-toggle');
    toggle.setAttribute('game-id', 'nim');
    toggle.setAttribute('game-name', 'Nim');
    document.body.append(toggle);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No worker is registered in this test page, so `navigator.serviceWorker.ready` never resolves.
    expect(toggle.shadowRoot?.querySelector('.wrap')?.hasAttribute('hidden')).toBe(true);
    expect(getComputedStyle(toggle).display).toBe('block');
  });
});
