import { swipeDirection } from './legacy.ts';
/** All sources share the same actions. A held action is released on blur or disconnect. */
export type InputAction = 'up' | 'down' | 'left' | 'right' | 'main' | 'pause' | 'auxiliary';
export type InputOptions = {
  readonly surface: HTMLElement;
  readonly keys: Readonly<Record<string, InputAction>>;
  readonly shortcuts: () => boolean;
  readonly emit: (action: InputAction, held: boolean) => void;
  readonly announce: (text: string) => void;
  readonly gesture?: 'swipe' | 'tap' | 'drag';
  readonly drag?: (x: number, y: number) => void;
  readonly deadZone?: number;
  readonly gamepads?: () => readonly (Gamepad | null)[];
  readonly frame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (id: number) => void;
};
export function bindInput(o: InputOptions): () => void {
  const abort = new AbortController(),
    { signal } = abort;
  const held = new Map<InputAction, Set<string>>();
  const set = (action: InputAction, on: boolean, source: string): void => {
    const sources = held.get(action) ?? new Set<string>(),
      before = sources.size > 0;
    if (on) sources.add(source);
    else sources.delete(source);
    held.set(action, sources);
    if (before !== sources.size > 0) o.emit(action, sources.size > 0);
  };
  const release = (prefix: string): void => {
    for (const [action, sources] of held)
      for (const source of [...sources]) if (source.startsWith(prefix)) set(action, false, source);
  };
  const key = (e: KeyboardEvent, on: boolean): void => {
    if (e.target instanceof HTMLElement && e.target.closest('input, select, textarea, button, [contenteditable]'))
      return;
    const name = e.key.toLowerCase(),
      action = o.keys[name];
    if (
      action === undefined ||
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      (name.length === 1 && name.trim() !== '' && !o.shortcuts())
    )
      return;
    e.preventDefault();
    if (!e.repeat || !on) set(action, on, `key:${name}`);
  };
  o.surface.addEventListener('keydown', (e) => key(e, true), { signal });
  o.surface.addEventListener('keyup', (e) => key(e, false), { signal });
  window.addEventListener(
    'blur',
    () => {
      release('');
      o.drag?.(0, 0);
    },
    { signal },
  );
  let pointer: {
    id: number;
    x: number;
    y: number;
  } | null = null;
  o.surface.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || (e.target instanceof Element && e.target.closest('button, select, input'))) return;
      pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
      o.surface.focus();
      try {
        o.surface.setPointerCapture?.(e.pointerId);
      } catch {
        /* Pointer released before capture. */
      }
    },
    { signal },
  );
  o.surface.addEventListener(
    'pointermove',
    (e) => {
      if (pointer?.id !== e.pointerId || o.gesture !== 'drag') return;
      const x = e.clientX - pointer.x,
        y = e.clientY - pointer.y;
      if (Math.hypot(x, y) >= (o.deadZone ?? 16)) o.drag?.(x, y);
      else o.drag?.(0, 0);
    },
    { signal },
  );
  const end = (e: PointerEvent): void => {
    if (pointer?.id !== e.pointerId) return;
    const x = e.clientX - pointer.x,
      y = e.clientY - pointer.y;
    pointer = null;
    if (o.gesture === 'drag') {
      o.drag?.(0, 0);
      return;
    }
    const action = o.gesture === 'swipe' ? (swipeDirection(x, y) ?? 'main') : 'main';
    o.emit(action, true);
    o.emit(action, false);
  };
  o.surface.addEventListener('pointerup', end, { signal });
  o.surface.addEventListener(
    'pointercancel',
    () => {
      pointer = null;
      o.drag?.(0, 0);
    },
    { signal },
  );
  let controller: number | null = null,
    last = new Set<InputAction>(),
    raf = 0;
  const frame = o.frame ?? requestAnimationFrame,
    cancel = o.cancelFrame ?? cancelAnimationFrame;
  const poll = (): void => {
    const pads = [...(o.gamepads?.() ?? navigator.getGamepads?.() ?? [])].filter(
      (p): p is Gamepad => p !== null && p.connected && p.mapping === 'standard',
    );
    const pad = pads.find((p) => p.index === controller) ?? pads[0];
    if ((pad?.index ?? null) !== controller) {
      release('pad:');
      last = new Set();
      controller = pad?.index ?? null;
      o.announce(pad === undefined ? 'Controller disconnected.' : 'Controller connected.');
    }
    const next = new Set<InputAction>();
    if (pad !== undefined) {
      const b = (i: number): boolean => pad.buttons[i]?.pressed === true;
      const x = pad.axes[0] ?? 0,
        y = pad.axes[1] ?? 0;
      if (b(12) || (o.gesture !== 'drag' && y < -0.3)) next.add('up');
      if (b(13) || (o.gesture !== 'drag' && y > 0.3)) next.add('down');
      if (b(14) || (o.gesture !== 'drag' && x < -0.3)) next.add('left');
      if (b(15) || (o.gesture !== 'drag' && x > 0.3)) next.add('right');
      if (b(0) || b(7)) next.add('main');
      if (b(9)) next.add('pause');
      if (o.gesture === 'drag') o.drag?.(Math.hypot(x, y) > 0.3 ? x : 0, Math.hypot(x, y) > 0.3 ? y : 0);
    }
    for (const action of new Set([...last, ...next])) set(action, next.has(action), `pad:${action}`);
    last = next;
    raf = frame(poll);
  };
  raf = frame(poll);
  return () => {
    abort.abort();
    cancel(raf);
    release('');
  };
}
/** Native hold buttons also support keyboard and switch activation. */
export function bindHold(button: HTMLButtonElement, emit: (held: boolean) => void): () => void {
  const abort = new AbortController(),
    { signal } = abort;
  let down = false;
  const set = (value: boolean): void => {
    if (down !== value) {
      down = value;
      emit(value);
    }
  };
  button.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button === 0) {
        try {
          button.setPointerCapture?.(e.pointerId);
        } catch {
          /* Pointer released before capture. */
        }
        set(true);
      }
    },
    { signal },
  );
  button.addEventListener('pointerup', () => set(false), { signal });
  button.addEventListener('pointercancel', () => set(false), { signal });
  button.addEventListener(
    'keydown',
    (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        set(true);
      }
    },
    { signal },
  );
  button.addEventListener('keyup', () => set(false), { signal });
  button.addEventListener('blur', () => set(false), { signal });
  return () => {
    abort.abort();
    set(false);
  };
}

