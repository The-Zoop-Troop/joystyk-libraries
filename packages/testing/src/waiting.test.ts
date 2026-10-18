import { describe, expect, it } from 'vitest';
import { manualFrames, pause, waitUntil } from './waiting.ts';

/** A stand-in for a fixed-step runner: one tick per frame while it runs. */
const ticker = (frames: ReturnType<typeof manualFrames>) => {
  const state = { ticks: 0, stamps: [] as number[], running: true };
  const onFrame = (now: number): void => {
    state.ticks += 1;
    state.stamps.push(now);
    if (state.running) frames.port.request(onFrame);
  };
  frames.port.request(onFrame);
  return state;
};

describe('waitUntil', () => {
  it('resolves once the condition holds', async () => {
    let calls = 0;
    await waitUntil(() => (calls += 1) >= 3, 'the third call', { intervalMs: 1 });
    expect(calls).toBe(3);
  });

  it('names what never happened when the budget runs out', async () => {
    await expect(waitUntil(() => false, 'the impossible', { timeoutMs: 20, intervalMs: 1 })).rejects.toThrow(
      'Timed out after 20 ms waiting for the impossible.',
    );
  });
});

describe('manualFrames', () => {
  it('runs frames only when told, one frame apart, and counts the ones with a callback', () => {
    const frames = manualFrames();
    const state = ticker(frames);
    expect(state.ticks).toBe(0);
    expect(frames.run(3)).toBe(3);
    expect(state.stamps).toEqual([0, 1000 / 60, 2000 / 60]);
    state.running = false;
    expect(frames.run(1)).toBe(1);
    expect(frames.pending()).toBe(false);
    expect(frames.run(5)).toBe(0);
  });

  it('honours a cancelled request', () => {
    const frames = manualFrames();
    let ran = false;
    const cancel = frames.port.request(() => (ran = true));
    cancel();
    expect(frames.run(1)).toBe(0);
    expect(ran).toBe(false);
  });

  it('runs frames until a condition holds, never past it', async () => {
    const frames = manualFrames();
    const state = ticker(frames);
    await frames.until(() => state.ticks === 7, 'seven ticks');
    expect(state.ticks).toBe(7);
  });

  it('fails after its budget of frames, in game time', async () => {
    const frames = manualFrames();
    ticker(frames);
    await expect(frames.until(() => false, 'the end', { maxFrames: 10 })).rejects.toThrow(
      'Gave up waiting for the end after 10 frames.',
    );
  });

  it('waits out a paused runner on the wall clock', async () => {
    const frames = manualFrames();
    let resumed = false;
    void pause(30).then(() => (resumed = true));
    await frames.until(() => resumed, 'the resume');
    await expect(frames.until(() => false, 'a frame', { timeoutMs: 20 })).rejects.toThrow(
      /Timed out after 20 ms waiting for a frame \(0 frames run\)/,
    );
  });

  it('advances a number of frames, yielding between them', async () => {
    const frames = manualFrames();
    const state = ticker(frames);
    let yielded = false;
    void Promise.resolve().then(() => (yielded = true));
    expect(await frames.advance(4)).toBe(4);
    expect(state.ticks).toBe(4);
    expect(yielded).toBe(true);
  });
});
