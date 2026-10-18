import { ok } from '@joystyk/contracts';
import type { AnyGameSession, EngineReplay, Json, SaveEnvelope, SeatInfo } from '@joystyk/contracts';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { seedState } from '@joystyk/kit';
import { flush, manualClock, manualJobs, manualVisibility, memoryStore, seed, testRng } from './fakes.test-util.ts';
import {
  aiViews,
  nim,
  nimManifest,
  nimMigrations,
  timedNim,
  type NimCommand,
  type NimState,
} from './fixtures.test-util.ts';
import {
  createLocalSession,
  restoreLocalSession,
  type LocalInput,
  type LocalSessionOptions,
  type LocalSnapshot,
} from './local.ts';
import type { AiRunner } from './ports.ts';
import { replayEngine } from './replay.ts';

const ana: SeatInfo = { id: 0, name: 'Ana', controller: 'human' };
const bot: SeatInfo = { id: 1, name: 'Bot', controller: 'ai', aiLevel: 'hard' };
const ben: SeatInfo = { id: 1, name: 'Ben', controller: 'human' };

type Snap = LocalSnapshot<NimState, unknown>;

const setup = (overrides: Partial<LocalSessionOptions<NimState>> = {}) => {
  const clock = manualClock();
  const visibility = manualVisibility();
  const storage = memoryStore();
  const jobs = manualJobs();
  const report = vi.fn();
  const result = createLocalSession(nim, {
    manifest: nimManifest(),
    mode: 'ai',
    seats: [ana, bot],
    config: { heap: 10 },
    seed: seed(42),
    aiSeed: seed(7),
    aiDelayMs: 100,
    restoreRng: testRng,
    clock,
    visibility,
    storage,
    jobs,
    report,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error.message);
  const session = result.value;
  const seen: Snap[] = [];
  session.subscribe((snapshot) => seen.push(snapshot as Snap));
  return { session, clock, visibility, storage, jobs, report, seen };
};

const take = (count: number): LocalInput<NimCommand> => ({ kind: 'command', command: { type: 'take', count } });
const cmd = (command: NimCommand): LocalInput<NimCommand> => ({ kind: 'command', command });

const restoreOptions = (t: ReturnType<typeof setup>, overrides: Partial<LocalSessionOptions<NimState>> = {}) => ({
  manifest: nimManifest(),
  mode: 'ai' as const,
  migrations: nimMigrations,
  restoreRng: testRng,
  clock: t.clock,
  storage: t.storage,
  jobs: t.jobs,
  aiDelayMs: 100,
  report: t.report,
  ...overrides,
});

beforeEach(() => {
  aiViews.length = 0;
});

describe('Layer 1 rules', () => {
  it('skips covers for explicit public phases and covers a new private phase, including the same pending seat', () => {
    const phased = {
      ...nim,
      handoffRequired: (s: NimState) => s.heap % 2 === 1,
      viewFor: (s: NimState, seat: number | null) => nim.viewFor(s, s.heap % 2 === 0 ? null : seat),
      apply: ((s, input, rng) => {
        const r = nim.apply(s, input, rng);
        return r.ok ? ok({ ...r.value, state: { ...r.value.state, turn: s.turn } }) : r;
      }) as typeof nim.apply,
    };
    const options = {
      manifest: nimManifest({ handoff: true }),
      mode: 'pass-and-play' as const,
      seats: [ana, ben],
      config: { heap: 6 },
      seed: seed(42),
      restoreRng: testRng,
      clock: manualClock(),
    };
    const made = createLocalSession(phased, options);
    if (!made.ok) throw Error(made.error.message);
    const session = made.value;
    expect(session.get().handoff).toBeNull();
    expect(session.get().meta.seat).toBe(0);
    expect(session.get().view.secrets).toEqual([null, null]);
    session.dispatch(take(1));
    expect(session.get().handoff?.seat).toBe(0);
    expect(session.get().meta.seat).toBeNull();
    session.dispatch(take(1));
    expect(session.get().view.heap).toBe(5);
    session.dispatch({ kind: 'reveal' });
    session.dispatch(take(1));
    expect(session.get().handoff).toBeNull();
    expect(session.get().meta.seat).toBe(0);
    const save = session.save(),
      restored = restoreLocalSession(phased, save, { ...options, migrations: nimMigrations });
    if (!restored.ok) throw Error(restored.error.message);
    expect(restored.value.get().handoff).toBeNull();
    expect(restored.value.replay()).toEqual(session.replay());
    restored.value.dispatch(take(1));
    expect(restored.value.get().handoff?.seat).toBe(0);
    restored.value.dispose();
    session.dispose();
  });
  it('permits a named nonpending human only for an explicit side action and preserves handoff guards', () => {
    const side = {
      ...nim,
      sideCommand: (s: NimState, _seat: number, c: NimCommand) =>
        s.winner === null && c.type === 'take' && c.count === 0,
      apply: ((s, input, rng) =>
        input.kind === 'command' && input.command.type === 'take' && input.command.count === 0 && s.winner === null
          ? ok({ state: s, beats: [] })
          : nim.apply(s, input, rng)) as typeof nim.apply,
    };
    const make = (handoff: boolean) =>
      createLocalSession(side, {
        manifest: nimManifest({ handoff }),
        mode: 'pass-and-play',
        seats: [ana, ben],
        config: { heap: 10 },
        seed: seed(42),
        restoreRng: testRng,
        clock: manualClock(),
      });
    const made = make(false);
    if (!made.ok) throw Error(made.error.message);
    const session = made.value;
    session.dispatch({ kind: 'command', seat: 1, command: { type: 'take', count: 0 } });
    expect(session.get().meta.notice).toBeNull();
    expect(session.get().meta.revision).toBe(1);
    expect(session.get().pending).toEqual([0]);
    session.dispatch({ kind: 'command', seat: 1, command: { type: 'take', count: 1 } });
    expect(session.get().meta.notice).not.toBeNull();
    expect(session.get().view.heap).toBe(10);
    session.dispose();
    const guarded = make(true);
    if (!guarded.ok) throw Error(guarded.error.message);
    guarded.value.dispatch({ kind: 'command', seat: 1, command: { type: 'take', count: 0 } });
    expect(guarded.value.get().meta.revision).toBe(0);
    guarded.value.dispatch({ kind: 'reveal' });
    const revealedRevision = guarded.value.get().meta.revision;
    guarded.value.dispatch({ kind: 'command', seat: 1, command: { type: 'take', count: 0 } });
    expect(guarded.value.get().meta.revision).toBe(revealedRevision);
    guarded.value.dispose();
  });

  it('delivers the current snapshot on subscribe, and unsubscribing twice is safe', () => {
    const { session } = setup();
    const listener = vi.fn();
    const off = session.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(session.get());
    off();
    off();
    session.dispatch(take(1));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is assignable to the launcher’s AnyGameSession', () => {
    const { session } = setup();
    expectTypeOf(session).toExtend<AnyGameSession>();
  });

  it('freezes snapshots, deeply', () => {
    const { session } = setup();
    const snapshot = session.get();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => {
      (snapshot.view as { heap: number }).heap = 0;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.meta.seats as SeatInfo[]).push(ana);
    }).toThrow(TypeError);
  });

  it('can leave snapshots unfrozen', () => {
    const { session } = setup({ freeze: false });
    expect(Object.isFrozen(session.get())).toBe(false);
  });

  it('publishes atomically: the view, beats and revision always agree', () => {
    const { session, seen } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    session.dispatch(take(2));
    session.dispatch(take(3));
    for (const snapshot of seen.slice(1)) {
      const last = snapshot.beats.at(-1);
      expect(last?.view?.heap).toBe(snapshot.view.heap);
    }
    expect(seen.map((s) => s.meta.revision)).toEqual([0, 1, 2]);
  });

  it('queues a dispatch made inside a listener, so every listener sees the same order', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    const first: number[] = [];
    const second: number[] = [];
    session.subscribe((s) => {
      first.push(s.meta.revision);
      if (s.meta.revision === 1) session.dispatch(take(1));
    });
    session.subscribe((s) => second.push(s.meta.revision));
    session.dispatch(take(1));
    expect(first).toEqual([0, 1, 2]);
    expect(second).toEqual([0, 1, 2]);
    expect(session.get().view.heap).toBe(8);
  });

  it('keeps publishing to other listeners when one throws', () => {
    const { session, report } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    session.subscribe((s) => {
      if (s.meta.revision > 0) throw new Error('broken listener');
    });
    const healthy = vi.fn();
    session.subscribe(healthy);
    session.dispatch(take(1));
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalled();
  });

  it('disposes idempotently and publishes nothing afterwards', async () => {
    const { session, clock, jobs, seen, visibility } = setup();
    session.dispatch(take(1)); // the AI starts thinking
    session.dispatch(cmd({ type: 'take', count: 1 }));
    const count = seen.length;
    session.dispose();
    session.dispose();
    clock.advance(10_000);
    session.dispatch(take(1));
    await flush();
    expect(seen).toHaveLength(count);
    expect(clock.pending()).toBe(0);
    expect(visibility.listeners()).toBe(0);
    const late = vi.fn();
    session.subscribe(late);
    expect(late).not.toHaveBeenCalled();
    expect(session.get()).toBe(seen.at(-1));
    expect(jobs.started).toEqual([]);
  });
});

