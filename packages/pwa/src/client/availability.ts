import { isGameId } from '@joystyk/contracts';
import { pinnedGames } from './pinned.ts';

export const PIN_CHANGED = 'joystyk:pin-changed';
export type AvailabilityPorts = {
  readonly root: Document;
  readonly online: () => boolean;
  readonly pins: () => Promise<readonly { readonly id: string }[]>;
};

/** Keep catalog labels accurate across SPA navigation and pin changes. One cache read per
 * refresh serves the entire listing. Unavailable links explain their state and do not
 * navigate to a broken game while offline. */
export const watchOfflineAvailability = (
  ports: AvailabilityPorts = {
    root: document,
    online: () => navigator.onLine,
    pins: () => pinnedGames(),
  },
): (() => void) => {
  let disposed = false;
  let generation = 0;
  let scheduled = false;
  const roots = (): (Document | ShadowRoot)[] => {
    const found: (Document | ShadowRoot)[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      found.push(root);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot !== null) visit(element.shadowRoot);
    };
    visit(ports.root);
    return found;
  };
  const refresh = async (): Promise<void> => {
    const current = ++generation;
    const ids = new Set((await ports.pins().catch(() => [])).map((pin) => pin.id));
    if (disposed || current !== generation) return;
    const offline = !ports.online();
    const surfaces = roots();
    observer.disconnect();
    for (const surface of surfaces) observer.observe(surface, { childList: true, subtree: true });
    for (const label of surfaces.flatMap((surface) => [
      ...surface.querySelectorAll<HTMLElement>('jy-offline-availability[game-id]'),
    ])) {
      const id = label.getAttribute('game-id');
      if (!isGameId(id)) continue;
      const pinned = ids.has(id);
      const message = pinned ? 'Available offline' : offline ? 'Unavailable offline' : '';
      if (label.textContent !== message) label.textContent = message;
      label.hidden = message === '';
      label.dataset['available'] = String(pinned);
      const scope = label.closest('article, li, tr') ?? label.parentElement;
      const link = scope?.querySelector<HTMLAnchorElement>(`a[href="/games/${id}"]`);
      if (link !== null && link !== undefined) {
        if (offline && !pinned) link.setAttribute('aria-disabled', 'true');
        else link.removeAttribute('aria-disabled');
      }
    }
  };
  const schedule = (): void => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) void refresh();
    });
  };
  const onClick = (event: Event): void => {
    const link = event
      .composedPath()
      .find((target) => target instanceof Element && target.matches('a[aria-disabled="true"]'));
    if (link !== undefined && !ports.online()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const observer = new MutationObserver((changes) => {
    // A newly mounted custom element may hold its labels inside a shadow root;
    // querySelector on the added host cannot see them. Text-only label updates
    // do not schedule another refresh.
    if (changes.some((change) => [...change.addedNodes].some((node) => node instanceof Element))) schedule();
  });
  observer.observe(ports.root, { childList: true, subtree: true });
  for (const name of ['online', 'offline', PIN_CHANGED]) addEventListener(name, schedule);
  ports.root.addEventListener('click', onClick, true);
  schedule();
  return () => {
    disposed = true;
    generation += 1;
    observer.disconnect();
    for (const name of ['online', 'offline', PIN_CHANGED]) removeEventListener(name, schedule);
    ports.root.removeEventListener('click', onClick, true);
  };
};
