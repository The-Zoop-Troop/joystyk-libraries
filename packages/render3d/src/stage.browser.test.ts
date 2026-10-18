import { expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AutoQuality, createRenderStage } from './index.ts';
it('steps Auto down after sustained pressure, never up, and respects a pinned level', () => {
  const q = new AutoQuality();
  for (let t = 0; t < 3000; t += 20) q.sample(22, t);
  expect(q.level).toBe('medium');
  q.sample(22, 3020);
  expect(q.level).toBe('low');
  for (let t = 3040; t < 10000; t += 20) q.sample(1, t);
  expect(q.level).toBe('low');
  q.set('high');
  for (let t = 10000; t < 15000; t += 20) q.sample(50, t);
  expect(q.level).toBe('high');
});
it('skips unchanged frames, pauses/rebuilds after context loss and disposes every resource', async () => {
  const host = document.createElement('div');
  host.style.cssText = 'width:400px;height:300px';
  document.body.append(host);
  const pause = vi.fn(),
    draw = vi.fn(),
    dispose = vi.fn(),
    build = vi.fn(({ scene, track }) => {
      track({ dispose });
      const geometry = track(new THREE.BoxGeometry()),
        material = track(new THREE.MeshBasicMaterial());
      scene.add(new THREE.Mesh(geometry, material));
      const camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100);
      camera.position.z = 4;
      return { camera, draw };
    });
  const stage = createRenderStage<{
    tick: number;
  }>({ host, pause, announce: vi.fn(), build });
  expect(stage.available).toBe(true);
  stage.draw({ tick: 1 });
  stage.draw({ tick: 1 });
  expect(draw).toHaveBeenCalledTimes(1);
  const old = stage.canvas!;
  old.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  expect(pause).toHaveBeenCalledTimes(1);
  expect(stage.available).toBe(false);
  old.dispatchEvent(new Event('webglcontextrestored'));
  expect(stage.available).toBe(true);
  expect(build).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(1);
  stage.dispose();
  stage.dispose();
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(host.querySelector('canvas')).toBeNull();
  host.remove();
});
it('refuses WebGL1 when WebGL2 is unavailable', () => {
  const original = HTMLCanvasElement.prototype.getContext;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
    id: string,
    ...args: unknown[]
  ) {
    return id === 'webgl2' ? null : original.call(this, id as '2d', ...(args as []));
  } as typeof original);
  const host = document.createElement('div');
  document.body.append(host);
  const pause = vi.fn();
  try {
    const stage = createRenderStage({
      host,
      pause,
      announce: vi.fn(),
      build: () => {
        throw Error('WebGL1 must not build');
      },
    });
    expect(stage.available).toBe(false);
    expect(host.textContent).toContain('needs WebGL 2');
    expect(spy.mock.calls.some((c) => c[0] === 'webgl')).toBe(false);
    stage.dispose();
  } finally {
    spy.mockRestore();
    host.remove();
  }
});
