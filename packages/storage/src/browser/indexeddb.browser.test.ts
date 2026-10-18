// The IndexedDB backend in real Chromium: opening and upgrading, decode failures, a simulated
// quota and the persistent-storage helper.
import { ok } from '@joystyk/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { openStorage, type StorageBackend, type StorageNotice } from '../index.ts';
import {
  DATABASE_UPGRADES,
  isStoragePersisted,
  openBrowserStorage,
  openIndexedDbBackend,
  requestPersistentStorage,
  type DatabaseUpgrade,
} from './index.ts';

const PLAYER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const opened: StorageBackend[] = [];
const names: string[] = [];
let counter = 0;

const freshName = (): string => {
  const name = `joystyk-test-${Date.now()}-${(counter += 1)}`;
  names.push(name);
  return name;
};

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const open = async (name: string, upgrades?: readonly DatabaseUpgrade[]): Promise<StorageBackend> => {
  const backend = await openIndexedDbBackend({ name, upgrades });
  if (!backend.ok) throw new Error(backend.error.message);
  opened.push(backend.value);
  return backend.value;
};

/** Opens the database with the raw API, as another build or a corrupted profile would. */
const rawDb = (name: string): Promise<IDBDatabase> => request(indexedDB.open(name));

afterEach(async () => {
  for (const backend of opened.splice(0)) backend.close();
  for (const name of names.splice(0)) await request(indexedDB.deleteDatabase(name));
});

describe('opening and upgrading', () => {
  it('creates every object store on first open', async () => {
    const name = freshName();
    await open(name);
    const db = await rawDb(name);
    expect([...db.objectStoreNames].sort()).toEqual([
      'archive',
      'game-data',
      'identity',
      'preferences',
      'saves',
      'stats',
      'streaks',
    ]);
    expect(db.version).toBe(1);
    db.close();
  });

  it('runs only the newer upgrade steps and keeps existing data', async () => {
    const name = freshName();
    const v1 = await open(name);
    await v1.put('stats', 'kept', { version: 1, writtenAt: 1, value: 'still here' });
    v1.close();

    const ran: number[] = [];
    const upgrades: DatabaseUpgrade[] = [
      { version: 1, upgrade: (db, tx) => (ran.push(1), DATABASE_UPGRADES[0]?.upgrade(db, tx)) },
      { version: 2, upgrade: (db) => (ran.push(2), db.createObjectStore('extra')) },
    ];
    const v2 = await open(name, upgrades);
    expect(ran).toEqual([2]);
    expect(await v2.get('stats', 'kept')).toEqual(ok({ version: 1, writtenAt: 1, value: 'still here' }));
    v2.close();
    const db = await rawDb(name);
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains('extra')).toBe(true);
    db.close();
  });

  it('refuses upgrade lists with gaps', async () => {
    expect(() => openIndexedDbBackend({ name: freshName(), upgrades: [{ version: 2, upgrade: () => {} }] })).toThrow(
      RangeError,
    );
  });

  it('closes for a newer version in another tab, then reports Unavailable', async () => {
    const name = freshName();
    let told = false;
    const old = await openIndexedDbBackend({ name, onVersionChange: () => (told = true) });
    if (!old.ok) throw new Error('open failed');
    const upgrades = [...DATABASE_UPGRADES, { version: 2, upgrade: () => {} }];
    await open(name, upgrades);
    expect(told).toBe(true);
    const result = await old.value.get('stats', 'x');
    expect(result.ok || result.error.code).toBe('Unavailable');
  });

  it('falls back to memory with a notice where IndexedDB is refused', async () => {
    const notices: StorageNotice[] = [];
    const refusing = {
      open: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    } as unknown as IDBFactory;
    const storage = await openBrowserStorage({ onNotice: (n) => notices.push(n), indexedDb: { factory: refusing } });
    expect(notices).toMatchObject([{ code: 'Unavailable', store: null }]);
    const player = storage.player(PLAYER);
    await player.preferences.update({ sound: false });
    expect((await player.preferences.get()).ok).toBe(true);
  });
});