describe('inputs', () => {
  it('validates commands with the engine schema before the engine sees them', () => {
    const { session } = setup();
    session.dispatch({ kind: 'command', command: { type: 'fly' } } as unknown as LocalInput<NimCommand>);
    expect(session.get().meta.notice?.code).toBe('InvalidInput');
    expect(session.get().meta.revision).toBe(0);
    session.dispatch({ kind: 'warp' } as unknown as LocalInput<NimCommand>);
    expect(session.get().meta.notice?.code).toBe('InvalidInput');
  });

  it('passes engine rejections through as notices and clears them on the next accepted change', () => {
    const { session } = setup();
    session.dispatch(take(4));
    expect(session.get().meta.notice).toEqual({ code: 'IllegalMove', message: 'Take one, two or three.' });
    session.dispatch(take(1));
    expect(session.get().meta.notice).toBeNull();
  });

  it('restores the rng after a rejected input, so rejections consume no randomness', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben], config: { heap: 1 } });
    let busts = 0;
    for (let i = 0; i < 20 && session.get().meta.outcome === null; i += 1) {
      const before = session.save().rng;
      session.dispatch(cmd({ type: 'gamble' }));
      if (session.get().meta.notice?.code === 'Bust') {
        busts += 1;
        expect(session.save().rng).toEqual(before);
      }
    }
    expect(busts).toBeGreaterThan(0);
  });

  it('catches an engine that throws, reports it and keeps the previous state', () => {
    const { session, report } = setup();
    const before = session.save();
    session.dispatch(cmd({ type: 'boom' }));
    expect(session.get().meta.notice?.code).toBe('EngineThrew');
    expect(session.save()).toEqual(before);
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'The engine threw in apply.');
  });

  it('accepts a resignation off-turn and stops play', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    session.dispatch({ kind: 'resign', seat: 1 });
    expect(session.get().meta.outcome?.placements).toEqual([{ seat: 0, place: 1 }]);
    session.dispatch({ kind: 'resign', seat: 0 });
    expect(session.get().meta.notice?.code).toBe('GameOver');
  });

  it('rejects a resignation for an AI seat', () => {
    const { session } = setup();
    session.dispatch({ kind: 'resign', seat: 1 });
    expect(session.get().meta.notice?.code).toBe('InvalidSeat');
  });

  it('hands a seat to a person with a seat input', async () => {
    const { session, clock } = setup();
    session.dispatch(take(1));
    session.dispatch({ kind: 'seat', seat: 1, change: { type: 'controller', controller: 'human', name: 'Bo' } });
    expect(session.get().meta.seats[1]).toEqual({ id: 1, name: 'Bo', controller: 'human' });
    expect(session.get().thinking).toEqual([]);
    clock.advance(1000);
    await flush();
    expect(session.get().view.heap).toBe(9);
    expect(session.replay()?.inputs.at(-1)?.kind).toBe('seat');
  });

  it('rejects an AI level the engine lacks', () => {
    const { session } = setup();
    session.dispatch({
      kind: 'seat',
      seat: 1,
      change: { type: 'controller', controller: 'ai', name: 'X', aiLevel: 'godlike' },
    });
    expect(session.get().meta.notice?.code).toBe('InvalidSeat');
  });

  it('refuses invalid seats or config at creation', () => {
    const base = {
      manifest: nimManifest(),
      mode: 'ai' as const,
      seed: seed(1),
      restoreRng: testRng,
      clock: manualClock(),
    };
    expect(createLocalSession(nim, { ...base, seats: [ana, bot], config: { heap: -1 } })).toMatchObject({
      ok: false,
      error: { code: 'InvalidInput' },
    });
    expect(createLocalSession(nim, { ...base, seats: [ana, { ...ben, id: 5 }], config: { heap: 3 } })).toMatchObject({
      ok: false,
      error: { code: 'InvalidSeats' },
    });
    expect(createLocalSession(nim, { ...base, seats: [ana], config: { heap: 3 } })).toMatchObject({
      ok: false,
      error: { code: 'Seats' },
    });
  });
});

