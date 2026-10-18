// The game contract (docs/design-docs/game-contract.md) as plain TypeScript: types and a few
// pure helpers, with zero dependencies, no DOM and no Node.

export { isJson, type Json, type JsonArray, type JsonObject, type JsonPrimitive } from './json.ts';
export { err, gameError, isGameError, ok, type Err, type GameError, type Ok, type Result } from './result.ts';
export type { StandardJSONSchemaV1, StandardSchemaV1, StandardTypedV1 } from './standard-schema.ts';
export type { Validator } from './schema.ts';
export type { Controller, SeatId, SeatInfo } from './seats.ts';
export type { Rng, RngState } from './rng.ts';
export {
  ASSIST_KINDS,
  type AssistCounts,
  type AssistKind,
  type EngineAssist,
  type Outcome,
  type OutcomeResult,
  type Placement,
} from './outcome.ts';
export type { GameVersions } from './versions.ts';
export type {
  AnyGameSession,
  ConnectionState,
  EngineSnapshot,
  GameSession,
  Notice,
  SeatClock,
  SessionMeta,
  SessionSnapshot,
  SimulationSnapshot,
} from './session.ts';
export {
  defineEngine,
  type AnyDiscreteEngine,
  type Beat,
  type DiscreteEngine,
  type EngineAi,
  type EngineInput,
  type EngineSchemas,
  type SeatChange,
  type ShareSummary,
  type Transition,
  type ViewBeat,
} from './engine.ts';
export {
  defineSimulation,
  type AnyFixedStepSimulation,
  type FixedStepSimulation,
  type SimulationSchemas,
  type StepResult,
} from './simulation.ts';
export type { JobOutcome, JobRequest, JobSpec } from './jobs.ts';
export { runMigrations, type Migration, type SaveEnvelope } from './save.ts';
export type { EngineReplay, Replay, SimulationReplay, TickInput } from './replay.ts';
export {
  defineManifest,
  isGameId,
  themeColorFor,
  undoPolicyFor,
  type AiDeclaration,
  type BankClock,
  type BankClockPreset,
  type GameClock,
  type GameManifest,
  type GameTheme,
  type Mode,
  type PlayerCounts,
  type RoomDefaults,
  type SchemeColors,
  type ThemeColor,
  type TurnClock,
  type UndoByMode,
  type UndoPolicy,
  type UndoSetting,
} from './manifest.ts';
export type {
  GameEntry,
  GameModule,
  GameStorage,
  Mounted,
  PlatformApi,
  Preferences,
  Preparer,
  AsyncPreparer,
  AudioApi,
  SoundCue,
  SessionContext,
} from './module.ts';

export { isGameOptions, optionsForMode, setupOptions, type GameOption, type OptionValue } from './options.ts';
