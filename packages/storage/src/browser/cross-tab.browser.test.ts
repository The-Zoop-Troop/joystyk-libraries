// Preferences across tabs in real Chromium (gp-d4v). Two storages opened on one IndexedDB
// database stand for two tabs: each has its own connection and its own BroadcastChannel, and
// BroadcastChannel delivers to every other channel of the same name, in this document or
// another. The storage-event fallback needs a second document, so it uses a same-origin
// iframe: the browser fires `storage` events only in documents other than the writer.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeFeed, PreferencesSource, Storage, StoredPreferences } from '../index.ts';
import {
  broadcastChangeFeed,
  CHANGE_CHANNEL,
  openBrowserStorage,
  openChangeFeed,
  storageEventChangeFeed,
} from './index.ts';

const PLAYER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const names: string[] = [];
const opened: Storage[] = [];
const frames: HTMLIFrameElement[] = [];
let counter = 0;

const freshName = (): string => {
  const name = `joystyk-cross-tab-${Date.now()}-${(counter += 1)}`;
  names.push(name);
  return name;
};

const open = async (name: string, changes?: ChangeFeed): Promise<Storage> => {
  const storage = await openBrowserStorage({ indexedDb: { name }, ...(changes === undefined ? {} : { changes }) });
  opened.push(storage);
  return storage;
};

/** Resolves with the first value, or rejects once `ms` pass: a bound on failure, not a wait. */
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`No ${what} within ${ms} ms`)), ms)),
  ]);

/** The next preferences a store tells its subscribers about, and where they came from. */
const next = (storage: Storage, player = PLAYER): Promise<StoredPreferences & { source: PreferencesSource }> =>
  new Promise((resolve) => {
    const stop = storage.player(player).preferences.subscribe((preferences, source) => {
      stop();
      resolve({ ...preferences, source });
    });
  });

/** A second same-origin document, standing for another tab. */
const otherDocument = async (): Promise<Window> => {
  const frame = document.createElement('iframe');
  frames.push(frame);
  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  document.body.append(frame);
  await loaded;
  if (frame.contentWindow === null) throw new Error('the frame has no window');
  return frame.contentWindow;
};

afterEach(async () => {
  for (const storage of opened.splice(0)) storage.close();
  for (const frame of frames.splice(0)) frame.remove();
  for (const name of names.splice(0)) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }
});

describe('preferences across tabs', () => {
  it('tells another open tab when a preference changes', async () => {
    const name = freshName();
    const [tabA, tabB] = [await open(name), await open(name)];
    const seen = next(tabB);
    const written = await tabA.player(PLAYER).preferences.update({ reducedMotion: 'reduce', theme: 'dark' });
    expect(written.ok).toBe(true);
    expect(await within(seen, 5_000, 'change in the other tab')).toMatchObject({
      reducedMotion: 'reduce',
      theme: 'dark',
      source: 'other-tab',
    });
  });

  it('tells this tab’s own subscribers once, as this tab’s change', async () => {
    const name = freshName();
    const tab = await open(name);
    const sources: PreferencesSource[] = [];
    tab.player(PLAYER).preferences.subscribe((_, source) => sources.push(source));
    const other = await open(name);
    const seen = next(other);
    await tab.player(PLAYER).preferences.update({ sound: false });
    await within(seen, 5_000, 'change in the other tab');
    expect(sources).toEqual(['this-tab']);
  });

  it('leaves another player’s subscribers alone', async () => {
    const name = freshName();
    const [tabA, tabB] = [await open(name), await open(name)];
    const stranger = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const strangerHeard: StoredPreferences[] = [];
    tabB.player(stranger).preferences.subscribe((p) => strangerHeard.push(p));
    const seen = next(tabB);
    await tabA.player(PLAYER).preferences.update({ volume: 0.25 });
    await within(seen, 5_000, 'change in the other tab');
    expect(strangerHeard).toEqual([]);
  });

  it('falls back to the storage event, across documents, where BroadcastChannel is missing', async () => {
    const name = freshName();
    const other = await otherDocument();
    // The host has no BroadcastChannel, so openChangeFeed picks the storage event.
    const host = {
      localStorage: window.localStorage,
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
    };
    const tabA = await open(name, openChangeFeed(host));
    const tabB = await open(name, storageEventChangeFeed(other));
    const seen = next(tabB);
    await tabA.player(PLAYER).preferences.update({ reducedMotion: 'reduce' });
    expect(await within(seen, 5_000, 'change through the storage event')).toMatchObject({
      reducedMotion: 'reduce',
      source: 'other-tab',
    });
    // Nothing stays behind in localStorage.
    expect(window.localStorage.getItem(CHANGE_CHANNEL)).toBeNull();
  });

  it('reaches another document over BroadcastChannel, and ignores messages that aren’t changes', async () => {
    const name = freshName();
    const other = await otherDocument();
    // The frame's own BroadcastChannel, so the message crosses from one document to another.
    const otherFeed = broadcastChangeFeed(
      (other as Window & { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel,
    );
    const tabB = await open(name, otherFeed);
    const seen = next(tabB);
    // A stray message on the channel is parsed and dropped.
    const stray = new BroadcastChannel(CHANGE_CHANNEL);
    stray.postMessage({ kind: 'preferences', playerId: '../../etc' });
    stray.postMessage('hello');
    stray.close();
    const tabA = await open(name);
    await tabA.player(PLAYER).preferences.update({ theme: 'light' });
    expect(await within(seen, 5_000, 'change in the other document')).toMatchObject({
      theme: 'light',
      source: 'other-tab',
    });
  });
});
