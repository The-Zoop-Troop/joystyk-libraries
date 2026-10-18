import { isJson } from '@joystyk/contracts';
import { createRng } from '@joystyk/kit';
import { describe, expect, it } from 'vitest';
import { hintPuzzle, nim, type HintPuzzleCommand, type NimCommand } from './fixtures/index.ts';
import {
  cloneRng,
  commandInput,
  createFakeClock,
  createFakeStorage,
  deepFreeze,
  engineReplay,
  firstDifference,
  guardSchema,
  jobFailure,
  replayEngine,
  resignInput,
  saveEnvelope,
  seatInput,
  seats,
  testRng,
  testSeed,
  testSeeds,
  undoByReplay,
  validate,
} from './index.ts';
import { jsonProblem } from './deep.ts';

describe('test random sources', () => {
  it('give the same stream for the same parts, and different streams otherwise', () => {
    const draws = (rng: ReturnType<typeof testRng>) => Array.from({ length: 5 }, () => rng.int(0, 1000));
    expect(draws(testRng('a', 1))).toEqual(draws(testRng('a', 1)));
    expect(draws(testRng('a', 1))).not.toEqual(draws(testRng('a', 2)));
    expect(testSeed('a', 1)).toEqual(testRng('a', 1).save());
    expect(new Set(testSeeds('base', 5).map((s) => JSON.stringify(s))).size).toBe(5);
  });

  it('never collide with a production seed string', () => {
    expect(testRng('daily').save()).not.toEqual(createRng('daily').save());
  });

  it('clone without disturbing the original', () => {
    const rng = testRng('clone');
    const copy = cloneRng(rng);
    copy.int(0, 10);
    copy.int(0, 10);
    expect(rng.save()).not.toEqual(copy.save());
    expect(cloneRng(rng).int(0, 1e6)).toBe(rng.int(0, 1e6));
  });
});

describe('createFakeClock', () => {
  it('fires due timers in time order, reading each timer its own time', () => {
    const clock = createFakeClock(100);
    const fired: string[] = [];
    clock.setTimer(130, () => fired.push(`b@${clock.now()}`));
    clock.setTimeout(() => fired.push(`a@${clock.now()}`), 10);
    clock.setTimer(130, () => fired.push(`c@${clock.now()}`));
    expect(clock.advance(20)).toBe(1);
    expect(fired).toEqual(['a@110']);
    expect(clock.now()).toBe(120);
    clock.advanceTo(200);
    expect(fired).toEqual(['a@110', 'b@130', 'c@130']);
    expect(clock.now()).toBe(200);
  });

  it('cancels, fires timers set by callbacks, and refuses to go back', () => {
    const clock = createFakeClock();
    const fired: number[] = [];
    clock.setTimer(5, () => fired.push(5)).cancel();
    clock.setTimer(10, () => clock.setTimeout(() => fired.push(clock.now()), 5));
    expect(clock.pendingTimers()).toBe(1);
    clock.advance(20);
    expect(fired).toEqual([15]);
    expect(() => clock.advanceTo(1)).toThrow(RangeError);
  });

  it('runs every timer, and stops a timer that reschedules itself forever', () => {
    const clock = createFakeClock();
    let n = 0;
    clock.setTimer(50, () => (n += 1));
    clock.setTimer(10, () => (n += 1));
    expect(clock.runAll()).toBe(2);
    expect(clock.now()).toBe(50);
    const tick = (): void => void clock.setTimeout(tick, 1);
    tick();
    expect(() => clock.runAll(100)).toThrow(/reschedules itself/);
  });
});

describe('createFakeStorage', () => {
  it('stores JSON copies and logs every call', async () => {
    const storage = createFakeStorage({ seen: 1 });
    const value = { a: [1, 2] };
    await storage.set('k', value);
    value.a.push(3);
    expect(await storage.get('k')).toEqual({ a: [1, 2] });
    expect(await storage.get('missing')).toBeNull();
    await storage.delete('seen');
    expect(storage.entries()).toEqual({ k: { a: [1, 2] } });
    expect(storage.calls().map((c) => c.op)).toEqual(['set', 'get', 'get', 'delete']);
  });

  it('rejects values that are not JSON', async () => {
    const storage = createFakeStorage();
    await expect(storage.set('bad', { at: new Date(0) } as never)).rejects.toThrow(TypeError);
    await expect(storage.set('nan', Number.NaN)).rejects.toThrow(TypeError);
  });

  it('fails the next call of a kind on request', async () => {
    const storage = createFakeStorage();
    storage.failNext('set', new Error('disk full'));
    await expect(storage.set('k', 1)).rejects.toThrow('disk full');
    await storage.set('k', 2);
    expect(storage.entries()).toEqual({ k: 2 });
  });
});