describe('records over IndexedDB', () => {
  it('round-trips saves and lists keys by prefix', async () => {
    const backend = await open(freshName());
    const player = openStorage({ backend, now: () => 5 }).player(PLAYER);
    const envelope = {
      gameId: 'nim',
      build: '1.0.0',
      rulesVersion: 1,
      saveVersion: 1,
      rng: { algorithm: 'sfc32', words: [1, 2, 3, 4] },
      seats: [{ id: 0, name: 'Pixel Fox 42', controller: 'human' as const }],
      state: { heap: 3 },
    };
    await player.saves.write('nim', 'b', envelope);
    await player.saves.write('nim', 'a', envelope);
    await player.saves.write('nim-two', 'a', { ...envelope, gameId: 'nim-two' });
    const list = await player.saves.list('nim');
    expect(list.ok && list.value.map((s) => s.slot)).toEqual(['a', 'b']);
    expect(await backend.keys('saves', '')).toEqual(ok([`${PLAYER}/nim-two/a`, `${PLAYER}/nim/a`, `${PLAYER}/nim/b`]));
  });

  it('discards a corrupt record written behind its back, with a notice', async () => {
    const name = freshName();
    const backend = await open(name);
    const db = await rawDb(name);
    const tx = db.transaction('preferences', 'readwrite');
    tx.objectStore('preferences').put({ version: 1, writtenAt: 1, value: { theme: 'neon' } }, PLAYER);
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();

    const notices: StorageNotice[] = [];
    const player = openStorage({ backend, onNotice: (n) => notices.push(n) }).player(PLAYER);
    const preferences = await player.preferences.get();
    expect(preferences.ok && preferences.value.theme).toBe('system');
    expect(notices).toMatchObject([{ code: 'RecordDiscarded', store: 'preferences', key: PLAYER }]);
    expect(await backend.get('preferences', PLAYER)).toEqual(ok(undefined));
  });

  it('discards a stored value that is not JSON', async () => {
    const name = freshName();
    const backend = await open(name);
    const db = await rawDb(name);
    const tx = db.transaction('stats', 'readwrite');
    tx.objectStore('stats').put({ version: 1, writtenAt: 1, value: new Date(0) }, `${PLAYER}/nim`);
    await new Promise((resolve) => (tx.oncomplete = resolve));
    db.close();

    const notices: StorageNotice[] = [];
    const stats = await openStorage({ backend, onNotice: (n) => notices.push(n) })
      .player(PLAYER)
      .stats.get('nim');
    expect(stats.ok && stats.value.played).toBe(0);
    expect(notices[0]?.code).toBe('RecordDiscarded');
  });
});

// Chromium's real quota can't be reached here: Playwright's contexts are off the record, and
// `Storage.overrideQuotaForOrigin` over CDP leaves their quota unchanged. So these tests make
// IndexedDB throw the browser's own QuotaExceededError from `put` for chosen keys, and
// everything around it (transactions, mapping, the archive retry, notices) runs for real.
const failPutsFor = (keys: Set<string>): (() => void) => {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function put(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (typeof key === 'string' && keys.has(key)) {
      keys.delete(key);
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }
    return original.call(this, value, key);
  };
  return () => {
    IDBObjectStore.prototype.put = original;
  };
};

describe('quota', () => {
  const key = `${PLAYER}/nim/big`;

  it('maps QuotaExceededError to QuotaExceeded, with a notice, after one retry', async () => {
    const backend = await open(freshName());
    const notices: StorageNotice[] = [];
    const games = openStorage({ backend, onNotice: (n) => notices.push(n) })
      .player(PLAYER)
      .gameStorage('nim');
    // Fails twice: the first write and the retry after clearing the archive.
    const restore = failPutsFor(new Set([key]));
    const twice = failPutsFor(new Set([key]));
    try {
      await expect(games.set('big', 'data')).rejects.toMatchObject({ error: { code: 'QuotaExceeded' } });
    } finally {
      twice();
      restore();
    }
    expect(notices).toMatchObject([{ code: 'QuotaExceeded', store: 'game-data', key }]);
    // Writes work again once space is free.
    await games.set('big', 'data');
    expect(await games.get('big')).toBe('data');
  });

  it('clears the archive to make room and retries the write', async () => {
    const backend = await open(freshName());
    await backend.put('archive', 'old-junk', { raw: 'set aside long ago' });
    const notices: StorageNotice[] = [];
    const games = openStorage({ backend, onNotice: (n) => notices.push(n) })
      .player(PLAYER)
      .gameStorage('nim');
    const restore = failPutsFor(new Set([key]));
    try {
      await games.set('big', 'data');
    } finally {
      restore();
    }
    expect(await games.get('big')).toBe('data');
    expect(await backend.keys('archive', '')).toEqual(ok([]));
    expect(notices).toEqual([]);
  });
});

describe('persistent storage', () => {
  it('asks the real browser and agrees with persisted()', async () => {
    const result = await requestPersistentStorage();
    expect(['persisted', 'denied']).toContain(result);
    expect(await isStoragePersisted()).toBe((await navigator.storage.persisted()) ? 'persisted' : 'denied');
  });
});
