// The page's side of the worker: register it, check for updates, offer an update only at a
// safe point (Rule 2), force a security update when the flag file's minimum release says so
// (Rule 2, ./forced.ts), honor the kill switch (Rule 5), and, while the page is idle at a safe
// point and online, refresh pinned games and prefetch daily puzzles (offline-and-updates.md).
// Registration waits for the page's `load` event, so it never competes with the page itself,
// and the elements and the pinning code load after it, in a chunk of their own.
import { watchOfflineAvailability } from './availability.ts';
import { isDisabled } from '../control.ts';
import { isPwaCache, MESSAGES, SW_URL } from '../names.ts';
import { shouldOfferUpdate } from '../routing.ts';
import { readControl } from './control.ts';
import type { UpdateToast } from './elements.ts';
import { watchForcedUpdates, type ForcedUpdates, type SecurityNotice } from './forced.ts';

const loadElements = async (): Promise<void> => (await import('./elements.ts')).definePwaElements();

/** A daily game's content client, as `@joystyk/daily/browser`'s `createDailyClient` makes it. */
export type DailyPrefetcher = {
  readonly gameId: string;
  prefetch(today: string): Promise<unknown>;
};

/** How the page shows "Update ready". The default is `<jy-update-toast>`. */
export interface UpdatePrompt {
  show(choose: (choice: 'refresh' | 'later') => void): void;
  hide(): void;
}

export type PwaOptions = {
  /** This build's release ID, for diagnostics. */
  readonly release: string;
  /**
   * Subscribes to safe-point reports: pass the launcher's `watchSafePoints`
   * (`@joystyk/launcher/browser`). Without it, every moment counts as safe.
   */
  readonly watchSafePoints?: (listener: (detail: { readonly safe: boolean }) => void) => () => void;
  /** How often to look for a new worker. Default 45 minutes, as the blog does. */
  readonly updateCheckMs?: number;
  /**
   * The daily games' content clients. At a safe point, an installed app prefetches every
   * daily game, and a browser tab only the pinned ones (D-46: today and tomorrow, no further).
   */
  readonly daily?: readonly DailyPrefetcher[];
  readonly prompt?: UpdatePrompt;
  /**
   * When this release's code was committed (`__JOYSTYK_RELEASE_TIME__`). With it, the page
   * honors the flag file's minimum release and forces a security update when it is older.
   */
  readonly releaseTime?: string;
  /** Saves the game in play before a forced update: pass the launcher's `requestSave`. */
  readonly saveGame?: () => Promise<void>;
  /** How often to read the flag file for a minimum release. Default 15 minutes. */
  readonly controlCheckMs?: number;
  readonly securityNotice?: SecurityNotice;
};

export interface PwaController {
  /** The release this page runs. */
  readonly release: string;
  /** The registration, or null without a worker (unsupported, failed, or switched off). */
  readonly ready: Promise<ServiceWorkerRegistration | null>;
  /** Looks for a new worker now. */
  checkForUpdate(): Promise<void>;
  dispose(): void;
}

const DEFAULT_UPDATE_CHECK_MS = 45 * 60 * 1000;
/** Refresh pins and prefetch at most this often per page. */
const IDLE_WORK_MS = 30 * 60 * 1000;

/** The daily games to prefetch: all of them in an installed app, otherwise the pinned ones. */
export const dailyToPrefetch = (
  prefetchers: readonly DailyPrefetcher[],
  context: { readonly installed: boolean; readonly pinned: readonly string[] },
): DailyPrefetcher[] => prefetchers.filter((p) => context.installed || context.pinned.includes(p.gameId));

/** Unregisters every worker of this origin and deletes the PWA's caches. Saves are untouched. */
export const disablePwa = async (): Promise<void> => {
  for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  if (!('caches' in window)) return;
  const names = (await caches.keys()).filter(isPwaCache);
  await Promise.all(names.map((name) => caches.delete(name)));
};

/** The default prompt: `<jy-update-toast>` at the end of the body. */
export const toastPrompt = (): UpdatePrompt => {
  let toast: UpdateToast | null = null;
  let wanted = false;
  return {
    show: (choose) => {
      wanted = true;
      void loadElements().then(() => {
        if (!wanted) return;
        toast ??= document.createElement('jy-update-toast');
        toast.onChoice = choose;
        if (!toast.isConnected) document.body.append(toast);
      });
    },
    hide: () => {
      wanted = false;
      toast?.remove();
    },
  };
};