describe('AI seats', () => {
  it('plays the AI seat after the delay, showing it as thinking meanwhile', async () => {
    const { session, clock } = setup();
    session.dispatch(take(1));
    expect(session.get().thinking).toEqual([1]);
    expect(session.get().pending).toEqual([1]);
    clock.advance(99);
    await flush();
    expect(session.get().view.heap).toBe(9);
    clock.advance(1);
    await flush();
    // Hard AI leaves a multiple of four.
    expect(session.get().view.heap).toBe(8);
    expect(session.get().thinking).toEqual([]);
    expect(session.get().pending).toEqual([0]);
  });

  it('shows the AI only its own seat’s view, as a copy', async () => {
    const { session, clock } = setup();
    session.dispatch(take(1));
    clock.advance(100);
    await flush();
    expect(aiViews).toHaveLength(1);
    const { seat, view } = aiViews[0]!;
    expect(seat).toBe(1);
    expect(view.secrets[0]).toBeNull();
    expect(view.secrets[1]).toEqual(expect.any(Number));
    expect(Object.isFrozen(view)).toBe(false);
  });

  it('plays an AI-only game to the end for a spectator', async () => {
    const { session, clock } = setup({ seats: [{ ...bot, id: 0, aiLevel: 'easy' }, bot], seat: null });
    for (let i = 0; i < 20 && session.get().meta.outcome === null; i += 1) {
      clock.advance(100);
      await flush();
    }
    expect(session.get().meta.outcome).not.toBeNull();
    expect(session.get().meta.seat).toBeNull();
    expect(session.get().view.secrets).toEqual([null, null]);
    session.dispatch(take(1));
    expect(session.get().meta.notice?.code).toBe('Spectator');
  });

  it('cancels a pending AI choice on dispose', async () => {
    const { session, clock } = setup();
    session.dispatch(take(1));
    session.dispose();
    clock.advance(1000);
    await flush();
    expect(aiViews).toHaveLength(0);
  });

  it('cancels AI while paused and resumes it afterwards', async () => {
    const { session, clock } = setup();
    session.dispatch(take(1));
    session.dispatch({ kind: 'pause' });
    expect(session.get().paused).toBe(true);
    expect(session.get().thinking).toEqual([]);
    clock.advance(1000);
    await flush();
    expect(session.get().view.heap).toBe(9);
    session.dispatch(take(1));
    expect(session.get().meta.notice?.code).toBe('Paused');
    session.dispatch({ kind: 'resume' });
    clock.advance(100);
    await flush();
    expect(session.get().view.heap).toBe(8);
  });

  it('drives a custom (asynchronous) AI runner and validates what it returns', async () => {
    const ai: AiRunner<NimState> = {
      choose: () => ({ result: Promise.resolve({ type: 'teleport' }), cancel: () => {} }),
    };
    const { session, report } = setup({ ai });
    session.dispatch(take(1));
    await flush();
    expect(session.get().meta.notice?.code).toBe('AiFailed');
    expect(session.get().view.heap).toBe(9);
    expect(report).toHaveBeenCalled();
  });

  it('ignores a cancelled AI runner’s late answer', async () => {
    let answer: (value: unknown) => void = () => {};
    const ai: AiRunner<NimState> = {
      choose: () => ({ result: new Promise((resolve) => (answer = resolve)), cancel: () => {} }),
    };
    const { session } = setup({ ai });
    session.dispatch(take(1));
    session.dispatch({ kind: 'undo' });
    answer({ type: 'take', count: 3 });
    await flush();
    expect(session.get().view.heap).toBe(10);
  });
});

describe('determinism and replay', () => {
  const play = async () => {
    const t = setup({ seats: [ana, { ...bot, aiLevel: 'easy' }] });
    for (const count of [1, 2, 1, 3]) {
      if (t.session.get().meta.outcome !== null) break;
      t.session.dispatch(take(Math.min(count, t.session.get().view.heap)));
      t.clock.advance(100);
      await flush();
    }
    return t.session;
  };

  it('plays the same game twice from the same seeds and inputs', async () => {
    const a = await play();
    const b = await play();
    expect(a.save()).toEqual(b.save());
  });

  it('replays its own log to the same state and random state', async () => {
    const session = await play();
    const replay = session.replay() as EngineReplay<NimCommand, { heap: number }>;
    const replayed = replayEngine(nim, replay, testRng);
    expect(replayed).toMatchObject({ ok: true, value: { state: session.save().state, rng: session.save().rng } });
  });

  it('reports the undo barriers in a replay', () => {
    const { session } = setup();
    session.dispatch(cmd({ type: 'hint' }));
    const replayed = replayEngine(nim, session.replay() as EngineReplay<NimCommand, { heap: number }>, testRng);
    expect(replayed.ok && replayed.value.barriers).toEqual([0]);
  });
});

describe('undo', () => {
  it('returns to the human’s previous decision, taking back the AI reply', async () => {
    const { session, clock } = setup();
    session.dispatch(take(1));
    clock.advance(100);
    await flush();
    expect(session.get().view.heap).toBe(8);
    expect(session.get().undo).toEqual({ available: true, remaining: null, blockedBy: null });
    session.dispatch({ kind: 'undo' });
    expect(session.get().view.heap).toBe(10);
    expect(session.get().view.turn).toBe(0);
    expect(session.get().meta.undosUsed).toBe(1);
    expect(session.replay()?.inputs).toEqual([]);
    expect(session.get().undo.blockedBy).toBe('NothingToUndo');
  });

  it('takes back a move while the AI is still thinking', async () => {
    const { session, clock } = setup();
    session.dispatch(take(2));
    session.dispatch({ kind: 'undo' });
    expect(session.get().thinking).toEqual([]);
    clock.advance(1000);
    await flush();
    expect(session.get().view.heap).toBe(10);
  });

  it('never steps back past an undo barrier', async () => {
    const { session, clock } = setup({ mode: 'solo', seats: [ana, { ...ben, controller: 'ai' }] });
    session.dispatch(cmd({ type: 'hint' }));
    session.dispatch({ kind: 'undo' });
    expect(session.get().meta.notice?.code).toBe('UndoBarrier');
    expect(session.get().view.hints).toBe(1);
    session.dispatch(take(1));
    clock.advance(100);
    await flush();
    session.dispatch({ kind: 'undo' });
    expect(session.get().view.heap).toBe(10);
    expect(session.get().view.hints).toBe(1);
    expect(session.get().undo.blockedBy).toBe('UndoBarrier');
  });

  it('honours a limited allowance', () => {
    const { session } = setup({ manifest: nimManifest({ undo: { limited: 1 } }) });
    expect(session.get().undo.remaining).toBe(1);
    session.dispatch(take(1));
    session.dispatch({ kind: 'undo' });
    expect(session.get().undo.remaining).toBe(0);
    session.dispatch(take(1));
    session.dispatch({ kind: 'undo' });
    expect(session.get().meta.notice?.code).toBe('UndoLimit');
  });

  it('is unavailable when the manifest says none, and in pass-and-play', () => {
    const none = setup({ manifest: nimManifest({ undo: 'none' }) });
    none.session.dispatch(take(1));
    none.session.dispatch({ kind: 'undo' });
    expect(none.session.get().meta.notice?.code).toBe('UndoNotAllowed');
    const local = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    local.session.dispatch(take(1));
    local.session.dispatch({ kind: 'undo' });
    expect(local.session.get().meta.notice?.code).toBe('UndoNotAllowed');
  });

  it('replays the randomness too, so an undone gamble comes out the same', () => {
    const { session } = setup({ seats: [ana, { ...bot }], config: { heap: 30 } });
    session.dispatch(cmd({ type: 'gamble' }));
    const first = session.get().view.heap;
    session.dispatch({ kind: 'undo' });
    session.dispatch(cmd({ type: 'gamble' }));
    expect(session.get().view.heap).toBe(first);
  });

  it('is refused once the game is over', () => {
    const { session } = setup({ config: { heap: 2 } });
    session.dispatch(take(2));
    session.dispatch({ kind: 'undo' });
    expect(session.get().meta.notice?.code).toBe('GameOver');
  });
});

describe('undo per mode (D-32)', () => {
  it('reads the rule for the active mode', () => {
    const undo = { solo: 'unlimited', vsAi: 'none' } as const;
    const vsAi = setup({ manifest: nimManifest({ undo }) });
    vsAi.session.dispatch(take(1));
    vsAi.session.dispatch({ kind: 'undo' });
    expect(vsAi.session.get().meta.notice?.code).toBe('UndoNotAllowed');
    expect(vsAi.session.get().undo.remaining).toBe(0);
    const solo = setup({ manifest: nimManifest({ undo }), mode: 'solo' });
    solo.session.dispatch(take(1));
    solo.session.dispatch({ kind: 'undo' });
    expect(solo.session.get().view.heap).toBe(10);
  });

  it('allows pass-and-play undo only when the manifest names it, taking back the last person’s move', () => {
    const t = setup({
      manifest: nimManifest({ undo: { passAndPlay: { limited: 2 } } }),
      mode: 'pass-and-play',
      seats: [ana, ben],
    });
    t.session.dispatch(take(1));
    expect(t.session.get().meta.seat).toBe(1);
    t.session.dispatch({ kind: 'undo' });
    expect(t.session.get().view.heap).toBe(10);
    expect(t.session.get().meta.seat).toBe(0);
    expect(t.session.get().undo.remaining).toBe(1);
  });

  it('still refuses two people outside pass-and-play', () => {
    const { session } = setup({ seats: [ana, ben] });
    session.dispatch(take(1));
    session.dispatch({ kind: 'undo' });
    expect(session.get().meta.notice?.code).toBe('UndoNotAllowed');
  });
});

