import { defineDriver, subscription, type DriverOverrides } from '@gyral/core';
/** Shared driver adapter; callers keep their public driver names and typed HUD projection. */
export function createControlDrivers<Snapshot, Hud, Action>(o: {
  hud: string;
  action: string;
  subscribe: (emit: (snapshot: Snapshot) => void) => () => void;
  project: (snapshot: Snapshot) => Hud;
  same: (a: Hud, b: Hud) => boolean;
  dispatch: (action: Action) => void;
}): DriverOverrides {
  return {
    [o.hud]: subscription<Hud>(o.hud, (emit) => {
      let last: Hud | undefined;
      return o.subscribe((snapshot) => {
        const next = o.project(snapshot);
        if (last !== undefined && o.same(last, next)) return;
        last = next;
        emit(next);
      });
    }),
    [o.action]: defineDriver<Action, void>({ name: o.action, run: o.dispatch }),
  };
}
/** A countdown handle is a cancellation function, so disposal cannot leave a late resume. */
export function resumeAfter(delay: number, done: () => void): () => void {
  let active = true;
  const timer = setTimeout(() => {
    if (active) {
      active = false;
      done();
    }
  }, delay);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}
/** Shared automatic pause lifecycle. No resume is inferred from gaining focus. */
export function bindPagePause(pause: () => void, signal?: AbortSignal): () => void {
  const abort = new AbortController();
  signal?.addEventListener('abort', () => abort.abort(), { once: true });
  window.addEventListener('blur', pause, { signal: abort.signal });
  window.addEventListener('pagehide', pause, { signal: abort.signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) pause();
    },
    { signal: abort.signal },
  );
  return () => abort.abort();
}
export const SWIPE_THRESHOLD = 24;
export function swipeDirection(
  x: number,
  y: number,
  threshold = SWIPE_THRESHOLD,
): 'up' | 'down' | 'left' | 'right' | null {
  if (Math.max(Math.abs(x), Math.abs(y)) < threshold) return null;
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : y > 0 ? 'down' : 'up';
}
export const ARROW_DIRECTIONS = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' } as const;
export const LETTER_DIRECTIONS = { w: 'up', s: 'down', a: 'left', d: 'right' } as const;
