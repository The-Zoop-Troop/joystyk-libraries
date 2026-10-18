import { bindPagePause, resumeAfter } from './legacy.ts';
export type PauseOptions = {
  pause(): void;
  resume(): void;
  announce(text: string): void;
  changed?(resuming: boolean): void;
  after?: (ms: number, done: () => void) => () => void;
};
/** Resume is explicit and cancellable; hiding during the countdown cancels it. */
export function bindPause(o: PauseOptions) {
  const abort = new AbortController(),
    { signal } = abort;
  let cancel: (() => void) | null = null;
  const pause = (): void => {
    cancel?.();
    cancel = null;
    o.changed?.(false);
    o.pause();
  };
  bindPagePause(pause, signal);
  return {
    pause,
    resume(): void {
      if (cancel !== null || document.hidden) return;
      o.announce('Resuming in one second.');
      o.changed?.(true);
      const after = o.after ?? resumeAfter;
      cancel = after(1000, () => {
        cancel = null;
        o.changed?.(false);
        if (!document.hidden) o.resume();
      });
    },
    dispose(): void {
      abort.abort();
      cancel?.();
      cancel = null;
    },
  };
}
