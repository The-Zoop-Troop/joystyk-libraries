import { expect, it, vi } from 'vitest';
import { bindInput, bindHold, bindHoldPad, bindDrag, bindPause } from './index.ts';
it('unifies keys, swipes, tap, held buttons and standard gamepads, releasing on disconnect', () => {
  const surface = document.createElement('div');
  surface.tabIndex = 0;
  document.body.append(surface);
  const emit = vi.fn(),
    announce = vi.fn();
  let callback: FrameRequestCallback = () => {},
    pads: (Gamepad | null)[] = [];
  const stop = bindInput({
    surface,
    keys: { arrowup: 'up', w: 'up' },
    shortcuts: () => false,
    emit,
    announce,
    gesture: 'swipe',
    frame: (f) => {
      callback = f;
      return 1;
    },
    cancelFrame: () => {},
    gamepads: () => pads,
  });
  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
  expect(emit).not.toHaveBeenCalled();
  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  surface.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }));
  expect(emit.mock.calls).toEqual([
    ['up', true],
    ['up', false],
  ]);
  emit.mockClear();
  surface.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 80, clientY: 80 }));
  surface.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 110, clientY: 80 }));
  expect(emit.mock.calls).toEqual([
    ['right', true],
    ['right', false],
  ]);
  emit.mockClear();
  surface.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, clientX: 80, clientY: 80 }));
  surface.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2, clientX: 82, clientY: 80 }));
  expect(emit.mock.calls[0]).toEqual(['main', true]);
  emit.mockClear();
  pads = [
    {
      index: 0,
      connected: true,
      mapping: 'standard',
      axes: [0, -1],
      buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 0 })),
    } as unknown as Gamepad,
  ];
  callback(1);
  callback(2);
  expect(emit.mock.calls).toEqual([
    ['up', true],
    ['main', true],
  ]);
  pads = [];
  callback(3);
  expect(emit.mock.calls).toContainEqual(['up', false]);
  expect(announce.mock.calls.map((c) => c[0])).toEqual(['Controller connected.', 'Controller disconnected.']);
  stop();
  const button = document.createElement('button'),
    held = vi.fn(),
    release = bindHold(button, held);
  button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
  button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
  expect(held.mock.calls).toEqual([[true], [false]]);
  release();
  surface.remove();
});
it('has a drag dead zone and an explicit cancellable one-second resume', () => {
  const surface = document.createElement('div');
  document.body.append(surface);
  const drag = vi.fn(),
    stop = bindInput({
      surface,
      keys: {},
      shortcuts: () => true,
      emit: vi.fn(),
      announce: vi.fn(),
      gesture: 'drag',
      drag,
      frame: () => 1,
      cancelFrame: () => {},
    });
  surface.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }));
  surface.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 3, clientY: 2 }));
  surface.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 30, clientY: 10 }));
  expect(drag.mock.calls).toEqual([
    [0, 0],
    [30, 10],
  ]);
  stop();
  surface.remove();
  const pause = vi.fn(),
    resume = vi.fn(),
    announce = vi.fn(),
    cancel = vi.fn();
  let done = () => {};
  const p = bindPause({
    pause,
    resume,
    announce,
    after: (ms, f) => {
      expect(ms).toBe(1000);
      done = f;
      return cancel;
    },
  });
  p.resume();
  expect(resume).not.toHaveBeenCalled();
  expect(announce).toHaveBeenCalledWith('Resuming in one second.');
  done();
  expect(resume).toHaveBeenCalledTimes(1);
  p.resume();
  window.dispatchEvent(new Event('blur'));
  expect(cancel).toHaveBeenCalled();
  expect(pause).toHaveBeenCalled();
  p.dispose();
});

it('binds dynamically rendered hold pads and absolute pointer dragging', () => {
  const root = document.createElement('div');
  document.body.append(root);
  const emit = vi.fn(),
    stop = bindHoldPad(root, '[data-hold]', emit);
  const button = document.createElement('button');
  button.dataset['hold'] = 'left';
  root.append(button);
  button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
  button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
  expect(emit.mock.calls.map((c) => [c[1], c[2]])).toEqual([
    [true, 'key:Space'],
    [false, 'key:Space'],
  ]);
  stop();
  const start = vi.fn(),
    move = vi.fn(),
    drag = bindDrag(root, { start, move, hoverMouse: true });
  root.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, isPrimary: true }));
  root.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40 }));
  root.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
  root.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'touch' }));
  expect(start).toHaveBeenCalledTimes(1);
  expect(move).toHaveBeenCalledTimes(1);
  drag();
  root.remove();
});
