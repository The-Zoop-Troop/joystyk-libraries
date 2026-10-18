import type { AnyDiscreteEngine } from './engine.ts';
import type { Json } from './json.ts';
import type { GameManifest, Mode } from './manifest.ts';
import type { Result } from './result.ts';
import type { Rng, RngState } from './rng.ts';
import type { Migration, SaveEnvelope } from './save.ts';
import type { Validator } from './schema.ts';
import type { SeatId, SeatInfo } from './seats.ts';
import type { AnyGameSession } from './session.ts';
import type { AnyFixedStepSimulation } from './simulation.ts';

/** Player preferences the frame owns. */
export type Preferences = {
  readonly reducedMotion: boolean;
  readonly sound: boolean;
  /** 0 … 1. */
  readonly volume: number;
  readonly colorScheme: 'light' | 'dark';
  readonly locale: string;
  /**
   * Whether shortcuts made of one printable key are on. WCAG 2.1.4 requires a way to turn
   * them off; a game with single-key shortcuts honors it, keeping modified-key ones.
   */
  readonly singleKeyShortcuts: boolean;
};

/** Original, synthesized game effects. They never carry information the view hides. */
export type SoundCue =
  | 'move'
  | 'card'
  | 'clear'
  | 'success'
  | 'error'
  | 'lose'
  | 'level'
  | 'start'
  | 'tick'
  | 'capture'
  | 'hit'
  | 'paddle'
  | 'power'
  | 'stroke'
  | 'rail'
  | 'water'
  | 'cup'
  | 'cascade'
  | 'trace'
  | 'life'
  | 'warning'
  | 'dice';

/** Browser audio owned by the frame; preference, visibility and autoplay aware. */
export interface AudioApi {
  /** A bounded variation changes the pitch, never the rules. Missing audio is harmless. */
  play(cue: SoundCue, variation?: number): void;
}

/** Key-value storage scoped to one game id. Values are JSON. */
export interface GameStorage {
  get(key: string): Promise<Json | null>;
  set(key: string, value: Json): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * What the platform offers a mounted game. Deliberately absent: identity (names come through
 * `SessionMeta.seats`), ads, and network (only through the session). Results and safe points
 * travel in the snapshot, not here.
 */
export interface PlatformApi {
  readonly storage: GameStorage;
  /** Optional for embedders and tests. The launcher supplies this during normal play. */
  readonly audio?: AudioApi;
  /** Current preferences plus changes. */
  readonly preferences: {
    get(): Preferences;
    subscribe(listener: (preferences: Preferences) => void): () => void;
  };
  /** Asks the frame to return to the launcher (e.g. a "Quit" button inside the canvas). */
  requestExit(): void;
  /** Sends a message to the frame's screen-reader live region. */
  announce(message: string, politeness: 'polite' | 'assertive'): void;
}

/** What a game that implements Layer 1 directly receives to build its session. */
export type SessionContext = {
  readonly mode: Mode;
  readonly seats: readonly SeatInfo[];
  /** The viewer's seat; null for a spectator. */
  readonly seat: SeatId | null;
  readonly config: Json;
  /** A fresh seed for a new game. */
  readonly seed: RngState;
  /** The save to resume, or null for a new game. */
  readonly save: SaveEnvelope | null;
};

/** Returned by `mount`. */
export interface Mounted {
  /** Idempotent. Removes elements, listeners, graphics contexts and audio. */
  dispose(): void;
}

/**
 * A game's code, loaded only when someone plays. `Slot` is the element the launcher mounts
 * into; contracts carry no DOM types, so browser code uses `GameModule<HTMLElement>`.
 */
export interface GameModule<Slot = unknown> {
  readonly engine?: AnyDiscreteEngine;
  readonly simulation?: AnyFixedStepSimulation;
  readonly migrations: readonly Migration[];
  /** Pure adapter from validated launcher choices to a complete game config. */
  configFromSetup?(setup: Json, mode: Mode, published?: Json): Result<Json>;
  /** Only for games that implement Layer 1 directly. */
  createSession?(context: SessionContext): AnyGameSession;
  /** Draws the canvas into the slot. The game owns everything inside it and nothing outside. */
  mount(slot: Slot, session: AnyGameSession, platform: PlatformApi): Mounted;
}

/**
 * Builds a game's `Config` before `init`, off the main thread: Sudoku's and Nonogram's
 * puzzle generators. The launcher runs it in a worker; the daily pipeline runs the same code
 * on the server. Its output is the Config that saves and replays record, so replay and undo
 * never run it again. It must be pure, like an engine, and importable without DOM code.
 */
export interface Preparer<Setup extends Json = Json, Config extends Json = Json> {
  /** Validates the player's setup choices (from the setup screen or a URL). */
  readonly setup: Validator<Setup>;
  /** `rng` is seeded separately from the game's own rng. */
  prepare(setup: Setup, rng: Rng): Result<Config>;
}

/** A browser bridge to a pure preparer, usually a short-lived worker. */
export interface AsyncPreparer<Setup extends Json = Json, Config extends Json = Json> {
  readonly setup: Validator<Setup>;
  prepare(setup: Setup, rng: Rng): Promise<Result<Config>>;
  /** Cancels preparation; idempotent. No reply may publish after cancellation. */
  dispose(): void;
}

/**
 * What each game folder's `entry.ts` exports: static data plus lazy loaders, so importing it
 * is cheap anywhere, including in a worker.
 */
export interface GameEntry<Slot = unknown> {
  readonly manifest: GameManifest;
  readonly load: () => Promise<GameModule<Slot>>;
  /** Loads the game's preparer, if it has one. A game without one receives its setup as Config. */
  readonly loadPreparer?: () => Promise<Preparer>;
  /** Optional browser worker bridge. Each load returns a fresh, disposable instance. */
  readonly loadAsyncPreparer?: () => Promise<AsyncPreparer>;
}
