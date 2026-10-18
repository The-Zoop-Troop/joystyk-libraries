import { ok } from '@joystyk/contracts';
// Every check fires on the bug it exists to catch. Each broken fixture has one flaw; the test
// names the checks that must fail and, where the flaw is that narrow, that nothing else does.

import { describe, expect, it } from 'vitest';
import * as broken from './broken.test-util.ts';
import {
  diceRaceConformance,
  drawPlay,
  drawPlayConformance,
  driftConformance,
  hintPuzzleConformance,
  nim,
  nimConformance,
  NIM_SAVE_VERSION,
  nimMigrations,
  nimSaveFixtures,
  type DrawPlayState,
} from './fixtures/index.ts';
import {
  checkById,
  checkEngine,
  checkSimulation,
  failedChecks,
  formatCheck,
  formatReport,
  replayEngine,
  saveFixture,
  type ConformanceReport,
  type EngineReplayResult,
} from './index.ts';

const quick = { games: 4 } as const;

/** Asserts that exactly `ids` failed (or, with `atLeast`, that they are among the failures). */
const expectFailures = (report: ConformanceReport, ids: readonly string[], atLeast = false): void => {
  const failed = failedChecks(report);
  if (atLeast) expect(failed, formatReport(report)).toEqual(expect.arrayContaining([...ids]));
  else expect(failed, formatReport(report)).toEqual([...ids]);
};

describe('no-leak fires', () => {
  it('on a view that keeps hidden card ids', async () => {
    const report = await checkEngine(broken.leakyIds, { ...drawPlayConformance, ...quick });
    expectFailures(report, ['no-leak']);
    expect(formatCheck(checkById(report, 'no-leak'))).toMatch(/viewFor\(state, \d\) changed/);
  });

  it('on a spectator view that shows a hand', async () => {
    const report = await checkEngine(broken.leakySpectator, { ...drawPlayConformance, ...quick });
    expectFailures(report, ['no-leak']);
    expect(formatCheck(checkById(report, 'no-leak'))).toMatch(/viewFor\(state, null\)/);
  });

  it('on an event that tells everyone the drawn card', async () => {
    const report = await checkEngine(broken.leakyEvents, { ...drawPlayConformance, ...quick });
    expectFailures(report, ['no-leak']);
    expect(formatCheck(checkById(report, 'no-leak'))).toMatch(/eventFor/);
  });

  it('on a decision key that reads the deck', async () => {
    const report = await checkEngine(broken.leakyKey, { ...drawPlayConformance, ...quick });
    expectFailures(report, ['no-leak']);
    expect(formatCheck(checkById(report, 'no-leak'))).toMatch(/decisionKey/);
  });

  it('on a perturbation that changes nothing', async () => {
    const report = await checkEngine(drawPlay, {
      ...drawPlayConformance,
      ...quick,
      perturbHidden: (state: DrawPlayState) => state,
    });
    expectFailures(report, ['no-leak']);
    expect(formatCheck(checkById(report, 'no-leak'))).toMatch(/never changed a state/);
  });
});

describe('determinism and purity fire', () => {
  it('on an engine with hidden module state', async () => {
    const report = await checkEngine(broken.nondeterministic, { ...nimConformance, ...quick });
    expectFailures(report, ['determinism'], true);
  });

  it('on an engine that mutates its input', async () => {
    const report = await checkEngine(broken.mutating, { ...nimConformance, ...quick });
    expectFailures(report, ['rejections'], true);
    expect(formatCheck(checkById(report, 'rejections'))).toMatch(/mutated its input/);
  });

  it('on an engine that throws for an illegal move', async () => {
    const report = await checkEngine(broken.throwing, { ...nimConformance, ...quick });
    expectFailures(report, ['rejections']);
    expect(formatCheck(checkById(report, 'rejections'))).toMatch(/threw instead of returning/);
  });

  it('on a rejection without a message', async () => {
    const report = await checkEngine(broken.badRejection, { ...nimConformance, ...quick });
    expectFailures(report, ['rejections']);
  });
});

