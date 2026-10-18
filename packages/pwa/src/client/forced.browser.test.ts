// Forced security updates in Chromium: the blocking notice, and the order of what follows it
// (save, then the new worker, then the reload), with the flag file and the page's ports faked.
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { Control } from '../control.ts';
import { definePwaElements } from './elements.ts';
import { securityNotice, watchForcedUpdates, type ForcedUpdates } from './forced.ts';

definePwaElements();

const OWN = '2026-10-09T12:00:00Z';
const flags = (minimumRelease?: string): Control =>
  minimumRelease === undefined
    ? { schemaVersion: 1, serviceWorker: 'enabled' }
    : { schemaVersion: 1, serviceWorker: 'enabled', minimumRelease };

const watchers: ForcedUpdates[] = [];

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.dispose();
  document.body.replaceChildren();
});

/** A watcher over a fake flag file and fake ports, recording what happens in order. */
const setup = (control: () => Control | null) => {
  const log: string[] = [];
  let finishSave = (): void => undefined;
  let update: (() => void) | null = null;
  const watcher = watchForcedUpdates({
    releaseTime: OWN,
    read: async () => control(),
    saveGame: () => {
      log.push('save');
      return new Promise<void>((resolve) => {
        finishSave = () => {
          log.push('saved');
          resolve();
        };
      });
    },
    prepare: async () => {
      log.push('prepare');
    },
    reload: () => log.push('reload'),
    notice: {
      show: (choose) => {
        log.push('notice');
        update = choose;
      },
    },
  });
  watchers.push(watcher);
  return { watcher, log, finishSave: () => finishSave(), choose: () => update?.() };
};

describe('watchForcedUpdates', () => {
  it('shows the notice and saves at once, but reloads only after Update now and the save', async () => {
    const { watcher, log, finishSave, choose } = setup(() => flags('2026-10-09T12:00:01Z'));
    expect(await watcher.check()).toEqual(flags('2026-10-09T12:00:01Z'));
    expect(watcher.forcing).toBe(true);
    await expect.poll(() => log).toEqual(['notice', 'save']);
    choose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Never a new release before the game is saved.
    expect(log).toEqual(['notice', 'save']);
    finishSave();
    await expect.poll(() => log).toEqual(['notice', 'save', 'saved', 'prepare', 'reload']);
  });

  it('does nothing for a release at or past the minimum, without a minimum, or offline', async () => {
    for (const control of [flags(OWN), flags('2026-01-01T00:00:00Z'), flags(), null]) {
      const { watcher, log } = setup(() => control);
      await watcher.check();
      expect(watcher.forcing, JSON.stringify(control)).toBe(false);
      expect(log).toEqual([]);
    }
  });

  it('forces once however often it reads, and reads again when the tab comes back into view', async () => {
    let control: Control | null = null;
    const { watcher, log } = setup(() => control);
    await watcher.check();
    expect(log).toEqual([]);
    control = flags('2999-01-01T00:00:00Z');
    document.dispatchEvent(new Event('visibilitychange'));
    await expect.poll(() => watcher.forcing).toBe(true);
    await watcher.check();
    watcher.observe(control);
    expect(log.filter((entry) => entry === 'notice')).toHaveLength(1);
  });

  it('still reloads when the save fails', async () => {
    const log: string[] = [];
    let choose: (() => void) | null = null;
    const watcher = watchForcedUpdates({
      releaseTime: OWN,
      read: async () => flags('2999-01-01T00:00:00Z'),
      saveGame: async () => {
        throw new Error('storage is full');
      },
      reload: () => log.push('reload'),
      notice: { show: (update) => (choose = update) },
    });
    watchers.push(watcher);
    await watcher.check();
    (choose as (() => void) | null)?.();
    await expect.poll(() => log).toEqual(['reload']);
  });
});

describe('<jy-security-update>', () => {
  it('is a modal dialog that takes focus, gives the reason and offers one action', async () => {
    const updates: number[] = [];
    securityNotice().show(() => updates.push(1));
    const dialog = page.getByRole('dialog', { name: 'Security update' });
    await expect.element(dialog).toBeVisible();
    const element = document.querySelector('jy-security-update');
    const native = element?.shadowRoot?.querySelector('dialog');
    expect(native?.matches(':modal')).toBe(true);
    await expect.element(dialog).toHaveAccessibleDescription(/security problem that a new version fixes/);
    const button = page.getByRole('button', { name: 'Update now' });
    // Focus moves into the dialog, onto its one button.
    expect(document.activeElement).toBe(element);
    expect(element?.shadowRoot?.activeElement).toBe(button.element());
    expect(element?.shadowRoot?.querySelectorAll('button')).toHaveLength(1);

    // Blocking: Escape leaves it open.
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Escape}');
    expect(native?.open).toBe(true);

    await button.click();
    expect(updates).toEqual([1]);
    await expect.element(page.getByRole('status')).toHaveTextContent('Saving your game, then updating…');
    await expect.element(button).toBeDisabled();
  });
});
