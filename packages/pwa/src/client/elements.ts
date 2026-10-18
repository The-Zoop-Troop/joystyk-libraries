// The PWA's frame UI, as small custom elements with no framework: the "Update ready" toast,
// the forced security update's notice and the "Make available offline" control. Each renders
// into its own shadow root and styles itself with a constructed stylesheet, which the site's
// CSP allows, and reads the frame's design tokens (@joystyk/ui/tokens.css) through
// inheritance, with plain fallbacks. None renders anything until the page needs it.
import { PIN_CHANGED } from './availability.ts';
import { formatBytes } from '../asset-manifest.ts';
import { pinStatus, unpinGame } from './pinned.ts';
import { browserPinPorts, pinGame, type PinPorts } from './pins.ts';

const sheet = (css: string): CSSStyleSheet => {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
};

const BUTTON_CSS = `
  button {
    min-block-size: var(--jy-target-min, 2.75rem);
    padding: 0.25rem 1rem;
    border: 2px solid var(--jy-border, GrayText);
    border-radius: var(--jy-radius-pill, 999px);
    background: transparent;
    color: var(--jy-text, CanvasText);
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:focus-visible {
    outline: 3px solid var(--jy-focus-ring, Highlight);
    outline-offset: 2px;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  [hidden] {
    display: none !important;
  }
`;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

// --- The update toast ---------------------------------------------------------------------------

const TOAST_CSS = sheet(`
  :host {
    position: fixed;
    z-index: 1000;
    inset-block-end: max(1rem, env(safe-area-inset-bottom));
    inset-inline: max(1rem, env(safe-area-inset-left)) max(1rem, env(safe-area-inset-right));
    display: flex;
    justify-content: flex-end;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    max-inline-size: 28rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--jy-border, GrayText);
    border-radius: var(--jy-radius-m, 0.75rem);
    background: var(--jy-surface-raised, Canvas);
    color: var(--jy-text, CanvasText);
    box-shadow: var(--jy-shadow, 0 4px 16px rgb(0 0 0 / 0.2));
  }
  p {
    flex: 1 1 14rem;
    margin: 0;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
  }
  .primary {
    border-color: var(--jy-accent, LinkText);
    background: var(--jy-accent, LinkText);
    color: var(--jy-on-accent, Canvas);
  }
  ${BUTTON_CSS}
`);

/** `<jy-update-toast>`: says an update is ready and offers Refresh or Later. */
export class UpdateToast extends HTMLElement {
  #message = el('p');
  #refresh = el('button', { type: 'button', className: 'primary', textContent: 'Refresh' });
  #later = el('button', { type: 'button', textContent: 'Later' });
  /** Called with 'refresh' or 'later'. */
  onChoice: (choice: 'refresh' | 'later') => void = () => undefined;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [TOAST_CSS];
    const box = el('div', { className: 'toast' });
    // A polite status region: announced once, never stealing focus from a game or a page.
    const status = el('div');
    status.setAttribute('role', 'status');
    this.#message.append(el('strong', { textContent: 'Update ready.' }), ' Refresh to get the newest Joystyk.');
    status.append(this.#message);
    const actions = el('div', { className: 'actions' });
    actions.append(this.#refresh, this.#later);
    box.append(status, actions);
    root.append(box);
    this.#refresh.addEventListener('click', () => this.onChoice('refresh'));
    this.#later.addEventListener('click', () => this.onChoice('later'));
  }
}

// --- The security update notice -----------------------------------------------------------------

const SECURITY_CSS = sheet(`
  dialog {
    box-sizing: border-box;
    max-inline-size: min(28rem, calc(100vw - 2rem));
    padding: 1.25rem 1.5rem;
    border: 1px solid var(--jy-border, GrayText);
    border-radius: var(--jy-radius-m, 0.75rem);
    background: var(--jy-surface-raised, Canvas);
    color: var(--jy-text, CanvasText);
    box-shadow: var(--jy-shadow, 0 4px 16px rgb(0 0 0 / 0.2));
    font: inherit;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 0.6);
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: var(--jy-step-1, 1.25rem);
  }
  p {
    margin: 0 0 1rem;
  }
  .status:empty {
    display: none;
  }
  .primary {
    border-color: var(--jy-accent, LinkText);
    background: var(--jy-accent, LinkText);
    color: var(--jy-on-accent, Canvas);
  }
  ${BUTTON_CSS}
`);

/**
 * `<jy-security-update>`: the forced update's notice (offline-and-updates.md, Rule 2). A
 * modal dialog that takes focus and blocks the page: it gives the reason and one action,
 * Update now. Escape doesn't close it; the page reloads instead.
 */
export class SecurityUpdate extends HTMLElement {
  #dialog = el('dialog');
  #status = el('p', { className: 'status' });
  #button = el('button', { type: 'button', className: 'primary', textContent: 'Update now' });
  /** Called once, when the player chooses Update now. */
  onUpdate: () => void = () => undefined;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [SECURITY_CSS];
    const title = el('h2', { id: 'security-update-title', textContent: 'Security update' });
    const reason = el('p', {
      id: 'security-update-reason',
      textContent:
        'This version of Joystyk has a security problem that a new version fixes. Update to keep playing. Your game is saved first, so you can carry on where you left off.',
    });
    this.#dialog.setAttribute('aria-labelledby', title.id);
    this.#dialog.setAttribute('aria-describedby', reason.id);
    this.#dialog.setAttribute('closedby', 'none');
    this.#status.setAttribute('role', 'status');
    this.#dialog.append(title, reason, this.#status, this.#button);
    root.append(this.#dialog);
    // Blocking means blocking: Escape and close requests leave it open.
    this.#dialog.addEventListener('cancel', (event) => event.preventDefault());
    this.#dialog.addEventListener('close', () => {
      if (this.isConnected) this.#open();
    });
    this.#button.addEventListener('click', () => {
      if (this.#button.disabled) return;
      this.#button.disabled = true;
      this.#status.textContent = 'Saving your game, then updating…';
      this.onUpdate();
    });
  }

  connectedCallback(): void {
    this.#open();
  }

  #open(): void {
    if (!this.#dialog.open) this.#dialog.showModal();
    this.#button.focus();
  }
}