describe('undo and assistance records', () => {
  it('retains undoable hint and shuffle counts after their states are removed and restored', async () => {
    const undoable = {
      ...nim,
      apply: ((state, input, rng) => {
        const result = nim.apply(state, input, rng);
        if (result.ok && input.kind === 'command' && input.command.type === 'hint')
          return {
            ...result,
            value: { ...result.value, undoBarrier: false, assist: state.hints === 0 ? 'hint' : 'shuffle' },
          };
        return result;
      }) as typeof nim.apply,
    };
    const clock = manualClock(),
      storage = memoryStore(),
      jobs = manualJobs();
    const options = {
      manifest: nimManifest(),
      mode: 'ai' as const,
      seats: [ana, bot],
      config: { heap: 10 },
      seed: seed(42),
      restoreRng: testRng,
      clock,
      storage,
      jobs,
      report: vi.fn(),
    };
    const opened = createLocalSession(undoable, options);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value;
    session.dispatch(cmd({ type: 'hint' }));
    session.dispatch(cmd({ type: 'hint' }));
    session.dispatch({ kind: 'undo' });
    await flush();
    session.dispatch({ kind: 'undo' });
    await flush();
    expect(session.get().meta.notice).toBeNull();
    expect(session.get().view.hints).toBe(0);
    expect(session.get().meta.assistCounts).toEqual({ hint: 1, shuffle: 1, undo: 2 });
    const { replay: _replay, ...saved } = session.save();
    session.dispose();
    const restored = await restoreLocalSession(undoable, saved, { ...options, migrations: [] });
    expect(restored).toMatchObject({ ok: true });
    if (!restored.ok) return;
    try {
      expect(restored.value.get().meta.assistCounts).toEqual({ hint: 1, shuffle: 1, undo: 2 });
      restored.value.dispatch({ kind: 'resign', seat: 0 });
      expect(restored.value.get().meta.outcome?.assistCounts).toEqual({ hint: 1, shuffle: 1, undo: 2 });
    } finally {
      restored.value.dispose();
    }
  });
  it('keeps exact counts through undo, reload, and a save without its replay', async () => {
    const t = setup({ config: { heap: 10 } });
    t.session.dispatch(cmd({ type: 'hint' }));
    t.session.dispatch(cmd({ type: 'hint' }));
    t.session.dispatch(take(1));
    t.session.dispatch({ kind: 'undo' });
    const previous = t.session.get().meta.assistCounts;
    expect(previous).toEqual({ hint: 2, undo: 1 });
    t.session.dispatch(cmd({ type: 'hint' }));
    expect(previous).toEqual({ hint: 2, undo: 1 });
    expect(t.session.get().meta.assistCounts).toEqual({ hint: 3, undo: 1 });
    await flush();
    const { replay: _replay, ...save } = t.session.save();
    t.session.dispose();
    const restored = restoreLocalSession(nim, save, restoreOptions(t));
    if (!restored.ok) throw new Error(restored.error.message);
    try {
      expect(restored.value.get().meta.assistCounts).toEqual({ hint: 3, undo: 1 });
      restored.value.dispatch(cmd({ type: 'hint' }));
      expect(restored.value.get().meta.assistCounts).toEqual({ hint: 4, undo: 1 });
    } finally {
      restored.value.dispose();
    }
  });
  it('records undos and flagged assistance in the meta, the save and the outcome', async () => {
    const t = setup({ config: { heap: 4 } });
    t.session.dispatch(cmd({ type: 'hint' }));
    expect(t.session.get().meta.assists).toEqual(['hint']);
    t.session.dispatch(take(1));
    t.session.dispatch({ kind: 'undo' });
    expect(t.session.get().meta).toMatchObject({ undosUsed: 1, assists: ['undo', 'hint'] });
    expect(t.session.save()).toMatchObject({ undosUsed: 1, assists: ['undo', 'hint'] });
    t.session.dispatch(take(3));
    t.clock.advance(100);
    await flush();
    expect(t.session.get().meta.outcome).toMatchObject({ undosUsed: 1, assists: ['undo', 'hint'] });
  });

  it('writes empty records for an unassisted game', () => {
    const { session } = setup({ config: { heap: 2 } });
    session.dispatch(take(2));
    expect(session.get().meta.outcome).toMatchObject({ undosUsed: 0, assists: [] });
  });

  it('keeps a limited allowance and the assistance across a reload', async () => {
    const t = setup({ manifest: nimManifest({ undo: { limited: 1 } }) });
    t.session.dispatch(take(1));
    t.session.dispatch({ kind: 'undo' });
    t.session.dispatch(take(2));
    await flush();
    t.session.dispose();
    await flush();
    const restored = restoreLocalSession(
      nim,
      t.storage.last(),
      restoreOptions(t, { manifest: nimManifest({ undo: { limited: 1 } }) }),
    );
    if (!restored.ok) throw new Error(restored.error.message);
    const session = restored.value;
    expect(session.get().meta).toMatchObject({ undosUsed: 1, assists: ['undo'] });
    expect(session.get().undo).toMatchObject({ remaining: 0, blockedBy: 'UndoLimit' });
  });

  it('keeps assistance the save recorded even when its replay is lost', async () => {
    const t = setup();
    t.session.dispatch(cmd({ type: 'hint' }));
    await flush();
    const { replay: _replay, ...withoutReplay } = t.storage.last() as SaveEnvelope;
    const restored = restoreLocalSession(nim, withoutReplay, restoreOptions(t));
    expect(restored.ok && restored.value.get().meta.assists).toEqual(['hint']);
  });

  it('restores an older save that has none of the records', async () => {
    const t = setup();
    t.session.dispatch(take(1));
    await flush();
    const { aiRng: _ai, undosUsed: _undos, assists: _assists, ...old } = t.storage.last() as SaveEnvelope;
    const restored = restoreLocalSession(nim, old, restoreOptions(t));
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.value.get().meta).toMatchObject({ undosUsed: 0, assists: [] });
    expect(restored.value.save().aiRng).toEqual(expect.objectContaining({ algorithm: 'sfc32' }));
  });

  it('refuses malformed records', async () => {
    const t = setup();
    await flush();
    const latest = t.storage.last() as SaveEnvelope;
    const code = (save: unknown) => {
      const result = restoreLocalSession(nim, save, restoreOptions(t));
      return result.ok ? 'ok' : (result.error.detail as { why?: string } | undefined)?.why;
    };
    expect(code({ ...latest, undosUsed: -1 })).toBe('undosUsed');
    expect(code({ ...latest, assists: ['peek'] })).toBe('assists');
    for (const assistCounts of [
      { hint: -1 },
      { hint: 1.5 },
      { hint: '2' },
      { peek: 1 },
      { hint: Number.MAX_SAFE_INTEGER + 1 },
      [],
    ])
      expect(code({ ...latest, assistCounts })).toBe('assistCounts');
    expect(code({ ...latest, aiRng: { algorithm: 'sfc32' } })).toBe('aiRng');
  });
});

