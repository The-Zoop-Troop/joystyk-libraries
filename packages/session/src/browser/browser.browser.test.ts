import type { SaveEnvelope } from '@joystyk/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { seed, testRng } from '../fakes.test-util.ts';
import { drift, nim, nimManifest } from '../fixtures.test-util.ts';
import { createFixedStepRunner } from '../fixed-step.ts';
import { createLocalSession } from '../local.ts';
import {
  animationFrames,
  browserClock,
  browserPorts,
  documentVisibility,
  webStorageSaveStore,
  workerAiRunner,
  workerJobRunner,
} from './index.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// These adapters run on real time, and a loaded machine can hold back a timer, a frame or a
// worker's reply for seconds. Wait for the condition, with most of the 60-second test timeout.
// (This package can't use @joystyk/testing's waitUntil: that package depends on this one.)
const until = async (condition: () => boolean, timeoutMs = 45_000): Promise<void> => {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error('Timed out waiting for the condition.');
    await wait(5);
  }
};

describe('browserClock', () => {
  it('reads monotonic time and runs and cancels timers', async () => {
    const clock = browserClock();
    const start = clock.now();
    let fired = 0;
    clock.after(5, () => (fired += 1));
    const cancel = clock.after(5, () => (fired += 10));
    cancel();
    await wait(30);
    expect(fired).toBe(1);
    expect(clock.now()).toBeGreaterThan(start);
  });
});

describe('documentVisibility', () => {
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it('reports the page visibility and its changes until unsubscribed', () => {
    const visibility = documentVisibility();
    expect(visibility.hidden()).toBe(false);
    const changes: boolean[] = [];
    const off = visibility.subscribe((hidden) => changes.push(hidden));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(visibility.hidden()).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    off();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(changes).toEqual([true, true]);
  });
});

describe('animationFrames', () => {
  it('calls back on the next frame with its timestamp, unless cancelled', async () => {
    const frames = animationFrames();
    const stamps: number[] = [];
    frames.request((now) => stamps.push(now));
    const cancel = frames.request(() => stamps.push(-1));
    cancel();
    await until(() => stamps.length > 0);
    await wait(50);
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toBeGreaterThan(0);
  });
});

describe('webStorageSaveStore', () => {
  afterEach(() => localStorage.removeItem('test:save'));

  it('writes the envelope as JSON and reads it back', async () => {
    const store = webStorageSaveStore('test:save');
    expect(store.read()).toBeNull();
    const save: SaveEnvelope = {
      gameId: 'nim',
      build: '1',
      rulesVersion: 1,
      saveVersion: 1,
      rng: seed(1),
      seats: [],
      state: { heap: 3 },
    };
    await store.write(save);
    expect(store.read()).toEqual(save);
    localStorage.setItem('test:save', '{not json');
    expect(store.read()).toBeNull();
  });

  it('rejects a write the storage refuses', async () => {
    const full = {
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    } as unknown as Storage;
    await expect(webStorageSaveStore('x', full).write({} as SaveEnvelope)).rejects.toThrow('full');
  });
});

describe('workerJobRunner', () => {
  const source = `onmessage = (event) => postMessage({ ok: true, value: event.data.payload.sides * 2, presentation: { id: event.data.id } });`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const spec = nim.jobs!['dice']!;

  it('runs a job in a worker and returns its answer', async () => {
    const runner = workerJobRunner(() => new Worker(url));
    const task = runner.run({ id: 'roll-0', kind: 'dice', payload: { sides: 3 } }, spec);
    await expect(task.result).resolves.toEqual({ ok: true, value: 6, presentation: { id: 'roll-0' } });
  });

  it('terminates the worker on cancel', () => {
    const terminated: string[] = [];
    const runner = workerJobRunner((kind) => {
      const worker = new Worker(url);
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        terminated.push(kind);
        terminate();
      };
      return worker;
    });
    runner.run({ id: 'roll-1', kind: 'dice', payload: { sides: 3 } }, spec).cancel();
    expect(terminated).toEqual(['dice']);
  });
});

describe('workerAiRunner', () => {
  // Takes as many as leave a multiple of four, or one; echoes the seed's algorithm to prove it arrived.
  const source = `onmessage = ({ data }) => postMessage({ type: 'take', count: data.view.heap % 4 || 1, seat: data.seat, algorithm: data.rng.algorithm });`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

  it('runs a choice in a worker with the task as JSON', async () => {
    const runner = workerAiRunner<{ heap: number }>(() => new Worker(url));
    const task = runner.choose({
      view: { heap: 10 },
      seat: 1,
      level: 'hard',
      rng: { algorithm: 'sfc32', words: [1, 2, 3, 4] },
    });
    await expect(task.result).resolves.toEqual({ type: 'take', count: 2, seat: 1, algorithm: 'sfc32' });
  });

  it('plays a heavy AI seat through the worker', async () => {
    const result = createLocalSession(nim, {
      ...browserPorts(),
      manifest: nimManifest({ ai: { levels: ['easy', 'hard'], heavy: true } }),
      mode: 'ai',
      seats: [
        { id: 0, name: 'Ana', controller: 'human' },
        { id: 1, name: 'Bot', controller: 'ai', aiLevel: 'hard' },
      ],
      config: { heap: 10 },
      seed: seed(5),
      restoreRng: testRng,
      ai: workerAiRunner(() => new Worker(url)),
    });
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value;
    session.dispatch({ kind: 'command', command: { type: 'take', count: 1 } });
    await until(() => session.get().view.heap === 8);
    session.dispose();
  });
});

describe('the runners on browser ports', () => {
  it('drives a fixed-step simulation from animation frames', async () => {
    const result = createFixedStepRunner(drift, {
      ...browserPorts(),
      manifest: {
        id: 'drift',
        versions: { build: '1', rules: 1, save: 1, minProtocol: 1 },
        undo: 'none',
        handoff: false,
      },
      seats: [{ id: 0, name: 'Ana', controller: 'human' }],
      config: { target: 1e9 },
      seed: seed(3),
      restoreRng: testRng,
    });
    if (!result.ok) throw new Error(result.error.message);
    await until(() => result.value.get().tick >= 3);
    result.value.dispose();
    const tick = result.value.get().tick;
    await wait(100);
    expect(result.value.get().tick).toBe(tick);
  });

  it('plays an AI seat on the browser clock and saves to web storage', async () => {
    const storage = webStorageSaveStore('test:nim');
    const result = createLocalSession(nim, {
      ...browserPorts(),
      manifest: nimManifest(),
      mode: 'ai',
      seats: [
        { id: 0, name: 'Ana', controller: 'human' },
        { id: 1, name: 'Bot', controller: 'ai', aiLevel: 'hard' },
      ],
      config: { heap: 10 },
      seed: seed(5),
      aiDelayMs: 10,
      restoreRng: testRng,
      storage,
    });
    if (!result.ok) throw new Error(result.error.message);
    const session = result.value;
    session.dispatch({ kind: 'command', command: { type: 'take', count: 1 } });
    await until(() => session.get().view.heap === 8);
    session.dispose();
    await wait(10);
    expect(storage.read()).toMatchObject({ gameId: 'nim', state: { heap: 8 } });
    localStorage.removeItem('test:nim');
  });
});