const isInstalled = (): boolean =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

type NavigationLike = EventTarget;

/** Resolves with `promise`, or with undefined after `ms`. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

/** Resolves once `worker` reaches `state`, or is thrown away. */
const reaches = (worker: ServiceWorker, state: ServiceWorkerState): Promise<void> =>
  new Promise((resolve) => {
    const done = (): boolean => worker.state === state || worker.state === 'redundant';
    if (done()) return resolve();
    const listener = (): void => {
      if (!done()) return;
      worker.removeEventListener('statechange', listener);
      resolve();
    };
    worker.addEventListener('statechange', listener);
  });

/** Runs `work` once the page has loaded, so nothing competes with the page itself. */
const afterLoad = (work: () => void): void => {
  if (document.readyState === 'complete') work();
  else addEventListener('load', work, { once: true });
};

const forcedUpdates = (options: PwaOptions, prepare?: () => Promise<void>): ForcedUpdates | null =>
  options.releaseTime === undefined
    ? null
    : watchForcedUpdates({
        releaseTime: options.releaseTime,
        ...(options.saveGame === undefined ? {} : { saveGame: options.saveGame }),
        ...(options.controlCheckMs === undefined ? {} : { checkMs: options.controlCheckMs }),
        ...(options.securityNotice === undefined ? {} : { notice: options.securityNotice }),
        ...(prepare === undefined ? {} : { prepare }),
      });

/**
 * Registers /sw.js and runs the update flow. Call once per page, in production builds only.
 * A new worker installs and waits; the page shows "Update ready" only while the launcher
 * reports a safe point, then posts SKIP_WAITING and reloads once the new worker controls it.
 */
