// The correct fixtures pass every check that applies to them: first through the vitest
// wrappers, as a game's own test file would use them, then through the reports, to prove
// each check actually ran on the fixture built to exercise it.

import { describe, expect, it } from 'vitest';
import {
  diceRace,
  diceRaceConformance,
  drawPlay,
  drawPlayConformance,
  drift,
  driftConformance,
  hintPuzzle,
  hintPuzzleConformance,
  nim,
  nimConformance,
  sealedBids,
  sealedBidsConformance,
} from './fixtures/index.ts';
import {
  checkById,
  checkEngine,
  checkSimulation,
  formatReport,
  runEngineConformance,
  runSimulationConformance,
  type ConformanceReport,
} from './index.ts';

runEngineConformance(nim, nimConformance);
runEngineConformance(drawPlay, drawPlayConformance);
runEngineConformance(sealedBids, sealedBidsConformance);
runEngineConformance(diceRace, diceRaceConformance);
runEngineConformance(hintPuzzle, hintPuzzleConformance);
runSimulationConformance(drift, driftConformance);

const ran = (report: ConformanceReport, ids: readonly string[]): void => {
  expect(report.ok, formatReport(report)).toBe(true);
  for (const id of ids) {
    const check = checkById(report, id);
    expect(check.status, `${id}: ${check.note ?? ''}`).toBe('passed');
    expect(check.runs).toBeGreaterThan(0);
  }
};

describe('each fixture exercises the checks it was built for', () => {
  it('Nim: public state, AI, saves, invariants', async () => {
    const report = await checkEngine(nim, nimConformance);
    ran(report, [
      'determinism',
      'replay',
      'json',
      'schemas',
      'rejections',
      'turns',
      'resign',
      'invariants',
      'ai',
      'saves',
      'jobs',
      'undo',
      'outcome',
    ]);
    expect(checkById(report, 'no-leak').status).toBe('skipped');
  });

  it('Draw and Play: hidden hands', async () => {
    const report = await checkEngine(drawPlay, drawPlayConformance);
    ran(report, ['no-leak', 'invariants', 'ai', 'turns', 'resign']);
  });

  it('Sealed Bids: simultaneous moves keep each other fresh', async () => {
    const report = await checkEngine(sealedBids, sealedBidsConformance);
    ran(report, ['no-leak', 'stale', 'turns', 'invariants']);
  });

  it('Dice Race: jobs', async () => {
    const report = await checkEngine(diceRace, diceRaceConformance);
    ran(report, ['jobs', 'determinism', 'replay', 'outcome']);
  });

  it('Hint Puzzle: undo barriers and a hidden solution', async () => {
    const report = await checkEngine(hintPuzzle, hintPuzzleConformance);
    ran(report, ['undo', 'no-leak', 'invariants']);
  });

  it('Drift: a simulation', async () => {
    const report = await checkSimulation(drift, driftConformance);
    ran(report, ['determinism', 'replay', 'checkpoint', 'json', 'schemas', 'purity', 'invariants', 'outcome']);
  });
});
