// Reading and removing pins: what the offline page needs, without the code that pins.
import { parsePinnedCacheName, PIN_RECORD_PATH } from '../names.ts';
import { parsePinRecord, type PinRecord } from '../pin-record.ts';

/** The Cache Storage a pin lives in, and the origin its keys belong to. Tests pass fakes. */
export type CachePorts = {
  readonly caches: CacheStorage;
  readonly origin: string;
};

export const browserCachePorts = (): CachePorts => ({ caches: globalThis.caches, origin: location.origin });

/** Every pinned game, read from each pin's own record, sorted by name. */
export const pinnedGames = async (ports: CachePorts = browserCachePorts()): Promise<PinRecord[]> => {
  const found: PinRecord[] = [];
  for (const name of await ports.caches.keys()) {
    const pinned = parsePinnedCacheName(name);
    if (pinned === null) continue;
    const response = await (await ports.caches.open(name)).match(new URL(PIN_RECORD_PATH, ports.origin).href);
    const record = response === undefined ? null : parsePinRecord(await response.json().catch(() => null));
    if (record !== null && record.id === pinned.id && record.version === pinned.version) found.push(record);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, 'en'));
};

/** The game's pin, or null when it isn't available offline. */
export const pinStatus = async (gameId: string, ports: CachePorts = browserCachePorts()): Promise<PinRecord | null> =>
  (await pinnedGames(ports)).find((record) => record.id === gameId) ?? null;

/** Removes every pinned build of the game. */
export const unpinGame = async (gameId: string, ports: CachePorts = browserCachePorts()): Promise<void> => {
  for (const name of await ports.caches.keys()) {
    if (parsePinnedCacheName(name)?.id === gameId) await ports.caches.delete(name);
  }
};