export const registerPwa = (options: PwaOptions): PwaController => {
  if (!('serviceWorker' in navigator)) {
    // No worker, but a forced update still reaches the page.
    const forced = forcedUpdates(options);
    if (forced !== null) afterLoad(() => void forced.check());
    return {
      release: options.release,
      ready: Promise.resolve(null),
      checkForUpdate: async () => undefined,
      dispose: () => forced?.dispose(),
    };
  }
  const container = navigator.serviceWorker;
  const prompt = options.prompt ?? toastPrompt();
  const cleanups: (() => void)[] = [watchOfflineAvailability()];
  let registration: ServiceWorkerRegistration | null = null;
  let waiting: ServiceWorker | null = null;
  /** Another tab accepted an update: this page runs the old release under the new worker. */
  let stale = false;
  let safe = true;
  let dismissed = false;
  let accepted = false;
  let lastIdleWork = -Infinity;
  let idleWork: Promise<void> | null = null;

  /**
   * Before a forced update's reload: install the new release's worker and hand it the page,
   * within a few seconds. Best effort, since the reload fetches the new release's page from
   * the network either way; a worker left waiting is offered at the next safe point.
   */
  const activateNewWorker = async (): Promise<void> => {
    const reg = registration;
    if (reg === null || container.controller === null) return;
    await within(
      reg.update().catch(() => undefined),
      5_000,
    );
    const installing = reg.installing;
    if (installing !== null) await within(reaches(installing, 'installed'), 10_000);
    const next = reg.waiting;
    if (next === null) return;
    const handedOver = new Promise<void>((resolve) =>
      container.addEventListener('controllerchange', () => resolve(), { once: true }),
    );
    next.postMessage({ type: MESSAGES.skipWaiting });
    await within(handedOver, 3_000);
  };
  const forced = forcedUpdates(options, activateNewWorker);
  if (forced !== null) cleanups.push(() => forced.dispose());

  const choose = (choice: 'refresh' | 'later'): void => {
    if (choice === 'later') {
      dismissed = true;
      evaluate();
      return;
    }
    accepted = true;
    prompt.hide();
    // The reload happens on controllerchange, once the new worker is in charge; reloading
    // now would race the handoff. A stale page has nothing to wait for.
    if (waiting !== null && !stale) waiting.postMessage({ type: MESSAGES.skipWaiting });
    else location.reload();
  };

  const runIdleWork = (): void => {
    if (idleWork !== null || !navigator.onLine || container.controller === null) return;
    if (performance.now() - lastIdleWork < IDLE_WORK_MS) return;
    lastIdleWork = performance.now();
    idleWork = (async () => {
      await (await import('./pins.ts')).refreshPinnedGames();
      const prefetchers = options.daily ?? [];
      if (prefetchers.length === 0) return;
      const pinned = (await (await import('./pinned.ts')).pinnedGames()).map((record) => record.id);
      const { today } = await import('@joystyk/daily/browser');
      const date = today();
      for (const client of dailyToPrefetch(prefetchers, { installed: isInstalled(), pinned }))
        await client.prefetch(date);
    })()
      .catch(() => undefined)
      .finally(() => {
        idleWork = null;
      });
  };

  function evaluate(): void {
    // A forced update's notice is up: no toast beside it, and no work behind it.
    if (forced?.forcing === true) {
      prompt.hide();
      return;
    }
    if (shouldOfferUpdate({ ready: waiting !== null || stale, safe, dismissed })) prompt.show(choose);
    else prompt.hide();
    if (safe) runIdleWork();
  }

  const track = (reg: ServiceWorkerRegistration): void => {
    // A worker may already be waiting from an earlier visit; `updatefound` won't fire for it.
    if (reg.waiting !== null && container.controller !== null) waiting = reg.waiting;
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        // The very first install has nothing to update from: no controller yet.
        if (installing.state === 'installed' && container.controller !== null) {
          waiting = installing;
          dismissed = false;
          evaluate();
        }
      });
    });
    evaluate();
  };

  const checkForUpdate = async (): Promise<void> => {
    try {
      await registration?.update();
    } catch {
      // Offline, or the server is down: try again at the next check.
    }
  };

  const onControllerChange = (): void => {
    // A forced update reloads by itself once the new worker is in charge.
    if (forced?.forcing === true) return;
    if (accepted) {
      location.reload();
      return;
    }
    if (container.controller === null) return;
    stale = true;
    dismissed = false;
    evaluate();
  };
  container.addEventListener('controllerchange', onControllerChange);
  cleanups.push(() => container.removeEventListener('controllerchange', onControllerChange));

  const onMessage = (event: MessageEvent): void => {
    if ((event.data as { type?: unknown } | null)?.type === MESSAGES.disabled) {
      waiting = null;
      stale = false;
      prompt.hide();
    }
  };
  container.addEventListener('message', onMessage);
  cleanups.push(() => container.removeEventListener('message', onMessage));

  if (options.watchSafePoints !== undefined) {
    cleanups.push(
      options.watchSafePoints((detail) => {
        safe = detail.safe;
        evaluate();
      }),
    );
  }

  const ready = new Promise<ServiceWorkerRegistration | null>((resolve) => {
    const start = async (): Promise<void> => {
      if (isDisabled(forced === null ? await readControl() : await forced.check())) {
        await disablePwa().catch(() => undefined);
        resolve(null);
        return;
      }
      try {
        // Some environments (automation that blocks workers) resolve without a registration.
        registration =
          ((await container.register(SW_URL, { scope: '/', updateViaCache: 'none' })) as
            ServiceWorkerRegistration | undefined) ?? null;
      } catch {
        registration = null;
      }
      // Without one the site still works fully, only without offline play or update prompts.
      if (registration !== null) track(registration);
      resolve(registration);
    };
    afterLoad(() => {
      void loadElements();
      void start();
    });
  });

  // Periodic checks, a check when the tab comes back, and one on each navigation to the index.
  const interval = setInterval(() => void checkForUpdate(), options.updateCheckMs ?? DEFAULT_UPDATE_CHECK_MS);
  cleanups.push(() => clearInterval(interval));
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
  const navigation = (globalThis as { navigation?: NavigationLike }).navigation;
  if (navigation !== undefined) {
    const onNavigate = (): void => {
      if (location.pathname !== '/') return;
      void checkForUpdate();
      void forced?.check();
    };
    navigation.addEventListener('navigatesuccess', onNavigate);
    cleanups.push(() => navigation.removeEventListener('navigatesuccess', onNavigate));
  }

  return {
    release: options.release,
    ready,
    checkForUpdate,
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      prompt.hide();
    },
  };
};