describe('the AI’s random stream', () => {
  const easyBot: SeatInfo = { ...bot, aiLevel: 'easy' };

  it('gives each choice its own SFC32 stream from the AI stream, never the game’s', async () => {
    const tasks: { seat: number; rng: { algorithm: string } }[] = [];
    const ai: AiRunner<NimState> = {
      choose: (task) => {
        tasks.push({ seat: task.seat, rng: task.rng });
        return { result: Promise.resolve({ type: 'take', count: 1 }), cancel: () => {} };
      },
    };
    const { session } = setup({ ai });
    session.dispatch(take(1));
    await flush();
    session.dispatch(take(1));
    await flush();
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.rng.algorithm).toBe('sfc32');
    expect(tasks[0]!.rng).not.toEqual(tasks[1]!.rng);
  });

  it('saves the AI stream, so a restored vs-AI game continues exactly as the original', async () => {
    const t = setup({ seats: [ana, easyBot], config: { heap: 40 } });
    t.session.dispatch(take(1));
    t.clock.advance(100);
    await flush();
    t.session.dispatch(take(1));
    await flush();
    // Saved while the AI is thinking about its second move.
    const saved = t.storage.last() as SaveEnvelope;
    expect(saved.aiRng).toEqual(t.session.save().aiRng);
    const restored = restoreLocalSession(nim, saved, restoreOptions(t, { clock: t.clock, aiSeed: seed(999) }));
    if (!restored.ok) throw new Error(restored.error.message);
    const copy = restored.value;
    for (const count of [2, 1, 3, 2]) {
      t.clock.advance(100);
      await flush();
      if (t.session.get().meta.outcome !== null) break;
      expect(copy.get().view).toEqual(t.session.get().view);
      t.session.dispatch(take(count));
      copy.dispatch(take(count));
    }
    t.clock.advance(100);
    await flush();
    expect(copy.save()).toEqual(t.session.save());
  });

  it('reports a heavy AI that has no worker runner, then plays it inline', async () => {
    const { session, clock, report } = setup({
      manifest: nimManifest({ ai: { levels: ['easy', 'hard'], heavy: true } }),
    });
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'Running heavy AI on the main thread.');
    session.dispatch(take(1));
    clock.advance(100);
    await flush();
    expect(session.get().view.heap).toBe(8);
  });

  it('defaults to the kit’s generator for the game’s random state', () => {
    const result = createLocalSession(nim, {
      manifest: nimManifest(),
      mode: 'ai',
      seats: [ana, bot],
      config: { heap: 10 },
      seed: seedState('nim:42'),
      clock: manualClock(),
    });
    expect(result.ok && result.value.save().rng.algorithm).toBe('sfc32');
  });
});

describe('elapsed time', () => {
  it('starts at the first accepted input, pauses while hidden and stops at the outcome', () => {
    const { session, clock, visibility } = setup({ mode: 'pass-and-play', seats: [ana, ben], config: { heap: 3 } });
    clock.advance(5000);
    expect(session.elapsedMs()).toBe(0);
    session.dispatch(take(1));
    clock.advance(1000);
    expect(session.elapsedMs()).toBe(1000);
    visibility.set(true);
    clock.advance(60_000);
    visibility.set(false);
    expect(session.elapsedMs()).toBe(1000);
    session.dispatch({ kind: 'pause' });
    clock.advance(60_000);
    session.dispatch({ kind: 'resume' });
    clock.advance(500);
    session.dispatch(take(2));
    expect(session.get().meta.outcome?.elapsedMs).toBe(1500);
    clock.advance(10_000);
    expect(session.elapsedMs()).toBe(1500);
    expect(session.save().elapsedMs).toBe(1500);
  });
});