describe('json and schemas fire', () => {
  it('on undefined in the state', async () => {
    const report = await checkEngine(broken.undefinedInState, { ...nimConformance, ...quick });
    expectFailures(report, ['json'], true);
  });

  it('on -0 in the state', async () => {
    const report = await checkEngine(broken.negativeZero, { ...nimConformance, ...quick });
    expectFailures(report, ['json'], true);
    expect(formatCheck(checkById(report, 'json'))).toMatch(/-0/);
  });

  it('on a state schema that rejects real states', async () => {
    const report = await checkEngine(broken.schemaDisagrees, { ...nimConformance, ...quick });
    expectFailures(report, ['schemas'], true);
  });

  it('on an asynchronous command schema', async () => {
    const asyncCommands = {
      ...nim,
      schemas: {
        ...nim.schemas,
        command: {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: async (value: unknown) => ({ value: value as never }),
          },
        },
      },
    };
    const report = await checkEngine(asyncCommands, { ...nimConformance, ...quick });
    expectFailures(report, ['schemas']);
    expect(formatCheck(checkById(report, 'schemas'))).toMatch(/asynchronously/);
  });
});

describe('turns, resignation and outcomes fire', () => {
  it('allows an explicit untimed side action and rejects one that changes pending decisions', async () => {
    const side = {
      ...nim,
      sideCommand: (s: Parameters<typeof nim.pending>[0], _seat: number, c: { type: 'take'; count: number }) =>
        s.winner === null && c.count === 0,
      apply: ((s, input, rng) =>
        input.kind === 'command' && input.command.count === 0 && s.winner === null
          ? ok({ state: s, beats: [] })
          : nim.apply(s, input, rng)) as typeof nim.apply,
    };
    expect((await checkEngine(side, { ...nimConformance, ...quick })).ok).toBe(true);
    const corrupt = {
      ...side,
      apply: ((s, input, rng) =>
        input.kind === 'command' && input.command.count === 0 && s.winner === null
          ? ok({ state: { ...s, turn: 1 - s.turn }, beats: [] })
          : nim.apply(s, input, rng)) as typeof nim.apply,
    };
    const report = await checkEngine(corrupt, { ...nimConformance, ...quick });
    expectFailures(report, ['turns'], true);
    expect(formatCheck(checkById(report, 'turns'))).toMatch(/side command changed pending decisions/);
  });

  it('on an engine that lets any seat move', async () => {
    const report = await checkEngine(broken.anySeatMoves, { ...nimConformance, ...quick });
    expectFailures(report, ['turns'], true);
  });

  it('on a resignation refused out of turn', async () => {
    const report = await checkEngine(broken.resignOnlyInTurn, { ...nimConformance, ...quick });
    expectFailures(report, ['resign']);
    expect(formatCheck(checkById(report, 'resign'))).toMatch(/out of turn/);
  });

  it('on a resignation that rewrites a finished game', async () => {
    const report = await checkEngine(broken.lateResign, { ...nimConformance, ...quick });
    expectFailures(report, ['outcome']);
    expect(formatCheck(checkById(report, 'outcome'))).toMatch(/resign .* after the outcome/);
  });

  it('on a seat still pending after the outcome', async () => {
    const report = await checkEngine(broken.pendingAfterEnd, { ...nimConformance, ...quick });
    expectFailures(report, ['turns'], true);
  });

  it('on placements that leave a seat out', async () => {
    const report = await checkEngine(broken.partialPlacements, { ...nimConformance, ...quick });
    expectFailures(report, ['outcome']);
  });

  it('on a game that never ends', async () => {
    const report = await checkEngine(broken.endless, { ...nimConformance, ...quick, maxSteps: 40 });
    expectFailures(report, ['outcome'], true);
    expect(formatCheck(checkById(report, 'outcome'))).toMatch(/no outcome after 40 inputs/);
  });

  it('on a game where nobody can move', async () => {
    const report = await checkEngine(broken.stuck, { ...nimConformance, ...quick });
    expectFailures(report, ['outcome'], true);
    expect(formatCheck(checkById(report, 'outcome'))).toMatch(/nobody can move/);
  });

  it('on an AI that chooses illegal moves', async () => {
    const report = await checkEngine(broken.greedyAi, { ...nimConformance, ...quick });
    expectFailures(report, ['ai']);
  });

  it('on a decision key that never changes', async () => {
    const report = await checkEngine(broken.frozenKey, { ...nimConformance, ...quick });
    expectFailures(report, ['stale']);
    expect(formatCheck(checkById(report, 'stale'))).toMatch(/stale command/);
  });
});

