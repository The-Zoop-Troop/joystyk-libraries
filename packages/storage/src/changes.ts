// Telling a browser's other tabs that stored data changed (gp-d4v). The core only describes
// the feed; '@joystyk/storage/browser' builds one over BroadcastChannel, or over the `storage`
// event where BroadcastChannel is missing. A change carries no data, only what changed:
// a tab that hears of one reads the record back from storage, through its schema.
import * as z from 'zod/mini';
import { isKeyPart } from './keys.ts';
import { validate } from './validate.ts';

// Node, browsers and workers all have structuredClone; the core's ES-only lib doesn't name it.
const { structuredClone } = globalThis as unknown as { structuredClone: <T>(value: T) => T };

/** A change another tab should hear about. Preferences are the only kind so far. */
export type StorageChange = { readonly kind: 'preferences'; readonly playerId: string };

const STORAGE_CHANGE = z.object({
  kind: z.literal('preferences'),
  playerId: z.string().check(z.refine(isKeyPart)),
});

/** Parses a message from another tab. It crossed a boundary, so anything else is null. */
export const parseStorageChange = async (message: unknown): Promise<StorageChange | null> => {
  const parsed = await validate(STORAGE_CHANGE, message);
  return parsed.ok ? parsed.value : null;
};

/**
 * Carries changes between the tabs of one browser. A feed never hands a change back to the
 * tab that published it; that tab has already told its own listeners.
 */
export interface ChangeFeed {
  /** Tells the other tabs. Never throws: a tab that can't be told simply isn't. */
  publish(change: StorageChange): void;
  /** Called with each message from another tab, unparsed. Returns an idempotent unsubscribe. */
  subscribe(listener: (message: unknown) => void): () => void;
  /** Stops listening and publishing. Idempotent. */
  close(): void;
}

/**
 * Feeds that reach each other in memory, for tests: each `feed()` stands for one tab, and a
 * change reaches every other feed asynchronously, as a browser delivers it.
 */
export const createMemoryChangeHub = (): { feed(): ChangeFeed } => {
  const feeds = new Set<Set<(message: unknown) => void>>();
  return {
    feed: () => {
      const listeners = new Set<(message: unknown) => void>();
      feeds.add(listeners);
      return {
        publish: (change) => {
          for (const other of feeds) {
            if (other === listeners) continue;
            void Promise.resolve().then(() => {
              for (const listener of [...other]) listener(structuredClone(change));
            });
          }
        },
        subscribe: (listener) => {
          const entry = (message: unknown): void => listener(message);
          listeners.add(entry);
          return () => {
            listeners.delete(entry);
          };
        },
        close: () => {
          listeners.clear();
          feeds.delete(listeners);
        },
      };
    },
  };
};