// --- The offline control ------------------------------------------------------------------------

const TOGGLE_CSS = sheet(`
  :host {
    display: block;
    min-block-size: var(--jy-target-min, 2.75rem);
  }
  .wrap {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
  }
  button[aria-pressed='true'] {
    border-color: var(--jy-success, currentColor);
  }
  .status {
    margin: 0;
    font-size: var(--jy-step--1, 0.9rem);
    color: var(--jy-text-muted, inherit);
  }
  ${BUTTON_CSS}
`);

/** Whether this browser can pin games at all. */
const canPin = (): boolean => 'serviceWorker' in navigator && 'caches' in window;

/**
 * `<jy-offline-toggle game-id="nim" game-name="Nim" assets="/games/nim/manifest.json">`: a
 * toggle button that pins the game for offline play or removes it. It stays empty (its box
 * reserved by the page's stylesheet) until a service worker is active, so a player never
 * sees a control that can't work.
 */
export class OfflineToggle extends HTMLElement {
  static readonly observedAttributes = ['game-id', 'assets'];
  /** Swapped in tests. */
  ports: () => PinPorts = browserPinPorts;
  #wrap = el('div', { className: 'wrap', hidden: true });
  #button = el('button', { type: 'button' });
  #status = el('p', { className: 'status' });
  #pinned = false;
  #busy = false;
  #generation = 0;
  #onConnection = (): void => this.#render();

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [TOGGLE_CSS];
    this.#button.append(el('span', { textContent: '⤓ ', ariaHidden: 'true' }), 'Make available offline');
    this.#status.setAttribute('role', 'status');
    this.#wrap.append(this.#button, this.#status);
    root.append(this.#wrap);
    this.#button.addEventListener('click', () => void this.#toggle());
  }

  get #gameId(): string {
    return this.getAttribute('game-id') ?? '';
  }

  get #gameName(): string {
    return this.getAttribute('game-name') ?? 'This game';
  }

  connectedCallback(): void {
    addEventListener('online', this.#onConnection);
    addEventListener('offline', this.#onConnection);
    void this.#load();
  }

  disconnectedCallback(): void {
    removeEventListener('online', this.#onConnection);
    removeEventListener('offline', this.#onConnection);
    this.#generation += 1;
  }

  attributeChangedCallback(): void {
    if (this.isConnected) void this.#load();
  }

  async #load(): Promise<void> {
    const generation = ++this.#generation;
    this.#wrap.hidden = true;
    if (!canPin() || this.#gameId === '') return;
    // Resolves once a worker is active; never, when the kill switch kept it from registering.
    await navigator.serviceWorker.ready;
    const record = await pinStatus(this.#gameId, this.ports()).catch(() => null);
    if (generation !== this.#generation) return;
    this.#pinned = record !== null;
    this.#status.textContent =
      record === null ? '' : `${this.#gameName} plays offline on this device (${formatBytes(record.totalBytes)}).`;
    this.#wrap.hidden = false;
    this.#render();
  }

  #render(): void {
    this.#button.setAttribute('aria-pressed', String(this.#pinned));
    const offline = !navigator.onLine && !this.#pinned;
    this.#button.disabled = this.#busy || offline;
    if (offline && !this.#busy)
      this.#status.textContent = 'Connect to the internet to make this game available offline.';
  }

  async #toggle(): Promise<void> {
    if (this.#busy) return;
    const generation = this.#generation;
    const id = this.#gameId;
    const name = this.#gameName;
    this.#busy = true;
    this.#render();
    if (this.#pinned) {
      await unpinGame(id, this.ports());
      this.#pinned = false;
      this.#status.textContent = `Removed ${name} from this device.`;
    } else {
      this.#status.textContent = `Saving ${name} for offline play…`;
      const result = await pinGame(
        { gameId: id, assets: this.getAttribute('assets') ?? `/games/${id}/manifest.json` },
        this.ports(),
      );
      if (result.ok) {
        this.#pinned = true;
        this.#status.textContent = `${name} plays offline on this device (${formatBytes(result.value.record.totalBytes)}).`;
      } else {
        this.#status.textContent = result.error.message;
      }
    }
    this.#busy = false;
    dispatchEvent(new Event(PIN_CHANGED));
    if (generation === this.#generation) this.#render();
  }
}

/** Registers the elements once. */
export const definePwaElements = (): void => {
  if (customElements.get('jy-update-toast') === undefined) customElements.define('jy-update-toast', UpdateToast);
  if (customElements.get('jy-security-update') === undefined)
    customElements.define('jy-security-update', SecurityUpdate);
  if (customElements.get('jy-offline-toggle') === undefined) customElements.define('jy-offline-toggle', OfflineToggle);
};

declare global {
  interface HTMLElementTagNameMap {
    'jy-update-toast': UpdateToast;
    'jy-security-update': SecurityUpdate;
    'jy-offline-toggle': OfflineToggle;
  }
}
