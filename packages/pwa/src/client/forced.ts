// Forced security updates (offline-and-updates.md, Rule 2). The page reads the flag file at
// start, every 15 minutes, whenever the tab comes back into view and on each navigation to
// the index. When the file names a minimum release later than this page's, the page shows a
// blocking notice and asks the launcher to save the game in play. Only when the player
// chooses Update now, and the save has landed, does it bring in the new worker and reload: a
// game never swaps code without that save (Rule 2). A page that can't reach the flag file
// reads no instruction, so offline play goes on.
import { mustUpdate, type Control } from '../control.ts';
import { readControl } from './control.ts';

/** How the page shows the notice. The default is `<jy-security-update>`. */
export interface SecurityNotice {
  /** Shows the blocking notice; `update` runs when the player chooses Update now. */
  show(update: () => void): void;
}

export type ForcedUpdateOptions = {
  /** This page's release time (`__JOYSTYK_RELEASE_TIME__`). */
  readonly releaseTime: string;
  /** Saves the game in play: the launcher's `requestSave`. Without it, nothing is saved. */
  readonly saveGame?: () => Promise<void>;
  /** Brings in the new release's worker before the reload, when there is one. */
  readonly prepare?: () => Promise<void>;
  /** How often to read the flag file. Default 15 minutes. */
  readonly checkMs?: number;
  readonly notice?: SecurityNotice;
  /** Reads the flag file; swapped in tests. */
  readonly read?: () => Promise<Control | null>;
  /** Reloads the page; swapped in tests. */
  readonly reload?: () => void;
};

export interface ForcedUpdates {
  /** Reads the flag file now and acts on it; resolves with what it said. */
  check(): Promise<Control | null>;
  /** Acts on a flag file read elsewhere. */
  observe(control: Control | null): void;
  /** True once the notice is up. */
  readonly forcing: boolean;
  dispose(): void;
}

const DEFAULT_CHECK_MS = 15 * 60 * 1000;

/** The default notice: `<jy-security-update>` at the end of the body. */
export const securityNotice = (): SecurityNotice => ({
  show: (update) => {
    void import('./elements.ts').then(({ definePwaElements }) => {
      definePwaElements();
      const notice = document.createElement('jy-security-update');
      notice.onUpdate = update;
      document.body.append(notice);
    });
  },
});

export const watchForcedUpdates = (options: ForcedUpdateOptions): ForcedUpdates => {
  const read = options.read ?? readControl;
  const reload = options.reload ?? (() => location.reload());
  const notice = options.notice ?? securityNotice();
  const cleanups: (() => void)[] = [];
  let forcing = false;

  const force = (): void => {
    if (forcing) return;
    forcing = true;
    // Saving starts with the notice: the notice stops input, and pausing stops a real-time
    // game from running on unattended behind it.
    const saved = Promise.resolve()
      .then(() => options.saveGame?.())
      .catch(() => undefined);
    notice.show(() => {
      void saved
        .then(() => options.prepare?.())
        .catch(() => undefined)
        .then(reload);
    });
  };

  const observe = (control: Control | null): void => {
    if (mustUpdate(control, options.releaseTime)) force();
  };

  const check = async (): Promise<Control | null> => {
    const control = await read();
    observe(control);
    return control;
  };

  const interval = setInterval(() => void check(), options.checkMs ?? DEFAULT_CHECK_MS);
  cleanups.push(() => clearInterval(interval));
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void check();
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));

  return {
    check,
    observe,
    get forcing() {
      return forcing;
    },
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
};
