// Persistent storage (offline-and-updates.md, "Cache tiers"): the PWA asks for it when a
// player first pins a game, so the browser won't evict saves and pinned games under pressure.

/** The parts of `navigator.storage` these helpers use. */
export type StorageManagerLike = {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
};

/** `persisted`: the browser won't evict this site's data. `denied`: it may. `unsupported`: it can't say. */
export type PersistResult = 'persisted' | 'denied' | 'unsupported';

const defaultManager = (): StorageManagerLike | undefined =>
  (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage;

/**
 * Asks the browser to keep this site's data. Call it from the player's gesture of pinning a
 * game; never on page load. Already-persisted storage resolves without asking again, and a
 * browser that throws counts as `unsupported`.
 */
export const requestPersistentStorage = async (
  manager: StorageManagerLike | undefined = defaultManager(),
): Promise<PersistResult> => {
  if (manager?.persist === undefined) return 'unsupported';
  try {
    if ((await manager.persisted?.()) === true) return 'persisted';
    return (await manager.persist()) ? 'persisted' : 'denied';
  } catch {
    return 'unsupported';
  }
};

/** Whether the browser already keeps this site's data, without asking. */
export const isStoragePersisted = async (
  manager: StorageManagerLike | undefined = defaultManager(),
): Promise<PersistResult> => {
  if (manager?.persisted === undefined) return 'unsupported';
  try {
    return (await manager.persisted()) ? 'persisted' : 'denied';
  } catch {
    return 'unsupported';
  }
};

/** Bytes used and available to this site, or null where the browser won't say. */
export const estimateStorage = async (
  manager: StorageManagerLike | undefined = defaultManager(),
): Promise<{ readonly usage: number; readonly quota: number } | null> => {
  if (manager?.estimate === undefined) return null;
  try {
    const { usage, quota } = await manager.estimate();
    return usage === undefined || quota === undefined ? null : { usage, quota };
  } catch {
    return null;
  }
};