describe('invariants fire', () => {
  it('on an engine that loses cards', async () => {
    const report = await checkEngine(broken.losesCards, { ...drawPlayConformance, ...quick });
    // The 'played' event now shows a card that no view ever shows, so no-leak fires too.
    expectFailures(report, ['invariants'], true);
    expect(formatCheck(checkById(report, 'invariants'))).toMatch(/cards in play/);
  });
});

describe('undo and assistance fire', () => {
  it('on a hint that is no undo barrier', async () => {
    const report = await checkEngine(broken.noBarrier, hintPuzzleConformance);
    expectFailures(report, ['undo']);
    expect(formatCheck(checkById(report, 'undo'))).toMatch(/undo barrier/);
  });

  it('undo by replay itself never steps past the barrier the engine reports', async () => {
    const withoutOracle = { ...hintPuzzleConformance, undoBarrier: undefined };
    expect((await checkEngine(broken.noBarrier, withoutOracle)).ok).toBe(true);
  });

  it('on a hint reported as another kind of assistance', async () => {
    const report = await checkEngine(broken.wrongAssist, hintPuzzleConformance);
    expectFailures(report, ['assist']);
  });

  it('on an engine that reports undo as its own assistance', async () => {
    const report = await checkEngine(broken.assistsUndo, { ...hintPuzzleConformance, assist: undefined });
    expectFailures(report, ['assist']);
    expect(formatCheck(checkById(report, 'assist'))).toMatch(/undo is the platform's own/);
  });
});

describe('session hooks fire', () => {
  it('on startsClock set more than once in a game', async () => {
    const report = await checkEngine(broken.clockEveryGuess, hintPuzzleConformance);
    expectFailures(report, ['session-hooks']);
    expect(formatCheck(checkById(report, 'session-hooks'))).toMatch(/at most once a game/);
  });

  it('on startsClock from an engine that does not declare clockStart', async () => {
    const report = await checkEngine(broken.undeclaredClockStart, hintPuzzleConformance);
    expectFailures(report, ['session-hooks']);
    expect(formatCheck(checkById(report, 'session-hooks'))).toMatch(/doesn't declare clockStart/);
  });

  it('on a worthSaving that reads hidden module state', async () => {
    const report = await checkEngine(broken.impureWorthSaving, hintPuzzleConformance);
    expectFailures(report, ['session-hooks']);
    expect(formatCheck(checkById(report, 'session-hooks'))).toMatch(/must be pure/);
  });

  it('on a worthSaving that mutates its state', async () => {
    const report = await checkEngine(broken.mutatingWorthSaving, hintPuzzleConformance);
    expectFailures(report, ['session-hooks']);
    expect(formatCheck(checkById(report, 'session-hooks'))).toMatch(/mutated its state/);
  });

  it('is skipped for an engine with neither hook', async () => {
    const report = await checkEngine(nim, { ...nimConformance, ...quick });
    expect(checkById(report, 'session-hooks').status).toBe('skipped');
  });
});

describe('jobs fire', () => {
  it('on an engine that accepts outcomes for any job id', async () => {
    const report = await checkEngine(broken.anyJobId, diceRaceConformance);
    expectFailures(report, ['jobs']);
  });

  it('on an engine that refuses failed jobs', async () => {
    const report = await checkEngine(broken.refusesFailures, diceRaceConformance);
    expectFailures(report, ['jobs'], true);
    expect(formatCheck(checkById(report, 'jobs'))).toMatch(/must accept both/);
  });

  it('on an engine that reuses a job id', async () => {
    const report = await checkEngine(broken.reusedJobId, diceRaceConformance);
    expectFailures(report, ['jobs'], true);
    expect(formatCheck(checkById(report, 'jobs'))).toMatch(/requested twice/);
  });

  it('on a job kind without a fake runner', async () => {
    const report = await checkEngine(broken.anyJobId, { ...diceRaceConformance, jobs: {} });
    expect(formatCheck(checkById(report, 'jobs'))).toMatch(/no fake runner/);
  });
});

describe('saves fire', () => {
  it('on a missing fixture for a shipped version', async () => {
    const report = await checkEngine(nim, {
      ...nimConformance,
      ...quick,
      saves: {
        version: NIM_SAVE_VERSION,
        migrations: nimMigrations,
        fixtures: nimSaveFixtures.filter((f) => f.saveVersion !== 1),
      },
    });
    expectFailures(report, ['saves']);
    expect(formatCheck(checkById(report, 'saves'))).toMatch(/no save fixture for save version 1/);
  });

  it('on a fixture that no longer migrates', async () => {
    const report = await checkEngine(nim, {
      ...nimConformance,
      ...quick,
      saves: { version: NIM_SAVE_VERSION, migrations: [], fixtures: nimSaveFixtures },
    });
    expectFailures(report, ['saves']);
    expect(formatCheck(checkById(report, 'saves'))).toMatch(/MigrationMissing/);
  });

  it('on a fixture that migrates to an invalid state', async () => {
    const report = await checkEngine(nim, {
      ...nimConformance,
      ...quick,
      saves: {
        version: NIM_SAVE_VERSION,
        migrations: nimMigrations,
        fixtures: [...nimSaveFixtures, saveFixture('damaged', 1, { heap: -1, turn: 0, winner: null })],
      },
    });
    expectFailures(report, ['saves']);
    expect(formatCheck(checkById(report, 'saves'))).toMatch(/"damaged"/);
  });
});

describe('simulation checks fire', () => {
  it('determinism and purity on a step with hidden module state', async () => {
    const report = await checkSimulation(broken.driftNondeterministic, driftConformance);
    expectFailures(report, ['purity'], true);
  });

  it('purity on a step that mutates its input', async () => {
    const report = await checkSimulation(broken.driftMutating, driftConformance);
    expectFailures(report, ['purity']);
    expect(formatCheck(checkById(report, 'purity'))).toMatch(/mutated its input/);
  });

  it('json on -0 in the state', async () => {
    const report = await checkSimulation(broken.driftNegativeZero, driftConformance);
    expectFailures(report, ['json'], true);
  });

  it('checkpoint on a lossy state schema', async () => {
    const report = await checkSimulation(broken.driftLossySchema, driftConformance);
    expectFailures(report, ['checkpoint']);
  });

  it('invariants on a puck that leaves the track', async () => {
    const report = await checkSimulation(broken.driftEscapes, driftConformance);
    expectFailures(report, ['invariants']);
  });

  it('outcome when a required outcome never comes', async () => {
    const report = await checkSimulation(broken.driftSlow, { ...driftConformance, ticks: 50, runs: 1 });
    expectFailures(report, ['outcome']);
  });

  it('budget on a slow step', async () => {
    const report = await checkSimulation(broken.driftSlow, {
      ...driftConformance,
      ticks: 50,
      runs: 1,
      requireOutcome: false,
      stepBudgetMs: 1e-6,
    });
    expectFailures(report, ['budget']);
  });
});

describe('failures are reproducible', () => {
  it('a failure carries its seed, the game to rerun and a replay that applies', async () => {
    const report = await checkEngine(broken.leakyIds, { ...drawPlayConformance, ...quick });
    const failure = checkById(report, 'no-leak').failures[0];
    expect(failure?.seed).toMatch(/^conformance\/\d+\/\d+$/);
    expect(failure?.replay?.layer).toBe(2);
    const text = formatCheck(checkById(report, 'no-leak'));
    expect(text).toContain(`only: { setup: ${failure?.setup}, game: ${failure?.game} }`);
    expect(text).toContain('replay: {"layer":2');
    if (failure?.replay?.layer !== 2) throw new Error('expected a Layer 2 replay');
    const replayed = replayEngine(
      broken.leakyIds,
      failure.replay as Parameters<typeof replayEngine<DrawPlayState, never, never, never, never>>[1],
    );
    expect(replayed.ok).toBe(true);
    expect((replayed as { value: EngineReplayResult<DrawPlayState> }).value.inputs.length).toBe(failure.step);
  });

  it('`only` reruns exactly the reported game, with the same failure', async () => {
    const report = await checkEngine(broken.leakyIds, { ...drawPlayConformance, ...quick });
    const failure = checkById(report, 'no-leak').failures[0];
    const only = { setup: failure?.setup ?? 0, game: failure?.game ?? 0 };
    const again = await checkEngine(broken.leakyIds, { ...drawPlayConformance, ...quick, only });
    expect(again.games).toBe(1);
    expect(checkById(again, 'no-leak').failures[0]).toEqual(failure);
  });
});
