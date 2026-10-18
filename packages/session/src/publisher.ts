// The Layer 1 publishing rules, shared by every runner in this package:
//   1. get() returns the latest published snapshot.
//   2. subscribe() delivers the current snapshot at once; unsubscribing twice is safe.
//   4. Each snapshot is one object, published whole (atomic).
//   5. Snapshots are deep-frozen when `freeze` is on (development builds).
//   6. After close(), nothing publishes and no listener is called.
import type { Reporter } from './ports.ts';
import { deepFreeze } from './values.ts';

export type Publisher<Snapshot> = {
  get(): Snapshot;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
  publish(snapshot: Snapshot): void;
  close(): void;
};

export const createPublisher = <Snapshot>(
  initial: Snapshot,
  options: { readonly freeze: boolean; readonly report: Reporter },
): Publisher<Snapshot> => {
  const seal = (snapshot: Snapshot): Snapshot => (options.freeze ? deepFreeze(snapshot) : snapshot);
  let current = seal(initial);
  let closed = false;
  const listeners = new Set<(snapshot: Snapshot) => void>();

  const call = (listener: (snapshot: Snapshot) => void, snapshot: Snapshot): void => {
    try {
      listener(snapshot);
    } catch (error) {
      // One broken subscriber must not starve the others or tear the session's state.
      options.report(error, 'A session listener threw.');
    }
  };

  return {
    get: () => current,
    subscribe: (listener) => {
      if (closed) return () => {};
      // Wrap so the same function can subscribe twice and unsubscribe each independently.
      const entry = (snapshot: Snapshot): void => call(listener, snapshot);
      listeners.add(entry);
      call(listener, current);
      return () => {
        listeners.delete(entry);
      };
    },
    publish: (snapshot) => {
      if (closed) return;
      current = seal(snapshot);
      const published = current;
      for (const listener of [...listeners]) {
        // A listener removed by an earlier one in this round is skipped.
        if (closed || !listeners.has(listener)) continue;
        listener(published);
      }
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
  };
};
