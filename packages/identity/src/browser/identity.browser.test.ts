// The guest identity in real Chromium: Web Crypto randomness and IndexedDB persistence.
import { openBrowserStorage } from '@joystyk/storage/browser';
import { afterEach, expect, it } from 'vitest';
import { isDisplayName, isPlayerId } from '../index.ts';
import { createBrowserIdentity, cryptoRandom } from './index.ts';

const name = `joystyk-identity-test-${Date.now()}`;

afterEach(
  () =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }),
);

it('creates a guest with a crypto UUID and keeps it across reopening the database', async () => {
  const first = await openBrowserStorage({ indexedDb: { name } });
  const profile = await createBrowserIdentity(first).current();
  expect(isPlayerId(profile.id)).toBe(true);
  expect(isDisplayName(profile.displayName)).toBe(true);
  first.close();

  const second = await openBrowserStorage({ indexedDb: { name } });
  expect(await createBrowserIdentity(second).current()).toEqual(profile);
  second.close();
});

it('gives two tabs opened together on a first visit one guest (gp-d4v)', async () => {
  // Two storages on one database stand for two tabs: separate connections, separate identities.
  const [tabA, tabB] = await Promise.all([
    openBrowserStorage({ indexedDb: { name } }),
    openBrowserStorage({ indexedDb: { name } }),
  ]);
  const [a, b] = await Promise.all([createBrowserIdentity(tabA).current(), createBrowserIdentity(tabB).current()]);
  expect(b).toEqual(a);
  tabA.close();
  tabB.close();
  const later = await openBrowserStorage({ indexedDb: { name } });
  expect(await createBrowserIdentity(later).current()).toEqual(a);
  later.close();
});

it('draws uniform floats in [0, 1)', () => {
  const draws = Array.from({ length: 1_000 }, cryptoRandom);
  expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
  expect(new Set(draws).size).toBeGreaterThan(990);
});
