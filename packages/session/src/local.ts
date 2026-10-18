// The local runner: plays a Layer 2 engine in the browser, as the game's single authority
// (core belief 10). It validates every input, drives AI seats, runs jobs, measures play
// time, implements undo by replay, saves after every accepted change, and publishes
// snapshots by the Layer 1 rules. See README.md for the design.
import {
  ASSIST_KINDS,
  err,
  gameError,
  isJson,
  ok,
  undoPolicyFor,
  type AssistKind,
  type AssistCounts,
  type Beat,
  type DiscreteEngine,
  type EngineAi,
  type EngineInput,
  type EngineReplay,
  type EngineSnapshot,
  type GameError,
  type GameSession,
  type JobOutcome,
  type JobRequest,
  type JobSpec,
  type Json,
  type Migration,
  type Notice,
  type Result,
  type Rng,
  type RngState,
  type SaveEnvelope,
  type SeatChange,
  type SeatId,
  type SeatInfo,
  type SessionMeta,
  type ViewBeat,
} from '@joystyk/contracts';
import {
  alwaysVisible,
  type AiRunner,
  type Clock,
  type JobRunner,
  type Reporter,
  type RngFactory,
  type SaveStore,
  type Visibility,
} from './ports.ts';
import { createPublisher } from './publisher.ts';
import { applySeatChange, parseEngineInput, rebuild, recordOf, safeApply, type InputRecord } from './replay.ts';
import { advanceAi, aiDecisionSeed, aiRestore, defaultRestoreRng, deriveAiSeed } from './rngs.ts';
import { isSeatInfo, loadSave, type RunnerManifest } from './saves.ts';
import { createStopwatch } from './stopwatch.ts';
import { compact, decode, isRecord, jsonClone, jsonEqual } from './values.ts';

/** The local modes. Rooms (P2P and server) have their own session clients. */
export type LocalMode = 'solo' | 'ai' | 'pass-and-play' | 'daily';

/**
 * What the game's UI dispatches. A command comes from the viewer's seat unless it names one:
 * in pass-and-play without a hand-off screen it may name any pending human seat, so two
 * people at one device can make simultaneous moves in either order (gp-o2c); elsewhere a
 * named seat must be the viewer's. The platform inputs (`resign`, `seat`) may name another
 * human seat. `reveal` acknowledges the pass-and-play hand-off screen (D-31).
 */