describe('a game-defined clock start and worthSaving', () => {
  /** A pass-and-play game of `engine` on a heap of 10, with a fake clock and storage. */
  const timed = (engine: typeof nim = timedNim(10)) => {
    const clock = manualClock();
    const visibility = manualVisibility();
    const storage = memoryStore();
    const report = vi.fn();
    const ports = {
      manifest: nimManifest({ undo: { passAndPlay: 'unlimited' } }),
      mode: 'pass-and-play' as const,
      restoreRng: testRng,
      clock,
      visibility,
      storage,
      report,
    };
    const result = createLocalSession(engine, { ...ports, seats: [ana, ben], config: { heap: 10 }, seed: seed(42) });
    if (!result.ok) throw new Error(result.error.message);
    const restore = (save: unknown) => {
      const restored = restoreLocalSession(engine, save, { ...ports, migrations: nimMigrations });
      if (!restored.ok) throw new Error(restored.error.message);
      return restored.value;
    };
    return { session: result.value, clock, visibility, storage, report, restore };
  };

  it('starts a new confirmed game with a fresh clock and help, saves it and preserves its undo barrier', () => {
    const base = timedNim(10),
      engine: typeof nim = {
        ...base,
        apply: (state, input, rng) =>
          input.kind === 'command' && input.command.type === 'take' && input.command.count === 0
            ? ok({
                state: { ...state, heap: 10, turn: 0, winner: null, hints: 0, rolling: null },
                beats: [],
                undoBarrier: true,
                restartsGame: true,
              })
            : base.apply(state, input, rng),
      };
    const t = timed(engine);
    t.session.dispatch(take(1));
    t.clock.advance(800);
    t.session.dispatch(cmd({ type: 'hint' }));
    expect(t.session.get().meta.assists).toContain('hint');
    t.session.dispatch(take(0));
    expect(t.session.elapsedMs()).toBe(0);
    expect(t.session.get().meta.assists).toEqual([]);
    expect(t.session.get().undo.blockedBy).toBe('UndoBarrier');
    t.clock.advance(2000);
    expect(t.session.elapsedMs()).toBe(0);
    const restored = t.restore(t.session.save());
    expect(restored.get().meta.assists).toEqual([]);
    expect(restored.elapsedMs()).toBe(0);
    restored.dispatch(take(1));
    t.clock.advance(250);
    expect(restored.elapsedMs()).toBe(250);
    restored.dispatch(take(3));
    restored.dispatch(take(3));
    restored.dispatch(take(3));
    expect(restored.get().meta.outcome).not.toBeNull();
    restored.dispatch(take(0));
    t.clock.advance(500);
    expect(restored.elapsedMs()).toBe(0);
    restored.dispatch(take(1));
    t.clock.advance(100);
    expect(restored.elapsedMs()).toBe(100);
    expect(replayEngine(engine, restored.replay()!, testRng)).toMatchObject({ ok: true });
    restored.dispose();
    t.session.dispose();
  });
  it('rejects a restart without an undo barrier without changing time or state', () => {
    const base = timedNim(10),
      engine: typeof nim = {
        ...base,
        apply: (state, input, rng) =>
          input.kind === 'command' && input.command.type === 'take' && input.command.count === 0
            ? (rng.next(), ok({ state: { ...state, heap: 10 }, beats: [], restartsGame: true }))
            : base.apply(state, input, rng),
      },
      t = timed(engine);
    t.session.dispatch(take(1));
    t.clock.advance(500);
    const before = t.session.save().rng;
    t.session.dispatch(take(0));
    expect(t.session.save().rng).toEqual(before);
    expect(t.session.get().meta.notice?.code).toBe('BadRestart');
    expect(t.session.get().view.heap).toBe(9);
    expect(t.session.elapsedMs()).toBe(500);
    t.session.dispose();
  });
  it('runs no clock before the transition that starts it', () => {
    const { session, clock } = timed();
    clock.advance(5000);
    session.dispatch(cmd({ type: 'hint' }));
    clock.advance(3000);
    expect(session.get().meta.revision).toBe(1);
    expect(session.elapsedMs()).toBe(0);
    expect(session.save()).toMatchObject({ elapsedMs: 0, clockStarted: false });
    session.dispatch(take(1));
    clock.advance(1000);
    expect(session.elapsedMs()).toBe(1000);
    expect(session.save()).toMatchObject({ elapsedMs: 1000, clockStarted: true });
  });

  it('keeps the clock running when a later transition sets startsClock again', () => {
    const { session, clock } = timed();
    session.dispatch(take(1));
    clock.advance(1000);
    session.dispatch({ kind: 'undo' });
    expect(session.get().view.heap).toBe(10);
    clock.advance(1000);
    session.dispatch(take(1));
    clock.advance(1000);
    expect(session.elapsedMs()).toBe(3000);
  });

  it('resumes with the right elapsed time, from a save whose clock has started', async () => {
    const t = timed();
    t.clock.advance(4000);
    t.session.dispatch(take(1));
    t.clock.advance(2000);
    t.session.dispose();
    await flush();
    expect(t.storage.slot()).toMatchObject({ elapsedMs: 2000, clockStarted: true });
    const resumed = t.restore(t.storage.slot());
    expect(resumed.elapsedMs()).toBe(2000);
    t.clock.advance(500);
    expect(resumed.elapsedMs()).toBe(2500);
  });

  it('resumes a save whose clock has not started without starting it', async () => {
    // Every position is worth saving here, so a game with only a hint is saved.
    const t = timed({ ...timedNim(10), worthSaving: undefined });
    t.session.dispatch(cmd({ type: 'hint' }));
    t.clock.advance(2000);
    t.session.dispose();
    await flush();
    expect(t.storage.slot()).toMatchObject({ elapsedMs: 0, clockStarted: false });
    const resumed = t.restore(t.storage.slot());
    t.clock.advance(1000);
    expect(resumed.elapsedMs()).toBe(0);
    resumed.dispatch(take(1));
    t.clock.advance(700);
    expect(resumed.elapsedMs()).toBe(700);
  });

  it('infers the clock from the replay for a save written before clockStarted existed', async () => {
    const t = timed({ ...timedNim(10), worthSaving: undefined });
    t.session.dispatch(cmd({ type: 'hint' }));
    await flush();
    const { clockStarted: _hinted, ...hintOnly } = t.storage.slot() as SaveEnvelope;
    t.session.dispatch(take(1));
    await flush();
    const { clockStarted: _took, ...took } = t.storage.slot() as SaveEnvelope;
    const fromHint = t.restore(hintOnly);
    const fromTake = t.restore(took);
    t.clock.advance(800);
    expect(fromHint.elapsedMs()).toBe(0);
    expect(fromTake.elapsedMs()).toBe(800);
  });

  it('starts the clock at the first input for an engine that declares no clock start', () => {
    const { session, clock } = timed({ ...timedNim(10), clockStart: undefined });
    session.dispatch(cmd({ type: 'hint' }));
    clock.advance(1000);
    expect(session.elapsedMs()).toBe(1000);
  });

  it('never saves an untouched game, and clears the save when undo returns to one', async () => {
    const t = timed();
    t.session.dispatch(cmd({ type: 'hint' }));
    t.visibility.set(true);
    t.visibility.set(false);
    t.session.dispatch({ kind: 'pause' });
    t.session.dispatch({ kind: 'resume' });
    await flush();
    expect(t.storage.saves).toHaveLength(0);
    t.session.dispatch(take(1));
    await flush();
    expect(t.storage.slot()).toMatchObject({ state: { heap: 9 } });
    const clearsBefore = t.storage.clears;
    t.session.dispatch({ kind: 'undo' });
    t.session.dispose();
    await flush();
    expect(t.session.get().view.heap).toBe(10);
    expect(t.storage.slot()).toBeNull();
    expect(t.storage.clears).toBe(clearsBefore + 1);
  });

  it('saves every position of an engine without worthSaving, as before', async () => {
    const t = timed({ ...timedNim(10), worthSaving: undefined });
    await flush();
    expect(t.storage.saves).toHaveLength(1);
    expect(t.storage.clears).toBe(0);
  });

  it('saves when worthSaving throws, and reports it', async () => {
    const t = timed({
      ...timedNim(10),
      worthSaving: () => {
        throw new Error('broken hook');
      },
    });
    await flush();
    expect(t.storage.saves).toHaveLength(1);
    expect(t.report).toHaveBeenCalledWith(expect.objectContaining({ message: 'broken hook' }), expect.any(String));
  });
});

describe('saves', () => {
  it('saves the starting position and every accepted change', async () => {
    const t = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    t.session.dispatch(take(1));
    t.session.dispatch(take(5)); // rejected: no save
    await flush();
    expect(t.storage.saves).toHaveLength(2);
    expect(t.storage.last()).toMatchObject({
      gameId: 'nim',
      build: '1.0.0',
      rulesVersion: 1,
      saveVersion: 2,
      state: { heap: 9 },
    });
    expect(t.storage.last()?.replay).toMatchObject({ layer: 2, inputs: [{ kind: 'command', seat: 0 }] });
  });

  it('saves when the page hides', async () => {
    const t = setup();
    await flush();
    const before = t.storage.saves.length;
    t.visibility.set(true);
    await flush();
    expect(t.storage.saves.length).toBe(before + 1);
  });

  it('reports a failed save with a notice and keeps playing', async () => {
    const t = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    await flush();
    t.storage.failNext = true;
    t.session.dispatch(take(1));
    await flush();
    expect(t.session.get().meta.notice?.code).toBe('SaveFailed');
    t.session.dispatch(take(1));
    expect(t.session.get().view.heap).toBe(8);
  });

  it('restores a save: same position, same play time, and undo still works', async () => {
    const t = setup();
    t.session.dispatch(take(1));
    t.clock.advance(100);
    await flush();
    t.session.dispose();
    await flush();
    const restored = restoreLocalSession(nim, t.storage.last(), restoreOptions(t, { aiSeed: seed(7) }));
    if (!restored.ok) throw new Error(restored.error.message);
    const session = restored.value;
    expect(session.get().view).toEqual(t.session.get().view);
    expect(session.elapsedMs()).toBe(t.session.elapsedMs());
    expect(session.replay()).toEqual(t.session.replay());
    session.dispatch({ kind: 'undo' });
    expect(session.get().view.heap).toBe(10);
  });

  it('migrates an old save version before validating it', async () => {
    const t = setup();
    t.session.dispatch(take(1));
    await flush();
    const latest = t.storage.last() as SaveEnvelope;
    const { hints: _hints, ...oldState } = latest.state as NimState;
    const old = { ...latest, saveVersion: 1, state: oldState };
    const restored = restoreLocalSession(nim, old, restoreOptions(t));
    expect(restored.ok && restored.value.get().view.hints).toBe(0);
    expect(restored.ok && restored.value.get().undo.available).toBe(true);
  });

  it('refuses saves it cannot continue', async () => {
    const t = setup();
    await flush();
    const latest = t.storage.last() as SaveEnvelope;
    const code = (save: unknown) => {
      const result = restoreLocalSession(nim, save, restoreOptions(t));
      return result.ok ? 'ok' : result.error.code;
    };
    expect(code('garbage')).toBe('SaveUnreadable');
    expect(code({ ...latest, rng: { algorithm: 1 } })).toBe('SaveUnreadable');
    expect(code({ ...latest, gameId: 'chess' })).toBe('SaveWrongGame');
    expect(code({ ...latest, rulesVersion: 2 })).toBe('RulesChanged');
    expect(code({ ...latest, saveVersion: 3 })).toBe('SaveFromFuture');
    expect(code({ ...latest, saveVersion: 0 })).toBe('MigrationMissing');
    expect(code({ ...latest, state: { heap: 'many' } })).toBe('InvalidInput');
    expect(code(latest)).toBe('ok');
  });

  it('resumes without history when the replay no longer matches the state', async () => {
    const t = setup();
    t.session.dispatch(take(1));
    await flush();
    const latest = t.storage.last() as SaveEnvelope;
    const tampered = { ...latest, state: { ...(latest.state as NimState), heap: 3 } };
    const restored = restoreLocalSession(nim, tampered, restoreOptions(t));
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.value.get().view.heap).toBe(3);
    expect(restored.value.get().undo.blockedBy).toBe('HistoryUnavailable');
    expect(restored.value.replay()).toBeNull();
    expect(restored.value.save().replay).toBeUndefined();
    expect(t.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'HistoryUnavailable' }), expect.any(String));
  });
});

