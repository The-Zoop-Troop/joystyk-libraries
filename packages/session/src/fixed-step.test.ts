import { defineSimulation, type SaveEnvelope, type SimulationReplay } from '@joystyk/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flush, manualFrames, manualVisibility, memoryStore, seed, testRng } from './fakes.test-util.ts';
import {
  drift,
  driftLog,
  type DriftEvent,
  type DriftInput,
  type DriftState,
  type DriftView,
} from './fixtures.test-util.ts';
import {
  createFixedStepRunner,
  restoreFixedStepRunner,
  type FixedStepOptions,
  type FixedStepSnapshot,
} from './fixed-step.ts';
import { replaySimulation } from './replay.ts';
import type { RunnerManifest } from './saves.ts';

const manifest: RunnerManifest = {
  id: 'drift',
  versions: { build: '1.0.0', rules: 1, save: 1, minProtocol: 1 },
  undo: 'none',
  handoff: false,
};
const NEVER = 1e9;

const setup = (overrides: Partial<FixedStepOptions> = {}, simulation = drift) => {
  const frames = manualFrames();
  const visibility = manualVisibility();
  const storage = memoryStore();
  const report = vi.fn();
  const result = createFixedStepRunner(simulation, {
    manifest,
    seats: [{ id: 0, name: 'Ana', controller: 'human' }],
    config: { target: NEVER },
    seed: seed(9),
    restoreRng: testRng,
    frames,
    visibility,
    storage,
    report,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  const runner = result.value;
  const seen: FixedStepSnapshot<DriftView, unknown>[] = [];
  runner.subscribe((snapshot) => seen.push(snapshot));
  return { runner, frames, visibility, storage, report, seen };
};

const push = (dx: number) => ({ kind: 'input', input: { type: 'push', dx } }) as const;

beforeEach(() => {
  driftLog.length = 0;
});

describe('the accumulator', () => {
  it('runs one tick per step length of frame time, starting from the first frame', () => {
    const { runner, frames, seen } = setup();
    expect(frames.frame(0)).toBe(true); // baseline only
    expect(runner.get().tick).toBe(0);
    frames.frame(10);
    expect(runner.get().tick).toBe(0);
    frames.frame(20);
    expect(runner.get().tick).toBe(1);
    frames.frame(65);
    expect(runner.get().tick).toBe(3);
    expect(runner.alpha()).toBeCloseTo(0.25);
    // One snapshot per frame that ran ticks, at frame cadence.
    expect(seen.map((s) => s.tick)).toEqual([0, 1, 3]);
    expect(seen.map((s) => s.meta.revision)).toEqual([0, 1, 2]);
  });

  it('bounds catch-up after a long stall and drops the backlog', () => {
    const { runner, frames } = setup();
    frames.frame(0);
    frames.frame(10_000);
    expect(runner.get().tick).toBe(5); // a tenth of a second at 50 Hz
    expect(runner.alpha()).toBeLessThan(1);
    frames.frame(10_020);
    expect(runner.get().tick).toBe(6);
  });

  it('honours a custom catch-up cap', () => {
    const { runner, frames } = setup({ maxStepsPerFrame: 2 });
    frames.frame(0);
    frames.frame(1000);
    expect(runner.get().tick).toBe(2);
  });
});

describe('inputs', () => {
  it('assigns queued inputs to the next tick, in arrival order', () => {
    const { runner, frames } = setup();
    frames.frame(0);
    runner.dispatch(push(1));
    runner.dispatch(push(2));
    frames.frame(60); // three ticks: the inputs all go to the first
    runner.dispatch(push(3));
    frames.frame(80);
    expect(driftLog.map((t) => t.inputs.map((i) => i.dx))).toEqual([[1, 2], [], [], [3]]);
    expect(runner.replay()?.inputs).toEqual([
      { tick: 0, input: { type: 'push', dx: 1 } },
      { tick: 0, input: { type: 'push', dx: 2 } },
      { tick: 3, input: { type: 'push', dx: 3 } },
    ]);
  });

  it('validates inputs with the simulation schema', () => {
    const { runner } = setup();
    runner.dispatch({ kind: 'input', input: { type: 'jump' } as unknown as DriftInput });
    expect(runner.get().meta.notice?.code).toBe('InvalidInput');
  });
});

describe('pausing', () => {
  it('pauses while hidden and resets the accumulator, so hidden time never becomes ticks', async () => {
    const { runner, frames, visibility, storage } = setup();
    frames.frame(0);
    frames.frame(20);
    visibility.set(true);
    expect(runner.get().paused).toBe(true);
    expect(frames.waiting()).toBe(false);
    await flush();
    expect(storage.last()?.tick).toBe(1); // a checkpoint on hide
    visibility.set(false);
    expect(runner.get().paused).toBe(false);
    frames.frame(60_000); // the baseline after resuming
    expect(runner.get().tick).toBe(1);
    frames.frame(60_020);
    expect(runner.get().tick).toBe(2);
  });

  it('pauses and resumes on request, rejecting inputs meanwhile', () => {
    const { runner, frames } = setup();
    frames.frame(0);
    runner.dispatch({ kind: 'pause' });
    expect(runner.get().paused).toBe(true);
    expect(runner.get().meta.safePoint).toBe(true);
    runner.dispatch(push(1));
    expect(runner.get().meta.notice?.code).toBe('Paused');
    expect(frames.frame(5000)).toBe(false);
    runner.dispatch({ kind: 'resume' });
    frames.frame(6000);
    frames.frame(6020);
    expect(runner.get().tick).toBe(1);
  });

  it('can start paused', () => {
    const { runner, frames } = setup({ startPaused: true });
    expect(runner.get().paused).toBe(true);
    expect(frames.waiting()).toBe(false);
  });
});

describe('determinism, replay and checkpoints', () => {
  it('persists a requested checkpoint before a continuing frame publishes, without saving idle ticks', async () => {
    const simulation = defineSimulation({
      ...drift,
      step: (state: DriftState, inputs: readonly DriftInput[], rng: Parameters<typeof drift.step>[2]) => ({
        ...drift.step(state, inputs, rng),
        events: inputs.length > 0 ? [{ type: 'bonus', n: 1 } as DriftEvent] : [],
      }),
      checkpoint: (_state: DriftState, events: readonly DriftEvent[]) => events.length > 0,
    });
    const { runner, frames, storage } = setup({}, simulation);
    frames.frame(0);
    frames.frame(20);
    await flush();
    expect(storage.saves).toHaveLength(0);
    runner.dispatch(push(4));
    frames.frame(40);
    await flush();
    expect(storage.saves).toHaveLength(1);
    expect(storage.last()).toMatchObject({ tick: 2, state: runner.save().state, rng: runner.save().rng });
    frames.frame(60);
    await flush();
    expect(storage.saves).toHaveLength(1);
  });

  const schedule = (
    runner: ReturnType<typeof setup>['runner'],
    frames: ReturnType<typeof setup>['frames'],
    times: readonly number[],
  ) => {
    for (const [i, time] of times.entries()) {
      if (i % 7 === 0) runner.dispatch(push((i % 3) - 1));
      frames.frame(time);
    }
  };

  it('replays its log to the same state, whatever the frame timing', () => {
    const { runner, frames } = setup();
    // Irregular frames: 16–40 ms apart, from a fixed pattern.
    const times: number[] = [];
    let t = 0;
    for (let i = 0; i < 300; i += 1) times.push((t += 16 + ((i * 7) % 25)));
    schedule(runner, frames, times);
    const replay = runner.replay() as SimulationReplay<DriftInput, { target: number }>;
    expect(replay.endTick).toBe(runner.get().tick);
    const replayed = replaySimulation(drift, replay, testRng);
    expect(replayed).toEqual({ ok: true, value: { state: runner.save().state, rng: runner.save().rng } });
  });

  it('gives the same state when the same inputs land on the same ticks', () => {
    const a = setup();
    const b = setup();
    a.frames.frame(0);
    b.frames.frame(0);
    a.runner.dispatch(push(2));
    b.runner.dispatch(push(2));
    a.frames.frame(200); // ten ticks, capped at five per frame
    a.frames.frame(300);
    for (let time = 20; time <= 200; time += 20) b.frames.frame(time);
    expect(a.runner.get().tick).toBe(10);
    expect(b.runner.get().tick).toBe(10);
    expect(a.runner.save().state).toEqual(b.runner.save().state);
  });

  it('matches 1,000 straight ticks with 500, a checkpoint, a restore and 500 more', () => {
    const run = (
      runner: ReturnType<typeof setup>['runner'],
      frames: ReturnType<typeof setup>['frames'],
      from: number,
      ticks: number,
    ) => {
      frames.frame(from);
      for (let i = 1; i <= ticks; i += 1) {
        if (i % 50 === 0) runner.dispatch(push(i % 100 === 0 ? 1 : -1));
        frames.frame(from + i * 20);
      }
    };
    const straight = setup();
    run(straight.runner, straight.frames, 0, 500);
    run(straight.runner, straight.frames, 10_000, 500);

    const first = setup();
    run(first.runner, first.frames, 0, 500);
    const checkpoint = JSON.parse(JSON.stringify(first.runner.save())) as SaveEnvelope;
    first.runner.dispose();
    const frames = manualFrames();
    const restored = restoreFixedStepRunner(drift, checkpoint, {
      manifest,
      migrations: [],
      restoreRng: testRng,
      frames,
    });
    if (!restored.ok) throw new Error(restored.error.message);
    run(restored.value, frames, 100_000, 500);

    expect(straight.runner.get().tick).toBe(1000);
    expect(restored.value.get().tick).toBe(1000);
    expect(restored.value.save().state).toEqual(straight.runner.save().state);
    expect(restored.value.save().rng).toEqual(straight.runner.save().rng);
    expect(restored.value.replay()).toEqual(straight.runner.replay());
  });

  it('restores a checkpoint without a usable replay', () => {
    const { runner, frames, report } = setup();
    frames.frame(0);
    frames.frame(100);
    const save = runner.save();
    const restored = restoreFixedStepRunner(
      drift,
      { ...save, replay: { ...save.replay, endTick: 1 } },
      { manifest, migrations: [], restoreRng: testRng, frames: manualFrames(), report },
    );
    expect(restored.ok && restored.value.replay()).toBeNull();
    expect(restored.ok && restored.value.get().tick).toBe(5);
    expect(report).toHaveBeenCalled();
    const refused = restoreFixedStepRunner(
      drift,
      { ...save, tick: undefined },
      { manifest, migrations: [], restoreRng: testRng, frames: manualFrames() },
    );
    expect(refused).toMatchObject({ ok: false, error: { code: 'SaveUnreadable' } });
  });
});

describe('the end of the game and the session rules', () => {
  it('stops at the outcome, with play time counted in ticks', async () => {
    const { runner, frames, storage } = setup({ config: { target: 5 } });
    frames.frame(0);
    for (let time = 20; frames.waiting(); time += 20) frames.frame(time);
    const { meta, tick, elapsedMs } = runner.get();
    expect(meta.outcome).toMatchObject({ result: 'completed', elapsedMs: tick * 20 });
    expect(elapsedMs).toBe(tick * 20);
    expect(meta.safePoint).toBe(true);
    runner.dispatch(push(1));
    expect(runner.get().meta.notice?.code).toBe('GameOver');
    await flush();
    expect(storage.last()?.tick).toBe(tick);
  });

  it('collects tick events into the snapshot', () => {
    const { runner, frames } = setup();
    frames.frame(0);
    frames.frame(100);
    const events = runner.get().events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => (e as { type: string }).type === 'bonus')).toBe(true);
  });

  it('freezes the snapshot but leaves typed arrays in the view alone', () => {
    const { runner, frames } = setup();
    frames.frame(0);
    frames.frame(20);
    const snapshot = runner.get();
    expect(Object.isFrozen(snapshot.view)).toBe(true);
    expect(snapshot.view.trail).toBeInstanceOf(Float32Array);
    expect(Object.isFrozen(snapshot.view.trail)).toBe(false);
  });

  it('disposes idempotently: no frames, no snapshots, a final checkpoint', async () => {
    const { runner, frames, visibility, storage, seen } = setup();
    frames.frame(0);
    frames.frame(20);
    const count = seen.length;
    runner.dispose();
    runner.dispose();
    expect(frames.waiting()).toBe(false);
    expect(visibility.listeners()).toBe(0);
    runner.dispatch(push(1));
    visibility.set(true);
    await flush();
    expect(seen).toHaveLength(count);
    expect(storage.saves).toHaveLength(1);
  });

  it('stops at the last good tick when a step throws', () => {
    const fragile = defineSimulation({
      ...drift,
      step: (state: DriftState, inputs: readonly DriftInput[], rng) => {
        if (inputs.some((input) => input.dx === 99)) throw new Error('bad step');
        return drift.step(state, inputs, rng);
      },
    });
    const { runner, frames, report } = setup({}, fragile);
    frames.frame(0);
    frames.frame(20);
    const before = runner.save();
    runner.dispatch(push(99));
    frames.frame(40);
    expect(runner.get().meta.notice?.code).toBe('InternalError');
    expect(runner.save().state).toEqual(before.state);
    expect(runner.save().rng).toEqual(before.rng);
    expect(frames.waiting()).toBe(false);
    expect(report).toHaveBeenCalled();
  });
});