export type LocalInput<Command> =
  | { readonly kind: 'command'; readonly command: Command; readonly seat?: SeatId }
  | { readonly kind: 'resign'; readonly seat?: SeatId }
  | { readonly kind: 'seat'; readonly seat: SeatId; readonly change: SeatChange }
  | { readonly kind: 'undo' }
  | { readonly kind: 'reveal' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' };

/** Session metadata plus the undo count and assistance, which results screens show (D-32). */
export type LocalMeta = SessionMeta & {
  /** Undos used in this game. The engine never sees undo, so only the runner can count it. */
  readonly undosUsed: number;
  /** The kinds of assistance used so far, in `ASSIST_KINDS` order. */
  readonly assists: readonly AssistKind[];
  readonly assistCounts: AssistCounts;
};

/** Why undo is unavailable right now, as a notice code. */
export type UndoBlock =
  'UndoNotAllowed' | 'HistoryUnavailable' | 'GameOver' | 'UndoLimit' | 'NothingToUndo' | 'UndoBarrier' | 'Paused';

/** The local runner's snapshot: the contract's `EngineSnapshot` and what local play adds. */
export type LocalSnapshot<View, Event> = EngineSnapshot<View, Event> & {
  readonly meta: LocalMeta;
  readonly mode: LocalMode;
  /**
   * Pass-and-play only, for games whose manifest sets `handoff` (D-31): the seat the device
   * must pass to. While it is set, `meta.seat` is null and `view` is the spectator view, so
   * nothing private shows; `reveal` ends it. Once the game is over it stays null, and so does
   * `meta.seat`: the final board is the spectator's view.
   */
  readonly handoff: { readonly seat: SeatId; readonly name: string } | null;
  readonly undo: {
    readonly available: boolean;
    readonly remaining: number | null;
    readonly blockedBy: UndoBlock | null;
  };
  /** AI seats choosing a move right now. */
  readonly thinking: readonly SeatId[];
  readonly paused: boolean;
  /** Active play time when this snapshot was published. For a live stopwatch, call `elapsedMs()`. */
  readonly elapsedMs: number;
};

/** A local session: the contract's `GameSession` plus what the launcher needs for saves. */
export interface LocalSession<Command, View, Event> extends GameSession<
  LocalSnapshot<View, Event>,
  LocalInput<Command>
> {
  /** Active play time right now. */
  elapsedMs(): number;
  /** The save envelope for the current position. */
  save(): SaveEnvelope;
  /** The replay log so far, or null when the history was lost (a save without a replay). */
  replay(): EngineReplay | null;
}

/** Ports and settings shared by new and restored sessions. */
export type LocalPorts<View> = {
  readonly manifest: RunnerManifest;
  readonly mode: LocalMode;
  /** Restores the game's random state. Default: the kit's `restoreRng`. */
  readonly restoreRng?: RngFactory;
  readonly clock: Clock;
  /**
   * The viewer in solo, vs-AI and daily play; default: the first human seat. Null watches
   * (every seat AI). Pass-and-play ignores it: the viewer follows the seat to act.
   */
  readonly seat?: SeatId | null;
  /**
   * Seed for the AI's own random source, kept apart from the game's so an AI can't predict
   * shuffles. Pass a fresh one; the default forks one from the game's random state. A
   * restored game continues the stream its save recorded (`aiRng`) and ignores this.
   */
  readonly aiSeed?: RngState;
  /** How long the default AI runner waits before choosing, so players can follow. Default 500. */
  readonly aiDelayMs?: number;
  /**
   * Chooses AI moves. Default: the engine's `ai.choose`, inline. Pass `workerAiRunner` when
   * the manifest declares heavy AI; without one, the runner reports it and runs inline.
   */
  readonly ai?: AiRunner<View>;
  readonly visibility?: Visibility;
  readonly storage?: SaveStore;
  readonly jobs?: JobRunner;
  /** Deep-freeze snapshots. Default true; production builds may pass false. */
  readonly freeze?: boolean;
  readonly report?: Reporter;
};

export type LocalSessionOptions<View> = LocalPorts<View> & {
  readonly seats: readonly SeatInfo[];
  /** Decoded with the engine's config schema. */
  readonly config: unknown;
  readonly seed: RngState;
};

export type RestoreOptions<View> = LocalPorts<View> & {
  readonly migrations: readonly Migration[];
};

type History<Command, Config> = {
  readonly config: Config;
  readonly seats: readonly SeatInfo[];
  readonly seed: RngState;
  records: InputRecord<Command>[];
};

type Start<State, Command, Config> = {
  readonly state: State;
  readonly rng: Rng;
  readonly seats: readonly SeatInfo[];
  readonly history: History<Command, Config> | null;
  readonly elapsedMs: number;
  /** Whether the play clock has started. */
  readonly started: boolean;
  readonly undosUsed: number;
  readonly assists: readonly AssistKind[];
  readonly assistCounts: AssistCounts;
  /** The AI stream's saved state, or null to start one. */
  readonly aiRng: RngState | null;
};

const notice = (code: string, message: string): Notice => ({ code, message });

const UNDO_MESSAGES: { readonly [K in UndoBlock]: string } = {
  UndoNotAllowed: "This game doesn't allow undo here.",
  HistoryUnavailable: 'Undo is unavailable for this saved game.',
  GameOver: 'The game is over.',
  UndoLimit: 'No undos left.',
  NothingToUndo: 'There is nothing to undo.',
  UndoBarrier: "That move can't be undone.",
  Paused: 'The game is paused.',
};

/**
 * The default AI runner: the engine's own `ai.choose`, after a delay on the clock, drawing
 * from the task's stream. `restore` rebuilds it; default: the kit's `restoreRng`.
 */
export const inlineAi = <View, Command>(
  ai: EngineAi<View, Command>,
  clock: Clock,
  delayMs: number,
  restore: RngFactory = defaultRestoreRng,
): AiRunner<View> => ({
  choose: (task) => {
    let cancel = (): void => {};
    const result = new Promise<unknown>((resolve, reject) => {
      cancel = clock.after(delayMs, () => {
        try {
          resolve(ai.choose(task.view, task.seat, task.level, restore(task.rng)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    return { result, cancel: () => cancel() };
  },
});

/** The kinds in `ASSIST_KINDS` order, each once. */
const assistList = (used: ReadonlySet<AssistKind>): readonly AssistKind[] =>
  ASSIST_KINDS.filter((kind) => used.has(kind));

const checkSeats = (seats: readonly SeatInfo[], levels: readonly string[] | null): GameError | null => {
  if (seats.length === 0 || !seats.every((seat, i) => isSeatInfo(seat) && seat.id === i)) {
    return gameError('InvalidSeats', 'The seats must be numbered 0, 1, 2 and so on.');
  }
  const unknown = seats.find((seat) => seat.aiLevel !== undefined && levels !== null && !levels.includes(seat.aiLevel));
  return unknown === undefined
    ? null
    : gameError('InvalidSeats', 'An AI seat names a level the game lacks.', { seat: unknown.id });
};

/** Starts a new local game. Fails when the seats or config are invalid or `init` refuses them. */
export const createLocalSession = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  options: LocalSessionOptions<View>,
): Result<LocalSession<Command, View, Event>, GameError> => {
  const seatProblem = checkSeats(options.seats, engine.ai?.levels ?? null);
  if (seatProblem !== null) return err(seatProblem);
  const config = decode(engine.schemas.config, options.config, 'game setup');
  if (!config.ok) return config;
  const start = { config: config.value, seats: options.seats, seed: options.seed };
  const built = rebuild(engine, start, [], options.restoreRng ?? defaultRestoreRng);
  if (!built.ok) return built;
  return ok(
    run(engine, options, {
      state: built.value.state,
      rng: built.value.rng,
      seats: options.seats,
      history: { ...start, records: [] },
      elapsedMs: 0,
      started: false,
      undosUsed: 0,
      assists: [],
      assistCounts: {},
      aiRng: null,
    }),
  );
};

const restoreHistory = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  envelope: SaveEnvelope,
  state: State,
  restoreRng: RngFactory,
): Result<History<Command, Config>, GameError> => {
  const lost = (why: string): Result<never, GameError> =>
    err(gameError('HistoryUnavailable', 'The saved moves could not be replayed.', { why }));
  const replay: unknown = envelope.replay;
  if (!isRecord(replay)) return lost('no replay');
  if (replay['layer'] !== 2 || replay['gameId'] !== envelope.gameId || replay['rulesVersion'] !== engine.rulesVersion) {
    return lost('replay header');
  }
  const config = decode(engine.schemas.config, replay['config'], 'saved setup');
  if (!config.ok) return config;
  const seats = replay['seats'];
  if (!Array.isArray(seats) || checkSeats(seats as SeatInfo[], null) !== null) return lost('replay seats');
  const seed = replay['seed'];
  if (!isRecord(seed) || typeof seed['algorithm'] !== 'string' || !Array.isArray(seed['words']))
    return lost('replay seed');
  const rawInputs = replay['inputs'];
  if (!Array.isArray(rawInputs)) return lost('replay inputs');
  const inputs: EngineInput<Command>[] = [];
  for (const raw of rawInputs) {
    const input = parseEngineInput(raw, engine.schemas.command);
    if (!input.ok) return input;
    inputs.push(input.value);
  }
  const start = { config: config.value, seats: seats as SeatInfo[], seed: seed as RngState };
  const rebuilt = rebuild(engine, start, inputs, restoreRng);
  if (!rebuilt.ok) return rebuilt;
  // The replay must land exactly where the save says the game stands.
  if (!jsonEqual(rebuilt.value.state, state) || !jsonEqual(rebuilt.value.rng.save(), envelope.rng))
    return lost('replay diverged');
  return ok({ ...start, records: [...rebuilt.value.records] });
};

/**
 * Resumes a saved game. `save` is whatever storage returned; it is parsed, migrated and
 * validated here. When the save's replay is missing or no longer matches, the game still
 * resumes, without undo or outstanding jobs, and the reason goes to `report`.
 */
export const restoreLocalSession = <
  State extends Json,
  Command extends Json,
  View extends Json,
  Event extends Json,
  Config extends Json,
>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  save: unknown,
  options: RestoreOptions<View>,
): Result<LocalSession<Command, View, Event>, GameError> => {
  const loaded = loadSave(save, options.manifest, engine.rulesVersion, options.migrations, engine.schemas.state);
  if (!loaded.ok) return loaded;
  const { envelope, state } = loaded.value;
  const seatProblem = checkSeats(envelope.seats, engine.ai?.levels ?? null);
  if (seatProblem !== null) return err(seatProblem);
  const restoreRng = options.restoreRng ?? defaultRestoreRng;
  const history = restoreHistory(engine, envelope, state, restoreRng);
  if (!history.ok) options.report?.(history.error, 'Restored a save without its history.');
  // The save's record is authoritative (undo leaves no trace in the replay); the replay's flags only add to it.
  const assists = new Set<AssistKind>(envelope.assists ?? []);
  const fullRecords = history.ok ? history.value.records : [];
  const records = fullRecords.slice(
    Math.max(
      0,
      fullRecords.findLastIndex((record) => record.restartsGame),
    ),
  );
  for (const record of records) if (record.assist !== null) assists.add(record.assist);
  const replayCounts: Partial<Record<AssistKind, number>> = {};
  for (const record of records)
    if (record.assist !== null) replayCounts[record.assist] = (replayCounts[record.assist] ?? 0) + 1;
  const assistCounts: Partial<Record<AssistKind, number>> = {};
  for (const kind of ASSIST_KINDS) {
    const count = Math.max(
      envelope.assistCounts?.[kind] ?? 0,
      replayCounts[kind] ?? 0,
      kind === 'undo' ? (envelope.undosUsed ?? 0) : 0,
      assists.has(kind) ? 1 : 0,
    );
    if (count > 0) {
      assistCounts[kind] = count;
      assists.add(kind);
    }
  }
  // A save from before `clockStarted` existed: the time it recorded, or the input that started the clock.
  const clockInput =
    engine.clockStart === 'transition' ? records.some((record) => record.startsClock) : records.length > 0;
  const started = envelope.clockStarted ?? ((envelope.elapsedMs ?? 0) > 0 || clockInput);
  return ok(
    run(engine, options, {
      state,
      rng: restoreRng(envelope.rng),
      seats: envelope.seats,
      history: history.ok ? history.value : null,
      elapsedMs: envelope.elapsedMs ?? 0,
      started,
      undosUsed: envelope.undosUsed ?? 0,
      assists: assistList(assists),
      assistCounts,
      aiRng: envelope.aiRng ?? null,
    }),
  );
};

const outstandingJobs = <Command>(records: readonly InputRecord<Command>[]): Map<string, JobRequest> => {
  const jobs = new Map<string, JobRequest>();
  for (const record of records) {
    if (record.restartsGame) jobs.clear();
    if (record.input.kind === 'job') jobs.delete(record.input.jobId);
    for (const job of record.jobs) jobs.set(job.id, job);
  }
  return jobs;
};

type JobResult = { readonly outcome: JobOutcome; readonly presentation: Json | null };

const FAILED: JobResult = { outcome: { ok: false, reason: 'failed' }, presentation: null };

const parseJobResult = (raw: unknown, spec: JobSpec): JobResult => {
  if (!isRecord(raw)) return FAILED;
  if (raw['ok'] === false && (raw['reason'] === 'timeout' || raw['reason'] === 'failed')) {
    return { outcome: { ok: false, reason: raw['reason'] }, presentation: null };
  }
  if (raw['ok'] !== true) return FAILED;
  const value = decode(spec.result, raw['value'], 'job result');
  if (!value.ok || !isJson(value.value)) return FAILED;
  const presentation = raw['presentation'];
  // The engine gets the value only; presentation goes to the snapshot (game-contract.md, "Async work").
  return {
    outcome: { ok: true, value: value.value },
    presentation: presentation !== undefined && isJson(presentation) ? presentation : null,
  };
};

const run = <State extends Json, Command extends Json, View extends Json, Event extends Json, Config extends Json>(
  engine: DiscreteEngine<State, Command, View, Event, Config>,
  options: LocalPorts<View>,
  start: Start<State, Command, Config>,
): LocalSession<Command, View, Event> => {
  const { manifest, mode, clock } = options;
  const restoreRng = options.restoreRng ?? defaultRestoreRng;
  const report: Reporter = options.report ?? (() => {});
  const visibility = options.visibility ?? alwaysVisible;
  const handoffScreen = mode === 'pass-and-play' && manifest.handoff;

  let state = start.state;
  let rng = start.rng;
  let seats = start.seats;
  let history = start.history;
  let revision = 0;
  let undosUsed = start.undosUsed;
  const assists = new Set<AssistKind>(start.assists);
  const assistCounts: Partial<Record<AssistKind, number>> = { ...start.assistCounts };
  const undoPolicy = undoPolicyFor(manifest.undo, mode);
  let currentNotice: Notice | null = null;
  let presentation: Json | null = null;
  let paused = false;
  let disposed = false;
  let outstanding = history === null ? new Map<string, JobRequest>() : outstandingJobs(history.records);
  const jobTasks = new Map<string, { readonly cancel: () => void }>();
  const aiTasks = new Map<SeatId, { readonly key: string; readonly cancel: () => void }>();

  // The AI's own stream (saved as `aiRng`). It moves only when an AI move is accepted, so a
  // save taken while the AI is thinking restores to the same choice.
  const restoreAi = aiRestore(restoreRng);
  let aiState: RngState = start.aiRng ?? options.aiSeed ?? deriveAiSeed(rng.save(), restoreRng);
  if (manifest.ai?.heavy === true && options.ai === undefined && engine.ai !== undefined) {
    report(
      new Error(`${manifest.id} declares heavy AI but no worker AI runner was given.`),
      'Running heavy AI on the main thread.',
    );
  }
  const aiRunner: AiRunner<View> | null =
    options.ai ?? (engine.ai === undefined ? null : inlineAi(engine.ai, clock, options.aiDelayMs ?? 500, restoreAi));

  const stopwatch = createStopwatch(clock, {
    elapsedMs: start.elapsedMs,
    started: start.started,
    finished: engine.outcome(state) !== null,
    hidden: visibility.hidden(),
  });

  // --- Who is looking at the device ---------------------------------------------------------

  const isHuman = (seat: SeatId): boolean => seats[seat]?.controller === 'human';
  const firstHuman = (): SeatId | null => seats.find((seat) => seat.controller === 'human')?.id ?? null;
  let viewer: SeatId | null =
    mode === 'pass-and-play' ? null : options.seat === undefined ? firstHuman() : options.seat;
  let handoff: SeatId | null = null;
  let wasHandoffRequired = handoffScreen;

  /**
   * Pass-and-play: the viewer follows the human seat to act, through the hand-off screen. At
   * the outcome a hand-off game shows the spectator's view, so the final board reveals no
   * hand to whoever holds the device next; an engine whose rules reveal hands at the end
   * shows them in `viewFor(state, null)`.
   */
  const updateViewer = (): void => {
    if (mode !== 'pass-and-play') return;
    if (engine.outcome(state) !== null) {
      handoff = null;
      if (handoffScreen) viewer = null;
      return;
    }
    const humans = engine.pending(state).filter(isHuman);
    const current = handoff ?? viewer;
    const required = handoffScreen && engine.handoffRequired?.(state) !== false;
    const enteringPrivate = required && !wasHandoffRequired;
    wasHandoffRequired = required;
    if (humans.length === 0) {
      if (!required && handoff !== null) {
        handoff = null;
        viewer = firstHuman();
      }
      if (viewer === null && handoff === null && !handoffScreen) viewer = firstHuman();
      return;
    }
    if (current !== null && humans.includes(current) && !enteringPrivate) {
      if (!required && handoff !== null) {
        viewer = current;
        handoff = null;
      }
      return;
    }
    // The next human to act after the current one, in seat order.
    const after = current ?? -1;
    const target = enteringPrivate
      ? Math.min(...humans)
      : ([...humans].sort((a, b) => a - b).find((seat) => seat > after) ?? Math.min(...humans));
    if (required) {
      viewer = null;
      handoff = target;
    } else {
      viewer = target;
      handoff = null;
    }
  };

  // --- Undo (D-32) --------------------------------------------------------------------------

  const undoPlan = (): { readonly cut: number } | { readonly block: UndoBlock } => {
    const policy = undoPolicy;
    // The manifest's rule for this mode; two people outside pass-and-play make a multiplayer game.
    if (
      policy === 'none' ||
      (mode !== 'pass-and-play' && seats.filter((seat) => seat.controller === 'human').length > 1)
    ) {
      return { block: 'UndoNotAllowed' };
    }
    if (history === null) return { block: 'HistoryUnavailable' };
    if (engine.outcome(state) !== null) return { block: 'GameOver' };
    if (paused) return { block: 'Paused' };
    if (typeof policy === 'object' && undosUsed >= policy.limited) return { block: 'UndoLimit' };
    // Back to the start of the human's previous decision, taking the AI's replies with it.
    const cut = history.records.findLastIndex(
      (record) => record.input.kind === 'command' && record.seatsBefore[record.input.seat]?.controller === 'human',
    );
    if (cut < 0) return { block: 'NothingToUndo' };
    // Never step back past a barrier, nor past anything before it.
    if (history.records.slice(cut).some((record) => record.barrier)) return { block: 'UndoBarrier' };
    return { cut };
  };

  const undoState = (): LocalSnapshot<View, Event>['undo'] => {
    const plan = undoPlan();
    const policy = undoPolicy;
    const remaining = policy === 'none' ? 0 : policy === 'unlimited' ? null : Math.max(0, policy.limited - undosUsed);
    return 'cut' in plan
      ? { available: true, remaining, blockedBy: null }
      : { available: false, remaining, blockedBy: plan.block };
  };

  // --- Snapshots ----------------------------------------------------------------------------

  const redact = (beats: readonly Beat<State, Event>[]): ViewBeat<View, Event>[] =>
    beats.flatMap((beat) => {
      const event = engine.eventFor(beat.event, viewer);
      if (event === null) return [];
      return [beat.state === undefined ? { event } : { event, view: engine.viewFor(beat.state, viewer) }];
    });

  const snapshot = (beats: readonly Beat<State, Event>[]): LocalSnapshot<View, Event> => {
    const outcome = engine.outcome(state);
    const elapsedMs = stopwatch.elapsed();
    return {
      meta: {
        connection: 'local',
        seat: viewer,
        revision,
        seats,
        // The platform's records replace anything the engine wrote in these fields.
        outcome:
          outcome === null
            ? null
            : { ...outcome, elapsedMs, undosUsed, assists: assistList(assists), assistCounts: { ...assistCounts } },
        safePoint: engine.safePoint?.(state) ?? outcome !== null,
        notice: currentNotice,
        undosUsed,
        assists: assistList(assists),
        assistCounts: { ...assistCounts },
      },
      view: engine.viewFor(state, viewer),
      beats: redact(beats),
      pending: engine.pending(state),
      presentation,
      mode,
      handoff: handoff === null ? null : { seat: handoff, name: seats[handoff]?.name ?? '' },
      undo: undoState(),
      thinking: [...aiTasks.keys()].sort((a, b) => a - b),
      paused,
      elapsedMs,
    };
  };

  // --- Saves --------------------------------------------------------------------------------

  const replay = (): EngineReplay | null =>
    history === null
      ? null
      : {
          layer: 2,
          gameId: manifest.id,
          rulesVersion: engine.rulesVersion,
          config: history.config,
          seats: history.seats,
          seed: history.seed,
          inputs: history.records.map((record) => record.input),
        };

  const envelope = (): SaveEnvelope =>
    compact({
      gameId: manifest.id,
      build: manifest.versions.build,
      rulesVersion: engine.rulesVersion,
      saveVersion: manifest.versions.save,
      rng: rng.save(),
      seats,
      state,
      elapsedMs: stopwatch.elapsed(),
      clockStarted: stopwatch.started(),
      replay: replay() ?? undefined,
      aiRng: aiState,
      undosUsed,
      assists: assistList(assists),
      assistCounts: { ...assistCounts },
    });

  /** The engine's `worthSaving`; an engine that throws is reported, and the game is saved. */
  const worthSaving = (): boolean => {
    try {
      return engine.worthSaving?.(state) ?? true;
    } catch (error) {
      report(error, 'The engine threw in worthSaving.');
      return true;
    }
  };

  let saving: Promise<void> = Promise.resolve();
  // Whether the slot may still hold a save: a restored game's, or one written over. Cleared
  // once while the position isn't worth saving, then left alone.
  let slotMayHoldSave = true;
  /**
   * Queues a write of the current position; resolves once it has landed (or failed). A
   * position the engine says isn't worth saving is never written, and a save it replaces
   * (after an undo back to the start) is cleared, so the launcher offers no "Continue".
   */
  const persist = (): Promise<void> => {
    const store = options.storage;
    if (store === undefined) return Promise.resolve();
    if (!worthSaving()) {
      if (!slotMayHoldSave || store.clear === undefined) return saving;
      slotMayHoldSave = false;
      const clear = store.clear.bind(store);
      saving = saving.then(clear).catch((error: unknown) => report(error, 'Clearing an untouched save failed.'));
      return saving;
    }
    slotMayHoldSave = true;
    const save = envelope();
    saving = saving
      .then(() => store.write(save))
      .catch((error: unknown) => {
        report(error, 'Saving the game failed.');
        enqueue(() => {
          currentNotice = notice('SaveFailed', "The game couldn't be saved on this device.");
          publisher.publish(snapshot([]));
        });
      });
    return saving;
  };

  // --- The ordered input path ---------------------------------------------------------------

  const queue: (() => void)[] = [];
  let draining = false;
  /** Every change runs here, one at a time, so a listener that dispatches never sees a torn state. */
  const enqueue = (work: () => void): void => {
    if (disposed) return;
    queue.push(work);
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !disposed) {
        const next = queue.shift()!;
        try {
          next();
        } catch (error) {
          report(error, 'The local session failed to process an input.');
        }
      }
    } finally {
      draining = false;
      queue.length = 0;
    }
  };

  const reject = (problem: Notice): void => {
    currentNotice = { code: problem.code, message: problem.message };
    publisher.publish(snapshot([]));
  };

  /** Publishes the new position, then saves it, then starts the jobs it requested (rule 1). */
  const settle = (beats: readonly Beat<State, Event>[]): void => {
    updateViewer();
    scheduleAi();
    publisher.publish(snapshot(beats));
    void persist().then(() => enqueue(startJobs));
  };

  /** Applies one input. On success it publishes; on failure it returns the engine's error. */
  const accept = (input: EngineInput<Command>, jobPresentation: Json | null = null): GameError | null => {
    const applied = safeApply(engine, state, input, rng, restoreRng);
    rng = applied.rng;
    if ('thrown' in applied) report(applied.thrown, 'The engine threw in apply.');
    if (!applied.result.ok) return applied.result.error;
    const transition = applied.result.value;
    const record = recordOf(input, transition, seats);
    if (record.restartsGame) {
      cancelAi();
      cancelJobs();
      outstanding.clear();
      stopwatch.restart();
      undosUsed = 0;
      assists.clear();
      for (const key of ASSIST_KINDS) delete assistCounts[key];
    }

    history?.records.push(record);
    if (record.assist !== null) {
      assists.add(record.assist);
      assistCounts[record.assist] = (assistCounts[record.assist] ?? 0) + 1;
    }
    seats = applySeatChange(seats, input);
    state = transition.state;
    if (input.kind === 'job') outstanding.delete(input.jobId);
    for (const job of transition.jobs ?? []) outstanding.set(job.id, job);
    revision += 1;
    currentNotice = null;
    presentation = jobPresentation;
    // The clock starts at the first accepted input, or at the engine's `startsClock` transition.
    if (engine.clockStart !== 'transition' || record.startsClock) stopwatch.start();
    if (engine.outcome(state) !== null) stopwatch.finish();
    settle(transition.beats);
    return null;
  };

  // --- AI seats -----------------------------------------------------------------------------

  const cancelAi = (): void => {
    for (const task of aiTasks.values()) task.cancel();
    aiTasks.clear();
  };

  /** Starts a choice for every pending AI seat whose decision changed; cancels the rest. */
  const scheduleAi = (): void => {
    const wanted = new Map<SeatId, string>();
    if (!paused && !disposed && aiRunner !== null && engine.outcome(state) === null) {
      for (const seat of engine.pending(state)) {
        if (seats[seat]?.controller !== 'ai') continue;
        wanted.set(seat, JSON.stringify(engine.decisionKey?.(state, seat) ?? engine.viewFor(state, seat)));
      }
    }
    for (const [seat, task] of aiTasks) {
      if (wanted.get(seat) === task.key) continue;
      task.cancel();
      aiTasks.delete(seat);
    }
    for (const [seat, key] of wanted) if (!aiTasks.has(seat)) startAi(seat, key);
  };

  const aiFailed = (seat: SeatId, error: unknown): void => {
    report(error, `The AI for seat ${seat} failed.`);
    reject(notice('AiFailed', `${seats[seat]?.name ?? 'The computer'} couldn't move.`));
  };

  const startAi = (seat: SeatId, key: string): void => {
    if (aiRunner === null) return;
    // A copy of the seat's view and nothing else: the AI can't see more, or mutate state.
    const view = jsonClone(engine.viewFor(state, seat));
    const level = seats[seat]?.aiLevel ?? engine.ai?.levels[0] ?? 'default';
    const task = aiRunner.choose({ view, seat, level, rng: aiDecisionSeed(aiState, seat, restoreAi) });
    const entry = { key, cancel: () => task.cancel() };
    aiTasks.set(seat, entry);
    task.result.then(
      (raw) =>
        enqueue(() => {
          if (aiTasks.get(seat) !== entry) return;
          aiTasks.delete(seat);
          const command = decode(engine.schemas.command, raw, 'AI move');
          if (!command.ok) return aiFailed(seat, command.error);
          // Move the AI stream before accepting, so the AI choices this move triggers get fresh children.
          const before = aiState;
          aiState = advanceAi(aiState, seats.length, restoreAi);
          const problem = accept({ kind: 'command', seat, command: command.value });
          if (problem !== null) {
            aiState = before;
            aiFailed(seat, problem);
          }
        }),
      (error: unknown) =>
        enqueue(() => {
          if (aiTasks.get(seat) !== entry) return;
          aiTasks.delete(seat);
          aiFailed(seat, error);
        }),
    );
  };

  // --- Jobs ---------------------------------------------------------------------------------

  const cancelJobs = (): void => {
    for (const task of jobTasks.values()) task.cancel();
    jobTasks.clear();
  };

  const startJobs = (): void => {
    for (const job of outstanding.values()) if (!jobTasks.has(job.id)) launch(job);
  };

  const launch = (job: JobRequest): void => {
    let stopTimer = (): void => {};
    let task: { cancel(): void } | null = null;
    const entry = { cancel: () => (stopTimer(), task?.cancel()) };
    jobTasks.set(job.id, entry);
    const finish = (result: JobResult): void =>
      enqueue(() => {
        // Rule 2: only the job the game still awaits applies; a late result is dropped.
        if (jobTasks.get(job.id) !== entry) return;
        jobTasks.delete(job.id);
        stopTimer();
        if (!outstanding.has(job.id)) return;
        const problem = accept({ kind: 'job', jobId: job.id, outcome: result.outcome }, result.presentation);
        if (problem !== null) {
          // The engine no longer wants it (rule 2); not the player's concern.
          outstanding.delete(job.id);
          report(problem, `The engine rejected the result of job ${job.id}.`);
        }
      });
    const spec = engine.jobs?.[job.kind];
    const payload = spec === undefined ? null : decode(spec.payload, job.payload, 'job payload');
    if (
      spec === undefined ||
      spec.where === 'server' ||
      options.jobs === undefined ||
      payload === null ||
      !payload.ok
    ) {
      // The engine decides what a failure means (rule 3).
      report(new Error(`Job ${job.id} (${job.kind}) can't run locally.`), 'Job unavailable.');
      void Promise.resolve().then(() => finish(FAILED));
      return;
    }
    const running = options.jobs.run(job, spec);
    task = running;
    stopTimer = clock.after(spec.timeoutMs, () => {
      running.cancel();
      finish({ outcome: { ok: false, reason: 'timeout' }, presentation: null });
    });
    running.result.then(
      (raw) => finish(parseJobResult(raw, spec)),
      (error: unknown) => {
        report(error, `Job ${job.id} failed.`);
        finish(FAILED);
      },
    );
  };

  // --- Inputs from the UI -------------------------------------------------------------------

  const gameOver = (): boolean => engine.outcome(state) !== null;

  const undo = (): void => {
    const plan = undoPlan();
    if ('block' in plan) return reject(notice(plan.block, UNDO_MESSAGES[plan.block]));
    if (history === null) return;
    const inputs = history.records.slice(0, plan.cut).map((record) => record.input);
    const rebuilt = rebuild(engine, history, inputs, restoreRng);
    if (!rebuilt.ok) {
      report(rebuilt.error, 'Undo could not replay the game.');
      return reject(notice('InternalError', 'Undo failed. The game continues from here.'));
    }
    cancelAi();
    cancelJobs();
    state = rebuilt.value.state;
    rng = rebuilt.value.rng;
    seats = rebuilt.value.seats;
    history.records = [...rebuilt.value.records];
    outstanding = outstandingJobs(history.records);
    undosUsed += 1;
    assists.add('undo');
    assistCounts.undo = undosUsed;
    revision += 1;
    currentNotice = null;
    presentation = null;
    settle([]);
  };

  /**
   * The seat a command comes from. Without a named seat it is the viewer's. A named seat must
   * be a person at this device who is pending or has an explicitly authorized untimed side
   * command: in pass-and-play without a hand-off screen, any such human seat, so simultaneous games such as War take both players' moves in
   * either order; everywhere else, only the viewer's own seat (gp-o2c).
   */
  const commandSeat = (named: unknown, command: Command): Result<SeatId, Notice> => {
    const watching = (): Result<SeatId, Notice> =>
      err(
        handoff === null
          ? notice('Spectator', 'Watchers cannot move.')
          : notice('HandoffPending', 'Pass the device first.'),
      );
    if (named === undefined) return viewer === null ? watching() : ok(viewer);
    const notHere = err(notice('InvalidSeat', "That seat isn't played on this device."));
    if (typeof named !== 'number' || seats[named] === undefined || !isHuman(named)) return notHere;
    if (mode !== 'pass-and-play') return named === viewer ? ok(named) : notHere;
    if (handoffScreen && named !== viewer)
      return viewer === null ? watching() : err(notice('HandoffPending', 'Pass the device first.'));
    if (gameOver()) return err(notice('GameOver', 'The game is over.'));
    if (!engine.pending(state).includes(named) && engine.sideCommand?.(state, named, command) !== true)
      return err(notice('NotYourTurn', `It isn't ${seats[named]?.name ?? 'that seat'}'s turn.`));
    return ok(named);
  };

  const handle = (raw: unknown): void => {
    const invalid = notice('InvalidInput', "That action isn't recognized.");
    if (!isRecord(raw)) return reject(invalid);
    const kind = raw['kind'];
    const changesGame = kind === 'command' || kind === 'resign' || kind === 'seat' || kind === 'undo';
    if (changesGame && paused) return reject(notice('Paused', 'The game is paused.'));
    switch (kind) {
      case 'command': {
        const command = decode(engine.schemas.command, raw['command'], 'move');
        if (!command.ok) return reject(command.error);
        const seat = commandSeat(raw['seat'], command.value);
        if (!seat.ok) return reject(seat.error);
        const problem = accept({ kind: 'command', seat: seat.value, command: command.value });
        return problem === null ? undefined : reject(problem);
      }
      case 'resign':
      case 'seat': {
        const seat = raw['seat'] === undefined && kind === 'resign' ? viewer : raw['seat'];
        if (typeof seat !== 'number' || seats[seat] === undefined)
          return reject(notice('InvalidSeat', 'Choose a seat first.'));
        if (gameOver()) return reject(notice('GameOver', 'The game is over.'));
        let input: EngineInput<Command>;
        if (kind === 'resign') {
          if (!isHuman(seat)) return reject(notice('InvalidSeat', 'Only a player can resign.'));
          input = { kind: 'resign', seat };
        } else {
          const parsed = parseEngineInput({ kind: 'seat', seat, change: raw['change'] }, engine.schemas.command);
          if (!parsed.ok) return reject(invalid);
          input = parsed.value;
          const change = (parsed.value as { readonly change: SeatChange }).change;
          if (
            change.type === 'controller' &&
            change.aiLevel !== undefined &&
            engine.ai !== undefined &&
            !engine.ai.levels.includes(change.aiLevel)
          ) {
            return reject(notice('InvalidSeat', "The game doesn't have that AI level."));
          }
        }
        const problem = accept(input);
        return problem === null ? undefined : reject(problem);
      }
      case 'undo':
        return undo();
      case 'reveal': {
        if (handoff === null) return reject(notice('NoHandoff', 'There is nothing to reveal.'));
        viewer = handoff;
        handoff = null;
        revision += 1;
        currentNotice = null;
        return publisher.publish(snapshot([]));
      }
      case 'pause':
      case 'resume': {
        if (paused === (kind === 'pause')) return;
        paused = kind === 'pause';
        stopwatch.setPaused(paused);
        scheduleAi();
        publisher.publish(snapshot([]));
        if (paused) void persist();
        return;
      }
      default:
        return reject(invalid);
    }
  };

  // --- Start --------------------------------------------------------------------------------

  updateViewer();
  scheduleAi();
  const publisher = createPublisher(snapshot([]), { freeze: options.freeze ?? true, report });
  const stopVisibility = visibility.subscribe((hidden) =>
    enqueue(() => {
      stopwatch.setHidden(hidden);
      // A hidden page may never come back: save the play time now.
      if (hidden) void persist();
    }),
  );
  // Save the starting position (a reload can't redeal), then resume any outstanding jobs.
  void persist().then(() => enqueue(startJobs));

  return {
    get: () => publisher.get(),
    subscribe: (listener) => publisher.subscribe(listener),
    dispatch: (input) => enqueue(() => handle(input)),
    dispose: () => {
      if (disposed) return;
      void persist();
      disposed = true;
      queue.length = 0;
      cancelAi();
      cancelJobs();
      stopVisibility();
      publisher.close();
    },
    elapsedMs: () => stopwatch.elapsed(),
    save: envelope,
    replay,
  };
};
