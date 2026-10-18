import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  anything,
  counterRng,
  nim,
  type NimCommand,
  type NimConfig,
  type NimEvent,
  type NimState,
  type NimView,
} from './fixtures.test-util.ts';
import {
  ASSIST_KINDS,
  defineEngine,
  defineSimulation,
  isJson,
  ok,
  type AnyDiscreteEngine,
  type AnyFixedStepSimulation,
  type AnyGameSession,
  type AssistKind,
  type DiscreteEngine,
  type EngineInput,
  type EngineReplay,
  type EngineSnapshot,
  type GameError,
  type GameModule,
  type GameSession,
  type JobOutcome,
  type Json,
  type Outcome,
  type Preparer,
  type Replay,
  type SaveEnvelope,
  type SeatInfo,
  type SessionMeta,
  type SimulationSnapshot,
  type StandardSchemaV1,
  type Transition,
  type Validator,
} from './index.ts';

const seats: readonly SeatInfo[] = [
  { id: 0, name: 'Ana', controller: 'human' },
  { id: 1, name: 'Bot', controller: 'ai', aiLevel: 'easy' },
];

const start = (): NimState => {
  const result = nim.init({ heap: 5 }, seats, counterRng());
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe('the fixture engine runs through the contract', () => {
  it('applies commands and reports the outcome', () => {
    let state = start();
    const rng = counterRng();
    const take = (count: number): EngineInput<NimCommand> => ({
      kind: 'command',
      seat: state.turn,
      command: { type: 'take', count },
    });
    for (const count of [3, 2]) {
      const result = nim.apply(state, take(count), rng);
      if (!result.ok) throw new Error(result.error.message);
      expect(isJson(result.value)).toBe(true);
      state = result.value.state;
    }
    expect(state.heap).toBe(0);
    expect(nim.pending(state)).toEqual([]);
    expect(nim.outcome(state)?.result).toBe('won');
  });

  it('rejects a command from a seat that is not pending', () => {
    const state = start();
    const other = 1 - state.turn;
    const result = nim.apply(
      state,
      { kind: 'command', seat: other, command: { type: 'take', count: 1 } },
      counterRng(),
    );
    expect(!result.ok && result.error.code).toBe('NotYourTurn');
  });

  it('accepts a resignation from the seat that is not on turn', () => {
    const state = start();
    const other = 1 - state.turn;
    const result = nim.apply(state, { kind: 'resign', seat: other }, counterRng());
    expect(result.ok && nim.outcome(result.value.state)?.placements[0]?.seat).toBe(state.turn);
  });
});

describe('engine type constraints', () => {
  it('infers the five type parameters through defineEngine', () => {
    expectTypeOf(nim).toEqualTypeOf<DiscreteEngine<NimState, NimCommand, NimView, NimEvent, NimConfig>>();
    expectTypeOf(nim.apply).returns.toEqualTypeOf<
      | { readonly ok: true; readonly value: Transition<NimState, NimEvent> }
      | { readonly ok: false; readonly error: GameError }
    >();
  });

  it('requires viewFor to return the View type', () => {
    defineEngine<NimState, NimCommand, NimView, NimEvent, NimConfig>({
      ...nim,
      // @ts-expect-error viewFor must return a NimView
      viewFor: () => ({ heap: 'five' }),
    });
  });

  it('requires engine state to be JSON', () => {
    type Engine<S extends Json> = DiscreteEngine<S, Json, Json, Json, Json>;
    interface InterfaceState {
      heap: number;
    }
    type Ok = Engine<{ heap: number; note?: string; cells: number[] }>;
    // @ts-expect-error a Date is not JSON
    type WithDate = Engine<{ at: Date }>;
    // @ts-expect-error a Map is not JSON
    type WithMap = Engine<{ seen: Map<string, number> }>;
    // @ts-expect-error a function is not JSON
    type WithFunction = Engine<{ next: () => void }>;
    // @ts-expect-error a property typed as possibly undefined is not JSON (omit the key instead)
    type WithUndefined = Engine<{ winner: number | undefined }>;
    // @ts-expect-error interfaces have no index signature; declare state with `type`
    type WithInterface = Engine<InterfaceState>;
    expectTypeOf<Ok>().not.toBeNever();
    void (0 as unknown as [WithDate, WithMap, WithFunction, WithUndefined, WithInterface]);
  });

  it('requires commands, views, events and config to be JSON too', () => {
    // @ts-expect-error command
    type C = DiscreteEngine<Json, { at: Date }, Json, Json, Json>;
    // @ts-expect-error view
    type V = DiscreteEngine<Json, Json, { draw: () => void }, Json, Json>;
    // @ts-expect-error event
    type E = DiscreteEngine<Json, Json, Json, { at: Date }, Json>;
    // @ts-expect-error config
    type G = DiscreteEngine<Json, Json, Json, Json, { tiles: Set<number> }>;
    void (0 as unknown as [C, V, E, G]);
  });

  it('lets any concrete engine stand in for AnyDiscreteEngine', () => {
    expectTypeOf(nim).toExtend<AnyDiscreteEngine>();
  });

  it('types the room hooks and undo barriers', () => {
    const withHooks = defineEngine({
      ...nim,
      decisionKey: (state: NimState, seat) => ({ heap: state.heap, mine: state.turn === seat }),
      decisionMs: (_state: NimState, _seat, configured) => configured,
      holdMs: (transition: Transition<NimState, NimEvent>) => transition.beats.length * 300,
    });
    expectTypeOf(withHooks.decisionMs).parameter(2).toEqualTypeOf<number | null>();
    expectTypeOf<Transition<NimState, NimEvent>['undoBarrier']>().toEqualTypeOf<boolean | undefined>();
  });

  it('lets an engine name the config of a rematch, typed by its own config and state', () => {
    type Engine = DiscreteEngine<NimState, NimCommand, NimView, NimEvent, NimConfig>;
    expectTypeOf<NonNullable<Engine['rematch']>>().toEqualTypeOf<
      (config: NimConfig, finished: NimState) => NimConfig
    >();
    expect(nim.rematch).toBeUndefined();
  });

  it("lets a transition flag assistance, but never undo, which is the platform's", () => {
    expectTypeOf<Transition<NimState, NimEvent>['assist']>().toEqualTypeOf<
      'hint' | 'check' | 'reveal' | 'shuffle' | undefined
    >();
    const hint: Transition<NimState, NimEvent> = {
      state: { heap: 1, turn: 0, winner: null },
      beats: [],
      assist: 'hint',
      undoBarrier: true,
    };
    expect(isJson(hint)).toBe(true);
    const undo: Transition<NimState, NimEvent> = {
      state: { heap: 1, turn: 0, winner: null },
      beats: [],
      // @ts-expect-error engines never report undo
      assist: 'undo',
    };
    void undo;
  });
});

describe('platform inputs', () => {
  it('include resignation, timeouts, seat changes and jobs', () => {
    expectTypeOf<EngineInput<Json>['kind']>().toEqualTypeOf<'command' | 'seat' | 'timeout' | 'resign' | 'job'>();
    const resign: EngineInput<NimCommand> = { kind: 'resign', seat: 1 };
    const job: EngineInput<NimCommand> = { kind: 'job', jobId: 'r3-0', outcome: { ok: false, reason: 'timeout' } };
    expect(isJson([resign, job])).toBe(true);
  });
});

describe('boundary types use Standard Schema', () => {
  it('accepts schemas whose input type differs from their output', () => {
    const withDefaults: StandardSchemaV1<{ heap?: number }, NimConfig> = {
      '~standard': { version: 1, vendor: 'test', validate: () => ({ value: { heap: 5 } }) },
    };
    expectTypeOf(withDefaults).toExtend<Validator<NimConfig>>();
    expectTypeOf(anything<NimConfig>()).toExtend<Validator<NimConfig>>();
    // @ts-expect-error the output type must match
    const wrong: Validator<NimConfig> = anything<{ size: number }>();
    void wrong;
  });
});

describe('data that crosses boundaries is JSON', () => {
  it('declares every data shape as JSON-compatible', () => {
    expectTypeOf<SeatInfo>().toExtend<Json>();
    expectTypeOf<Outcome>().toExtend<Json>();
    expectTypeOf<GameError>().toExtend<Json>();
    expectTypeOf<SessionMeta>().toExtend<Json>();
    expectTypeOf<EngineInput<Json>>().toExtend<Json>();
    expectTypeOf<JobOutcome>().toExtend<Json>();
    expectTypeOf<Transition<Json, Json>>().toExtend<Json>();
    expectTypeOf<EngineSnapshot<Json, Json>>().toExtend<Json>();
    expectTypeOf<SimulationSnapshot<Json>>().toExtend<Json>();
    expectTypeOf<Replay>().toExtend<Json>();
    expectTypeOf<SaveEnvelope>().toExtend<Json>();
  });

  it("carries the platform's records of AI randomness, undo and assistance as JSON", () => {
    const save: SaveEnvelope = {
      gameId: 'nim',
      build: '1.0.0',
      rulesVersion: 1,
      saveVersion: 1,
      rng: counterRng().save(),
      aiRng: counterRng(7).save(),
      seats,
      state: { heap: 5, turn: 0, winner: null },
      undosUsed: 2,
      assists: ['undo', 'hint'],
    };
    const outcome: Outcome = {
      result: 'won',
      placements: [{ seat: 0, place: 1 }],
      summary: 'Won.',
      undosUsed: 2,
      assists: ['undo'],
    };
    const meta: SessionMeta = {
      connection: 'online',
      seat: 0,
      revision: 3,
      seats,
      outcome,
      safePoint: true,
      notice: null,
      clocks: [
        { seat: 0, remainingMs: 290_000, running: true },
        { seat: 1, remainingMs: 301_500, running: false },
      ],
    };
    expect(isJson([save, outcome, meta])).toBe(true);
    expect(ASSIST_KINDS).toEqual(['undo', 'hint', 'check', 'reveal', 'shuffle']);
    expectTypeOf<(typeof ASSIST_KINDS)[number]>().toEqualTypeOf<AssistKind>();
  });

  it('records a replay as JSON', () => {
    const replay: EngineReplay<NimCommand, NimConfig> = {
      layer: 2,
      gameId: 'nim',
      rulesVersion: 1,
      config: { heap: 5 },
      seats,
      seed: counterRng().save(),
      inputs: [
        { kind: 'command', seat: 0, command: { type: 'take', count: 2 } },
        { kind: 'resign', seat: 1 },
      ],
    };
    expectTypeOf(replay).toExtend<Replay>();
    expect(isJson(replay)).toBe(true);
  });
});

describe('simulations', () => {
  type Ball = { readonly x: number; readonly v: number };
  const ball = defineSimulation({
    rulesVersion: 1,
    stepHz: 60,
    schemas: {
      config: anything<{ v: number }>(),
      input: anything<{ push: number }>(),
      state: anything<Ball>(),
      event: anything<{ bounce: true }>(),
    },
    init: (config: { v: number }) => ok({ x: 0, v: config.v }),
    step: (state: Ball, inputs: readonly { push: number }[]) => {
      const v = inputs.reduce((sum, input) => sum + input.push, state.v);
      const x = state.x + v;
      return x > 10 ? { state: { x: 10, v: -v }, events: [{ bounce: true as const }] } : { state: { x, v } };
    },
    // The view need not be JSON.
    view: (state: Ball) => ({ draw: () => state.x }),
    outcome: () => null,
  });

  it('steps deterministically', () => {
    const init = ball.init({ v: 4 }, counterRng());
    if (!init.ok) throw new Error('init failed');
    const one = ball.step(init.value, [{ push: 1 }], counterRng());
    const two = ball.step(one.state, [], counterRng());
    expect(two).toEqual({ state: { x: 10, v: 5 } });
    const three = ball.step(two.state, [], counterRng());
    expect(three).toEqual({ state: { x: 10, v: -5 }, events: [{ bounce: true }] });
  });

  it('lets any concrete simulation stand in for AnyFixedStepSimulation', () => {
    expectTypeOf(ball).toExtend<AnyFixedStepSimulation>();
  });
});

describe('modules and sessions', () => {
  it('lets a game type its own session and slot', () => {
    type Slot = { readonly append: (node: unknown) => void };
    type NimSnapshot = EngineSnapshot<NimView, NimEvent>;
    const mount = (_slot: Slot, session: GameSession<NimSnapshot, NimCommand>) => {
      const stop = session.subscribe(() => undefined);
      return { dispose: stop };
    };
    const module = { engine: nim, migrations: [], mount } satisfies GameModule<Slot>;
    expectTypeOf(module).toExtend<GameModule<Slot>>();
    expectTypeOf<GameSession<NimSnapshot, NimCommand>>().toExtend<AnyGameSession>();
  });

  it('types a preparer that builds Config from setup choices', () => {
    type Setup = { readonly difficulty: 'easy' | 'hard' };
    const preparer: Preparer<Setup, NimConfig> = {
      setup: anything<Setup>(),
      prepare: (setup, rng) => ok({ heap: setup.difficulty === 'easy' ? 5 : rng.int(15, 21) }),
    };
    expectTypeOf(preparer).toExtend<Preparer>();
    expect(preparer.prepare({ difficulty: 'easy' }, counterRng())).toEqual(ok({ heap: 5 }));
  });
});