describe('builders', () => {
  it('build seats, inputs, saves and replays that are JSON', () => {
    const table = seats(3, { ai: [2], aiLevel: 'easy' });
    expect(table.map((s) => s.controller)).toEqual(['human', 'human', 'ai']);
    expect(table[2]).toMatchObject({ aiLevel: 'easy' });
    const inputs = [
      commandInput(0, { type: 'take', count: 1 }),
      resignInput(1),
      seatInput(2, { type: 'left' }),
      jobFailure('throw-1', 'timeout'),
    ];
    const replay = engineReplay({ config: { heap: 5 }, seats: table, seed: testSeed('b'), inputs });
    const save = saveEnvelope({ state: { heap: 5 }, rng: testSeed('b'), replay });
    expect(isJson(replay) && isJson(save)).toBe(true);
    expect(save.gameId).toBe('test-game');
  });

  it('guardSchema turns a type guard into a Standard Schema', async () => {
    const even = guardSchema((v): v is number => typeof v === 'number' && v % 2 === 0, 'Expected an even number.');
    expect(await validate(even, 4)).toEqual({ ok: true, value: 4 });
    expect(await validate(even, 3)).toEqual({ ok: false, issues: [{ message: 'Expected an even number.' }] });
  });
});

describe('deep helpers', () => {
  it('name the first difference, telling -0 and missing keys apart', () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe('$.a[1].b: 2 vs 3');
    expect(firstDifference({ a: 0 }, { a: -0 })).toBe('$.a: 0 vs -0');
    expect(firstDifference({ a: undefined }, {})).toBe('$.a: undefined vs (missing)');
    expect(firstDifference({ 'x-y': [1] }, { 'x-y': [1] })).toBeNull();
  });

  it('say where a value stops being JSON', () => {
    expect(jsonProblem({ a: [1, { b: -0 }] })).toBe('-0 at $.a[1].b (JSON turns it into 0)');
    expect(jsonProblem({ when: new Date(0) })).toBe('a Date instance at $.when');
    expect(jsonProblem({ f: undefined })).toBe('undefined at $.f');
    expect(jsonProblem({ ok: [true, null, 'x', 1.5] })).toBeNull();
  });

  it('freeze deeply', () => {
    const value = deepFreeze({ a: { b: [1] } });
    expect(() => {
      (value.a.b as number[]).push(2);
    }).toThrow(TypeError);
  });
});

describe('undo by replay', () => {
  const nimReplay = (inputs: readonly ReturnType<typeof commandInput<NimCommand>>[], table = seats(2)) =>
    engineReplay<NimCommand>({ config: { heap: 9 }, seats: table, seed: testSeed('undo'), inputs });

  it("drops the human's last command and the AI's reply after it", () => {
    const start = replayEngine(nim, nimReplay([]));
    if (!start.ok) throw new Error('replay failed');
    const first = start.value.state.turn;
    const inputs = [
      commandInput<NimCommand>(first, { type: 'take', count: 1 }),
      commandInput<NimCommand>(1 - first, { type: 'take', count: 2 }),
    ];
    const table = seats(2, { ai: [1 - first] });
    const undone = undoByReplay(nim, nimReplay(inputs, table));
    expect(undone.ok && undone.value.dropped).toBe(2);
    expect(undone.ok && undone.value.state).toEqual(start.value.state);
    expect(undone.ok && undone.value.assists).toEqual(['undo']);
    const nothing = undoByReplay(nim, nimReplay([]));
    expect(!nothing.ok && nothing.error.code).toBe('NothingToUndo');
  });

  it('never steps back past a barrier, and keeps the record of a hint', () => {
    const replay = (inputs: readonly HintPuzzleCommand[]) =>
      engineReplay<HintPuzzleCommand>({
        config: { max: 12 },
        seats: seats(1),
        seed: testSeed('hint'),
        inputs: inputs.map((c) => commandInput(0, c)),
      });
    const guess = (n: number): HintPuzzleCommand => ({ type: 'guess', n });
    const blocked = undoByReplay(hintPuzzle, replay([guess(1), { type: 'hint' }]));
    expect(!blocked.ok && blocked.error.code).toBe('UndoBarrier');
    const after = undoByReplay(hintPuzzle, replay([guess(1), { type: 'hint' }, guess(2)]));
    expect(after.ok && after.value.assists).toEqual(['undo', 'hint']);
    if (!after.ok) throw new Error('undo failed');
    const again = undoByReplay(hintPuzzle, after.value.replay);
    expect(!again.ok && again.error.code).toBe('UndoBarrier');
  });
});
