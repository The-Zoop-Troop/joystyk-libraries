// Safe points (offline-and-updates.md, Rule 2): the page may offer an update only where
// nothing can be lost: outside play, on the results screen, or during play when the session
// says so (`meta.safePoint`, which defaults to "the game is over"). The launcher reports every
// change as a `joystyk:safe-point` event on the document; the PWA listens with
// `watchSafePoints` and holds its update prompt until `safe` is true.
import { command, defineDriver, type Command } from '@gyral/core';

export const SAFE_POINT_EVENT = 'joystyk:safe-point';

export type SafePointDetail = {
  /** True when an update or a reload would lose nothing. */
  readonly safe: boolean;
  /** The game the launcher is showing. */
  readonly gameId: string;
};

/** Reports a change of safe point. Substitute it by name ('safe-point') in tests. */
export const safePointDriver = defineDriver<SafePointDetail, void>({
  name: 'safe-point',
  run: (detail) => {
    document.dispatchEvent(new CustomEvent<SafePointDetail>(SAFE_POINT_EVENT, { detail }));
  },
});

export const reportSafePoint = <M>(detail: SafePointDetail): Command<M> =>
  command<SafePointDetail, void, unknown, M>(safePointDriver, detail, {});

/**
 * Calls `listener` with every safe-point report on the page (the PWA's update prompt).
 * Until a launcher reports, a page without one is a safe point. Returns how to stop.
 */
export const watchSafePoints = (
  listener: (detail: SafePointDetail) => void,
  target: EventTarget = document,
): (() => void) => {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail === 'object' && detail !== null && typeof (detail as SafePointDetail).safe === 'boolean') {
      listener(detail as SafePointDetail);
    }
  };
  target.addEventListener(SAFE_POINT_EVENT, handler);
  return () => target.removeEventListener(SAFE_POINT_EVENT, handler);
};

/**
 * A forced security update (offline-and-updates.md, Rule 2) can't wait for the game to reach
 * a safe point, so it asks for one: every game stage on the page stops play and writes its
 * position (the last completed move, or a paused checkpoint of a real-time game), then hands
 * the write to `waitUntil`. Rooms and games that save themselves have nothing to add.
 */
export const SAVE_REQUEST_EVENT = 'joystyk:save-request';

export type SaveRequestDetail = {
  /** Holds the request open until `work` settles. */
  readonly waitUntil: (work: Promise<unknown>) => void;
};

/**
 * Asks every game on the page to save now, for a forced update. Resolves once each save has
 * landed or failed; at once when no game is in play. Play stays paused afterwards: the page
 * is about to reload.
 */
export const requestSave = async (target: EventTarget = document): Promise<void> => {
  const pending: Promise<unknown>[] = [];
  target.dispatchEvent(
    new CustomEvent<SaveRequestDetail>(SAVE_REQUEST_EVENT, { detail: { waitUntil: (work) => pending.push(work) } }),
  );
  await Promise.allSettled(pending);
};