describe('jobs', () => {
  const passAndPlay = () => setup({ mode: 'pass-and-play', seats: [ana, ben] });

  it('starts a job only after the transition that requested it is saved', async () => {
    const t = passAndPlay();
    await flush();
    t.storage.hold = true;
    t.session.dispatch(cmd({ type: 'roll' }));
    expect(t.session.get().pending).toEqual([]);
    await flush();
    expect(t.jobs.started).toEqual([]);
    t.storage.release();
    await flush();
    expect(t.jobs.started).toEqual([{ id: 'roll-0', kind: 'dice', payload: { sides: 3 } }]);
  });

  it('feeds the value to the engine and the presentation to the snapshot only', async () => {
    const t = passAndPlay();
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    t.jobs.resolve('roll-0', { ok: true, value: 2, presentation: { frames: [1, 2, 3] } });
    await flush();
    expect(t.session.get().view.heap).toBe(8);
    expect(t.session.get().presentation).toEqual({ frames: [1, 2, 3] });
    expect(t.session.replay()?.inputs.at(-1)).toEqual({
      kind: 'job',
      jobId: 'roll-0',
      outcome: { ok: true, value: 2 },
    });
    t.session.dispatch(take(1));
    expect(t.session.get().presentation).toBeNull();
  });

  it('times a job out and tells the engine', async () => {
    const t = passAndPlay();
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    t.clock.advance(5000);
    await flush();
    expect(t.jobs.cancelled).toEqual(['roll-0']);
    expect(t.session.replay()?.inputs.at(-1)).toEqual({
      kind: 'job',
      jobId: 'roll-0',
      outcome: { ok: false, reason: 'timeout' },
    });
    expect(t.session.get().pending).toEqual([0]);
  });

  it('turns an invalid or failed result into a failure', async () => {
    const t = passAndPlay();
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    t.jobs.resolve('roll-0', { ok: true, value: 'six' });
    await flush();
    expect(t.session.replay()?.inputs.at(-1)).toMatchObject({ kind: 'job', outcome: { ok: false, reason: 'failed' } });
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    t.jobs.reject('roll-2', new Error('worker died'));
    await flush();
    expect(t.session.replay()?.inputs.at(-1)).toMatchObject({ kind: 'job', jobId: 'roll-2', outcome: { ok: false } });
  });

  it('drops a late result for a job that undo took back', async () => {
    const t = setup();
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    t.session.dispatch({ kind: 'undo' });
    expect(t.jobs.cancelled).toEqual(['roll-0']);
    t.jobs.resolve('roll-0', { ok: true, value: 3 });
    await flush();
    expect(t.session.get().view.heap).toBe(10);
    expect(t.session.replay()?.inputs).toEqual([]);
  });

  it('re-runs an outstanding job after a restore', async () => {
    const t = passAndPlay();
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    t.session.dispose();
    await flush();
    const jobs = manualJobs();
    const restored = restoreLocalSession(nim, t.storage.last(), { ...restoreOptions(t), mode: 'pass-and-play', jobs });
    if (!restored.ok) throw new Error(restored.error.message);
    await flush();
    expect(jobs.started.map((job) => job.id)).toEqual(['roll-0']);
    jobs.resolve('roll-0', { ok: true, value: 1 });
    await flush();
    expect(restored.value.get().view.heap).toBe(9);
  });

  it('fails a job that cannot run locally', async () => {
    const t = setup({ mode: 'pass-and-play', seats: [ana, ben], jobs: undefined });
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    expect(t.session.replay()?.inputs.at(-1)).toMatchObject({ kind: 'job', outcome: { ok: false, reason: 'failed' } });
  });

  it('drops a job result that arrives after dispose', async () => {
    const t = passAndPlay();
    t.session.dispatch(cmd({ type: 'roll' }));
    await flush();
    const count = t.seen.length;
    t.session.dispose();
    t.jobs.resolve('roll-0', { ok: true, value: 1 });
    await flush();
    expect(t.seen).toHaveLength(count);
  });
});

