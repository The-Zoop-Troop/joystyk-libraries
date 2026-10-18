// The browser's change feeds (gp-d4v): BroadcastChannel where it exists, and the `storage`
// event where it doesn't. Both reach every other same-origin tab and frame, never the sender.
import type { ChangeFeed, StorageChange } from '../changes.ts';

/** The channel name, and the localStorage key the fallback writes. */
export const CHANGE_CHANNEL = 'joystyk-storage';

type Listener = (message: unknown) => void;

/** What `openChangeFeed` needs from a window. */
export type ChangeFeedHost = Pick<Window, 'localStorage' | 'addEventListener' | 'removeEventListener'> & {
  readonly BroadcastChannel?: typeof BroadcastChannel;
};

const listenerSet = () => {
  const listeners = new Set<Listener>();
  return {
    deliver: (message: unknown): void => {
      for (const listener of [...listeners]) listener(message);
    },
    subscribe: (listener: Listener): (() => void) => {
      const entry: Listener = (message) => listener(message);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    clear: (): void => listeners.clear(),
  };
};

/** A feed over BroadcastChannel, which delivers to every other channel of the same name. */
export const broadcastChangeFeed = (Channel: typeof BroadcastChannel, name: string = CHANGE_CHANNEL): ChangeFeed => {
  const listeners = listenerSet();
  let channel: BroadcastChannel | null = new Channel(name);
  channel.onmessage = (event: MessageEvent) => listeners.deliver(event.data);
  return {
    publish: (change: StorageChange) => {
      try {
        channel?.postMessage(change);
      } catch {
        // A closed or broken channel: the other tabs aren't told.
      }
    },
    subscribe: listeners.subscribe,
    close: () => {
      listeners.clear();
      channel?.close();
      channel = null;
    },
  };
};

/**
 * The fallback: writing to localStorage fires a `storage` event in every other same-origin
 * document. Each write is unique, so a repeated change still fires, and the key is removed
 * at once, so nothing stays behind.
 */
export const storageEventChangeFeed = (
  host: Pick<ChangeFeedHost, 'localStorage' | 'addEventListener' | 'removeEventListener'>,
  key: string = CHANGE_CHANNEL,
): ChangeFeed => {
  const listeners = listenerSet();
  let sent = 0;
  let open = true;
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== key || event.newValue === null) return;
    let message: unknown;
    try {
      message = (JSON.parse(event.newValue) as { readonly change?: unknown } | null)?.change;
    } catch {
      return;
    }
    listeners.deliver(message);
  };
  host.addEventListener('storage', onStorage);
  return {
    publish: (change: StorageChange) => {
      if (!open) return;
      try {
        sent += 1;
        host.localStorage.setItem(key, JSON.stringify({ change, write: `${Date.now()}-${sent}-${Math.random()}` }));
        host.localStorage.removeItem(key);
      } catch {
        // localStorage is blocked or full: the other tabs aren't told.
      }
    },
    subscribe: listeners.subscribe,
    close: () => {
      open = false;
      listeners.clear();
      host.removeEventListener('storage', onStorage);
    },
  };
};

/** A feed that tells nobody, where neither BroadcastChannel nor localStorage works. */
const silentFeed = (): ChangeFeed => ({ publish: () => {}, subscribe: () => () => {}, close: () => {} });

/** BroadcastChannel when the browser has it, then the `storage` event, then nothing. */
export const openChangeFeed = (host: ChangeFeedHost = window): ChangeFeed => {
  if (typeof host.BroadcastChannel === 'function') return broadcastChangeFeed(host.BroadcastChannel);
  try {
    // Reading localStorage throws where site data is blocked.
    if (typeof host.localStorage?.setItem === 'function') return storageEventChangeFeed(host);
  } catch {
    // Fall through.
  }
  return silentFeed();
};
