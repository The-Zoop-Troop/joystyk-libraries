// `@joystyk/testing`: dev-time helpers that games and platform packages use from their own
// test files. The conformance suites check the game contract (game-contract.md,
// "Conformance tests"); the rest are fakes and builders for writing tests quickly.
//
// Small, correct example games for platform tests live in `@joystyk/testing/fixtures`.

export {
  checkEngine,
  ENGINE_CHECKS,
  type EngineCheckId,
  type EngineConformanceOptions,
  type EngineSetup,
  type HiddenTransition,
  type InvariantResult,
  type SaveOptions,
} from './engine-conformance.ts';
export {
  checkSimulation,
  SIMULATION_CHECKS,
  type SimulationCheckId,
  type SimulationConformanceOptions,
} from './simulation-conformance.ts';
export {
  ConformanceError,
  expectConformance,
  runEngineConformance,
  runSimulationConformance,
  type VitestOptions,
} from './vitest.ts';
export {
  checkById,
  failedChecks,
  formatCheck,
  formatFailure,
  formatReport,
  type CheckResult,
  type CheckStatus,
  type ConformanceReport,
  type Failure,
} from './report.ts';
export {
  replayEngine,
  replaySimulation,
  undoByReplay,
  type EngineReplayResult,
  type ReplayedInput,
  type SimulationReplayResult,
  type UndoResult,
} from './replay.ts';
export { cloneRng, testRng, testSeed, testSeeds } from './rng.ts';
export { createFakeClock, type FakeClock, type TimerHandle } from './clock.ts';
export {
  manualFrames,
  nextTask,
  pause,
  WAIT_BUDGET_MS,
  waitUntil,
  type FrameWaitOptions,
  type ManualFrames,
  type WaitOptions,
} from './waiting.ts';
export { createFakeStorage, type FakeStorage, type StorageCall, type StorageOperation } from './storage.ts';
export { createMemorySaveStore, runnerClock, type MemorySaveStore } from './session-ports.ts';
export {
  anySchema,
  commandInput,
  engineReplay,
  guardSchema,
  isEngineReplay,
  jobFailure,
  jobResult,
  resignInput,
  saveEnvelope,
  saveFixture,
  seatInput,
  seats,
  simulationReplay,
  timeoutInput,
  type SaveFixture,
} from './builders.ts';
export { formatIssues, validate, type Validation } from './schema.ts';
export { deepEqual, deepFreeze, firstDifference, jsonRoundTrip } from './deep.ts';
