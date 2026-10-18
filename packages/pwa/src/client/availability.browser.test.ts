import { afterEach, expect, it } from 'vitest';
import { PIN_CHANGED, watchOfflineAvailability } from './availability.ts';
let dispose = () => {};
afterEach(() => {
  dispose();
  document.body.replaceChildren();
});
it('labels pinned and unpinned games, blocks unavailable navigation, and follows connection changes', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const catalog = host.attachShadow({ mode: 'open' });
  catalog.innerHTML =
    '<article><a href="/games/nim">Nim</a><jy-offline-availability game-id="nim"></jy-offline-availability></article><article><a href="/games/tally">Tally</a><jy-offline-availability game-id="tally"></jy-offline-availability></article>';
  let online = false;
  let pins = [{ id: 'nim' }];
  dispose = watchOfflineAvailability({ root: document, online: () => online, pins: async () => pins });
  const labels = [...catalog.querySelectorAll('jy-offline-availability')];
  await expect.poll(() => labels.map((l) => l.textContent)).toEqual(['Available offline', 'Unavailable offline']);
  const tally = catalog.querySelector<HTMLAnchorElement>('a[href="/games/tally"]')!;
  expect(tally.getAttribute('aria-disabled')).toBe('true');
  expect(tally.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }))).toBe(false);
  online = true;
  dispatchEvent(new Event('online'));
  await expect.poll(() => tally.hasAttribute('aria-disabled')).toBe(false);
  expect(labels[1]?.hasAttribute('hidden')).toBe(true);
  pins = [{ id: 'tally' }];
  dispatchEvent(new Event(PIN_CHANGED));
  await expect.poll(() => labels.map((l) => l.textContent)).toEqual(['', 'Available offline']);
  const newPage = document.createElement('section');
  newPage.innerHTML =
    '<article><a href="/games/tally">Tally</a><jy-offline-availability game-id="tally" hidden></jy-offline-availability></article>';
  catalog.replaceChildren(newPage);
  await expect.poll(() => newPage.querySelector('jy-offline-availability')?.textContent).toBe('Available offline');
  const newHost = document.createElement('div');
  const newCatalog = newHost.attachShadow({ mode: 'open' });
  newCatalog.innerHTML =
    '<article><a href="/games/tally">Tally</a><jy-offline-availability game-id="tally" hidden></jy-offline-availability></article>';
  catalog.replaceChildren(newHost);
  await expect.poll(() => newCatalog.querySelector('jy-offline-availability')?.textContent).toBe('Available offline');
});