describe('pass-and-play hand-off (D-31)', () => {
  const handoffGame = (seats: readonly SeatInfo[] = [ana, ben]) =>
    setup({ mode: 'pass-and-play', seats, manifest: nimManifest({ handoff: true }) });

  it('hides every seat’s view until the next player reveals it', () => {
    const { session } = handoffGame();
    let snapshot = session.get();
    expect(snapshot.handoff).toEqual({ seat: 0, name: 'Ana' });
    expect(snapshot.meta.seat).toBeNull();
    expect(snapshot.view.secrets).toEqual([null, null]);
    session.dispatch(take(1));
    expect(session.get().meta.notice?.code).toBe('HandoffPending');
    session.dispatch({ kind: 'reveal' });
    snapshot = session.get();
    expect(snapshot.handoff).toBeNull();
    expect(snapshot.meta.seat).toBe(0);
    expect(snapshot.view.secrets[0]).toEqual(expect.any(Number));
    expect(snapshot.view.secrets[1]).toBeNull();
    session.dispatch(take(1));
    snapshot = session.get();
    expect(snapshot.handoff).toEqual({ seat: 1, name: 'Ben' });
    expect(snapshot.view.secrets).toEqual([null, null]);
    // The beats behind the hand-off screen are the spectator's.
    expect(snapshot.beats[0]?.view?.secrets).toEqual([null, null]);
    session.dispatch({ kind: 'reveal' });
    expect(session.get().meta.seat).toBe(1);
    expect(session.get().view.secrets[1]).toEqual(expect.any(Number));
  });

  it('keeps the same viewer when a seat acts twice', () => {
    const { session } = handoffGame();
    session.dispatch({ kind: 'reveal' });
    session.dispatch(cmd({ type: 'hint' }));
    expect(session.get().handoff).toBeNull();
    expect(session.get().meta.seat).toBe(0);
    // The private beat reaches its owner.
    expect(session.get().beats).toEqual([{ event: { type: 'hinted', seat: 0 } }]);
  });

  it('skips AI seats and hands off between the people', async () => {
    const carl: SeatInfo = { id: 2, name: 'Cy', controller: 'human' };
    const { session, clock } = handoffGame([ana, bot, carl]);
    session.dispatch({ kind: 'reveal' });
    session.dispatch(take(1));
    expect(session.get().handoff).toBeNull();
    expect(session.get().meta.seat).toBe(0);
    clock.advance(100);
    await flush();
    expect(session.get().handoff).toEqual({ seat: 2, name: 'Cy' });
  });

  it('switches viewers directly when the game has no hand-off screen', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    expect(session.get().handoff).toBeNull();
    expect(session.get().meta.seat).toBe(0);
    session.dispatch(take(1));
    expect(session.get().meta.seat).toBe(1);
    session.dispatch({ kind: 'reveal' });
    expect(session.get().meta.notice?.code).toBe('NoHandoff');
  });

  it('needs a seat to resign during the hand-off', () => {
    const { session } = handoffGame();
    session.dispatch({ kind: 'resign' });
    expect(session.get().meta.notice?.code).toBe('InvalidSeat');
    session.dispatch({ kind: 'resign', seat: 0 });
    expect(session.get().meta.outcome).not.toBeNull();
    expect(session.get().handoff).toBeNull();
  });

  it('ends on the spectator’s view, so no hand is left on screen (D-31)', () => {
    const { session } = setup({
      mode: 'pass-and-play',
      seats: [ana, ben],
      manifest: nimManifest({ handoff: true }),
      config: { heap: 2 },
    });
    session.dispatch({ kind: 'reveal' });
    session.dispatch(take(1));
    session.dispatch({ kind: 'reveal' });
    expect(session.get().view.secrets[1]).toEqual(expect.any(Number));
    // Ben takes the last counter while his secret is on screen.
    session.dispatch(take(1));
    const snapshot = session.get();
    expect(snapshot.meta.outcome).not.toBeNull();
    expect(snapshot.handoff).toBeNull();
    expect(snapshot.meta.seat).toBeNull();
    expect(snapshot.view.secrets).toEqual([null, null]);
    // The final beats are the spectator's too.
    expect(snapshot.beats).toEqual([
      { event: { type: 'took', seat: 1, count: 1 }, view: expect.objectContaining({ secrets: [null, null] }) },
    ]);
    // Nobody can act on the finished board.
    session.dispatch(take(1));
    expect(session.get().meta.notice?.code).toBe('Spectator');
  });

  it('ends on the spectator’s view after a resignation and after a restore', async () => {
    const t = setup({ mode: 'pass-and-play', seats: [ana, ben], manifest: nimManifest({ handoff: true }) });
    t.session.dispatch({ kind: 'reveal' });
    t.session.dispatch({ kind: 'resign' });
    expect(t.session.get().meta.outcome).not.toBeNull();
    expect(t.session.get().meta.seat).toBeNull();
    expect(t.session.get().view.secrets).toEqual([null, null]);
    await flush();
    const restored = restoreLocalSession(nim, t.storage.last() as Json, {
      ...restoreOptions(t),
      mode: 'pass-and-play',
      manifest: nimManifest({ handoff: true }),
    });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.value.get().meta.seat).toBeNull();
    expect(restored.value.get().handoff).toBeNull();
    expect(restored.value.get().view.secrets).toEqual([null, null]);
  });

  it('shows what the engine reveals to everyone at the end', () => {
    // A variant whose rules turn every secret face up once the game is won.
    const revealing = {
      ...nim,
      viewFor: (state: NimState, viewer: number | null) => (state.winner !== null ? state : nim.viewFor(state, viewer)),
    };
    const created = createLocalSession(revealing, {
      manifest: nimManifest({ handoff: true }),
      mode: 'pass-and-play',
      seats: [ana, ben],
      config: { heap: 1 },
      seed: seed(42),
      restoreRng: testRng,
      clock: manualClock(),
    });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;
    session.dispatch({ kind: 'reveal' });
    session.dispatch(take(1));
    expect(session.get().meta.seat).toBeNull();
    expect(session.get().view.secrets).toEqual([expect.any(Number), expect.any(Number)]);
  });

  it('keeps the last viewer at the end when the game has no hand-off screen', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben], config: { heap: 1 } });
    session.dispatch(take(1));
    expect(session.get().meta.outcome).not.toBeNull();
    expect(session.get().meta.seat).toBe(0);
  });

  it('asks for the hand-off again after a restore', async () => {
    const t = handoffGame();
    t.session.dispatch({ kind: 'reveal' });
    t.session.dispatch(take(1));
    await flush();
    const restored = restoreLocalSession(nim, t.storage.last() as Json, {
      ...restoreOptions(t),
      mode: 'pass-and-play',
      manifest: nimManifest({ handoff: true }),
    });
    expect(restored.ok && restored.value.get().handoff).toEqual({ seat: 1, name: 'Ben' });
  });
});

describe('commands that name their seat (gp-o2c)', () => {
  const as = (seat: unknown, count = 1): LocalInput<NimCommand> =>
    ({ kind: 'command', seat, command: { type: 'take', count } }) as LocalInput<NimCommand>;

  it('takes a named seat in pass-and-play when that person is pending', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    session.dispatch(as(0));
    expect(session.get().meta.revision).toBe(1);
    expect(session.get().meta.seat).toBe(1);
    session.dispatch(as(1, 2));
    expect(session.get().meta.revision).toBe(2);
    expect(session.get().view.heap).toBe(7);
  });

  it('refuses a named seat that isn’t pending, or isn’t a seat at all', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben] });
    session.dispatch(as(1));
    expect(session.get().meta.notice?.code).toBe('NotYourTurn');
    for (const seat of [2, -1, 0.5, 'Ben', null]) {
      session.dispatch(as(seat));
      expect(session.get().meta.notice?.code).toBe('InvalidSeat');
    }
    expect(session.get().meta.revision).toBe(0);
  });

  it('never takes a command for an AI seat, in any mode', () => {
    const local = setup({ mode: 'pass-and-play', seats: [ana, bot] });
    local.session.dispatch(take(1));
    expect(local.session.get().pending).toEqual([1]);
    local.session.dispatch(as(1));
    expect(local.session.get().meta.notice?.code).toBe('InvalidSeat');
    const vsAi = setup({ seats: [ana, bot] });
    vsAi.session.dispatch(take(1));
    vsAi.session.dispatch(as(1));
    expect(vsAi.session.get().meta.notice?.code).toBe('InvalidSeat');
    expect(vsAi.session.get().meta.revision).toBe(1);
  });

  it('outside pass-and-play, takes only the viewer’s own seat', () => {
    const { session } = setup({ seats: [ana, ben] });
    session.dispatch(as(0));
    expect(session.get().meta.revision).toBe(1);
    // Ben is a person, and pending, but not at this device.
    expect(session.get().pending).toEqual([1]);
    session.dispatch(as(1));
    expect(session.get().meta.notice?.code).toBe('InvalidSeat');
    expect(session.get().meta.revision).toBe(1);
  });

  it('behind a hand-off screen, takes only the seat that revealed', () => {
    const { session } = setup({ mode: 'pass-and-play', seats: [ana, ben], manifest: nimManifest({ handoff: true }) });
    session.dispatch(as(0));
    expect(session.get().meta.notice?.code).toBe('HandoffPending');
    session.dispatch({ kind: 'reveal' });
    session.dispatch(as(0));
    expect(session.get().view.heap).toBe(9);
    // Ana can't move for Ben while the device waits to be passed to him.
    session.dispatch(as(1));
    expect(session.get().meta.notice?.code).toBe('HandoffPending');
    expect(session.get().view.heap).toBe(9);
  });
});