/** Delegated holds survive Gyral updates that add or replace native pad buttons. */
export function bindHoldPad(
  root: HTMLElement | ShadowRoot,
  selector: string,
  emit: (button: HTMLButtonElement, on: boolean, source: string) => void,
  signal?: AbortSignal,
): () => void {
  const abort = new AbortController(),
    held = new Map<string, HTMLButtonElement>();
  const find = (target: EventTarget | null): HTMLButtonElement | null => {
    const button = target instanceof Element ? target.closest(selector) : null;
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  };
  const release = (source: string): void => {
    const button = held.get(source);
    if (button !== undefined) {
      held.delete(source);
      emit(button, false, source);
    }
  };
  const press = (button: HTMLButtonElement, source: string): void => {
    if (held.has(source)) return;
    held.set(source, button);
    emit(button, true, source);
  };
  root.addEventListener(
    'pointerdown',
    (event) => {
      if (!(event instanceof PointerEvent) || event.button !== 0) return;
      const button = find(event.target);
      if (button === null) return;
      event.preventDefault();
      button.focus({ preventScroll: true });
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        /* The pointer may already be released. */
      }
      press(button, `pointer:${event.pointerId}`);
    },
    { signal: abort.signal },
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    root.addEventListener(
      type,
      (event) => {
        if (event instanceof PointerEvent) release(`pointer:${event.pointerId}`);
      },
      { signal: abort.signal },
    );
  root.addEventListener(
    'keydown',
    (event) => {
      if (!(event instanceof KeyboardEvent) || ![' ', 'Enter'].includes(event.key)) return;
      const button = find(event.target);
      if (button === null) return;
      event.preventDefault();
      if (!event.repeat) press(button, `key:${event.code || event.key}`);
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    'keyup',
    (event) => {
      if (event instanceof KeyboardEvent && [' ', 'Enter'].includes(event.key))
        release(`key:${event.code || event.key}`);
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    'focusout',
    (event) => {
      for (const [source, button] of held) if (event.target === button) release(source);
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    'blur',
    () => {
      for (const source of [...held.keys()]) release(source);
    },
    { signal: abort.signal },
  );
  const stop = (): void => {
    abort.abort();
    for (const source of [...held.keys()]) release(source);
  };
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}

/** Absolute dragging for paddles; games own projection into their court's units. */
export function bindDrag(
  surface: HTMLElement,
  o: {
    start(event: PointerEvent): boolean | void;
    move(event: PointerEvent): void;
    hoverMouse?: boolean;
    capture?: boolean;
    primaryOnly?: boolean;
  },
  signal?: AbortSignal,
): () => void {
  const abort = new AbortController();
  let pointer: number | null = null;
  surface.addEventListener(
    'pointerdown',
    (event) => {
      if ((o.primaryOnly !== false && !event.isPrimary) || event.button !== 0 || o.start(event) === false) return;
      pointer = event.pointerId;
      if (o.capture !== false)
        try {
          surface.setPointerCapture(event.pointerId);
        } catch {
          /* Released before capture. */
        }
    },
    { signal: abort.signal },
  );
  surface.addEventListener(
    'pointermove',
    (event) => {
      if (pointer === event.pointerId || (o.hoverMouse && event.pointerType === 'mouse')) o.move(event);
    },
    { signal: abort.signal },
  );
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    surface.addEventListener(
      type,
      () => {
        pointer = null;
      },
      { signal: abort.signal },
    );
  window.addEventListener(
    'blur',
    () => {
      pointer = null;
    },
    { signal: abort.signal },
  );
  const stop = (): void => {
    abort.abort();
    pointer = null;
  };
  signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
