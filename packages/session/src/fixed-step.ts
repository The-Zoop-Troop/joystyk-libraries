// The Layer 3 scheduler: runs a fixed-step simulation against real time. It accumulates
// frame time, runs as many ticks as that covers (with a cap on catch-up), assigns inputs to
// the next tick in arrival order, pauses when the page is hidden, and publishes a snapshot
// at frame cadence. Game time is ticks, so it is deterministic and replayable.
import {
  err,
  gameError,
  ok,
  type FixedStepSimulation,
  type GameError,
  type GameSession,
  type Json,
  type Migration,
  type Notice,
  type Result,
  type Rng,
  type RngState,
  type SaveEnvelope,
  type SeatId,
  type SeatInfo,
  type SimulationReplay,
  type SimulationSnapshot,
  type TickInput,
} from '@joystyk/contracts';
import {
  alwaysVisible,
  type FrameScheduler,
  type Reporter,
  type RngFactory,
  type SaveStore,
  type Visibility,
} from './ports.ts';
import { createPublisher } from './publisher.ts';
import { replaySimulation } from './replay.ts';
import { defaultRestoreRng } from './rngs.ts';
import { isSeatInfo, loadSave, type RunnerManifest } from './saves.ts';
import { compact, decode, isRecord, jsonEqual } from './values.ts';

/** What the game's UI dispatches to a fixed-step runner. */
export type FixedStepInput<Input> =
  { readonly kind: 'input'; readonly input: Input } | { readonly kind: 'pause' } | { readonly kind: 'resume' };

/** The contract's `SimulationSnapshot` plus the tick events since the last snapshot. */
export type FixedStepSnapshot<View, Event> = SimulationSnapshot<View> & {
  /** One-off events from the ticks since the previous snapshot, for sound and effects. */
  readonly events: readonly Event[];
  /** Active play time: ticks × step length, so a pause stops it. */
  readonly elapsedMs: number;
};

export interface FixedStepRunner<Input, View, Event> extends GameSession<
  FixedStepSnapshot<View, Event>,
  FixedStepInput<Input>
> {
  /**
   * How far real time has run into the next tick, from 0 up to 1. A renderer may interpolate
   * between the last two states with it; it never changes the simulation.
   */
  alpha(): number;
  /** A checkpoint of the current tick. */
  save(): SaveEnvelope;
  /** The replay log so far, or null after restoring a checkpoint that had none. */
  replay(): SimulationReplay | null;
}

export type FixedStepPorts = {
  readonly manifest: RunnerManifest;
  /** Restores the random state. Default: the kit's `restoreRng`. */
  readonly restoreRng?: RngFactory;
  readonly frames: FrameScheduler;
  readonly visibility?: Visibility;
  /** Checkpoints go here on the simulation's request, pause, hide, outcome and dispose. */
  readonly storage?: SaveStore;
  /** The viewer. Default: seat 0. */
  readonly seat?: SeatId | null;
  /**
   * The most ticks one frame may run. After a long stall the rest of the backlog is dropped
   * instead of freezing the page. Default: a tenth of a second's worth (6 at 60 Hz).
   */
  readonly maxStepsPerFrame?: number;
  /** Start paused, e.g. behind a "Press to start" screen. Default false. */
  readonly startPaused?: boolean;
  readonly freeze?: boolean;
  readonly report?: Reporter;
};

export type FixedStepOptions = FixedStepPorts & {
  readonly seats: readonly SeatInfo[];
  /** Decoded with the simulation's config schema. */
  readonly config: unknown;
  readonly seed: RngState;
};

export type FixedStepRestoreOptions = FixedStepPorts & {
  readonly migrations: readonly Migration[];
};

type Start<State, Input, Config> = {
  readonly state: State;
  readonly rng: Rng;
  readonly tick: number;
  readonly seats: readonly SeatInfo[];
  readonly log: { readonly config: Config; readonly seed: RngState; readonly inputs: TickInput<Input>[] } | null;
};

/** Starts a new real-time game. Fails when the config is invalid or `init` refuses it. */
export const createFixedStepRunner = <
  State extends Json,
  Input extends Json,
  View,
  Event extends Json,
  Config extends Json,
>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  options: FixedStepOptions,
): Result<FixedStepRunner<Input, View, Event>, GameError> => {
  if (options.seats.length === 0 || !options.seats.every((seat, i) => isSeatInfo(seat) && seat.id === i)) {
    return err(gameError('InvalidSeats', 'The seats must be numbered 0, 1, 2 and so on.'));
  }
  const config = decode(simulation.schemas.config, options.config, 'game setup');
  if (!config.ok) return config;
  const rng = (options.restoreRng ?? defaultRestoreRng)(options.seed);
  const initialized = simulation.init(config.value, rng);
  if (!initialized.ok) return initialized;
  return ok(
    run(simulation, options, {
      state: initialized.value,
      rng,
      tick: 0,
      seats: options.seats,
      log: { config: config.value, seed: options.seed, inputs: [] },
    }),
  );
};

/**
 * Resumes a checkpoint. When the checkpoint carries a replay that still reproduces it, the
 * replay log continues; otherwise the game resumes without one.
 */
export const restoreFixedStepRunner = <
  State extends Json,
  Input extends Json,
  View,
  Event extends Json,
  Config extends Json,
>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  save: unknown,
  options: FixedStepRestoreOptions,
): Result<FixedStepRunner<Input, View, Event>, GameError> => {
  const loaded = loadSave(
    save,
    options.manifest,
    simulation.rulesVersion,
    options.migrations,
    simulation.schemas.state,
  );
  if (!loaded.ok) return loaded;
  const { envelope, state } = loaded.value;
  const restoreRng = options.restoreRng ?? defaultRestoreRng;
  if (envelope.tick === undefined)
    return err(gameError('SaveUnreadable', 'This saved game could not be read.', { why: 'tick' }));
  let log: Start<State, Input, Config>['log'] = null;
  const replay: unknown = envelope.replay;
  if (
    isRecord(replay) &&
    replay['layer'] === 3 &&
    replay['endTick'] === envelope.tick &&
    Array.isArray(replay['inputs'])
  ) {
    const config = decode(simulation.schemas.config, replay['config'], 'saved setup');
    const inputs: TickInput<Input>[] = [];
    let valid = config.ok;
    for (const entry of replay['inputs'] as unknown[]) {
      if (!isRecord(entry) || !Number.isInteger(entry['tick'])) {
        valid = false;
        break;
      }
      const input = decode(simulation.schemas.input, entry['input'], 'saved input');
      if (!input.ok) {
        valid = false;
        break;
      }
      inputs.push({ tick: entry['tick'] as number, input: input.value });
    }
    if (valid && config.ok) {
      const candidate = { ...(replay as unknown as SimulationReplay<Input, Config>), config: config.value, inputs };
      const replayed = replaySimulation(simulation, candidate, restoreRng);
      if (replayed.ok && jsonEqual(replayed.value.state, state) && jsonEqual(replayed.value.rng, envelope.rng)) {
        log = { config: config.value, seed: candidate.seed, inputs };
      }
    }
  }
  if (log === null)
    options.report?.(new Error('The checkpoint has no usable replay.'), 'Restored a checkpoint without its replay.');
  return ok(
    run(simulation, options, { state, rng: restoreRng(envelope.rng), tick: envelope.tick, seats: envelope.seats, log }),
  );
};

const run = <State extends Json, Input extends Json, View, Event extends Json, Config extends Json>(
  simulation: FixedStepSimulation<State, Input, View, Event, Config>,
  options: FixedStepPorts,
  start: Start<State, Input, Config>,
): FixedStepRunner<Input, View, Event> => {
  const { manifest, frames } = options;
  const restoreRng = options.restoreRng ?? defaultRestoreRng;
  const report: Reporter = options.report ?? (() => {});
  const visibility = options.visibility ?? alwaysVisible;
  const stepMs = 1000 / simulation.stepHz;
  const maxSteps = Math.max(1, options.maxStepsPerFrame ?? Math.ceil(simulation.stepHz / 10));

  let state = start.state;
  let rng = start.rng;
  let tick = start.tick;
  const log = start.log;
  let revision = 0;
  let notice: Notice | null = null;
  let hidden = visibility.hidden();
  let userPaused = options.startPaused ?? false;
  let broken = false;
  let disposed = false;
  let accumulator = 0;
  let lastFrame: number | null = null;
  let cancelFrame: (() => void) | null = null;
  /** Inputs waiting for the next tick, in arrival order. */
  let queued: Input[] = [];

  const finished = (): boolean => simulation.outcome(state) !== null;
  const paused = (): boolean => hidden || userPaused;
  const elapsedMs = (): number => Math.round(tick * stepMs);

  const snapshot = (events: readonly Event[]): FixedStepSnapshot<View, Event> => {
    const outcome = simulation.outcome(state);
    return {
      meta: {
        connection: 'local',
        seat: options.seat === undefined ? 0 : options.seat,
        revision,
        seats: start.seats,
        outcome: outcome === null ? null : { ...outcome, elapsedMs: elapsedMs() },
        safePoint: simulation.safePoint?.(state) ?? (outcome !== null || paused()),
        notice,
      },
      view: simulation.view(state),
      tick,
      paused: paused(),
      events,
      elapsedMs: elapsedMs(),
    };
  };

  const replay = (): SimulationReplay | null =>
    log === null
      ? null
      : {
          layer: 3,
          gameId: manifest.id,
          rulesVersion: simulation.rulesVersion,
          config: log.config,
          seed: log.seed,
          inputs: log.inputs,
          endTick: tick,
        };

  const envelope = (): SaveEnvelope =>
    compact({
      gameId: manifest.id,
      build: manifest.versions.build,
      rulesVersion: simulation.rulesVersion,
      saveVersion: manifest.versions.save,
      rng: rng.save(),
      seats: start.seats,
      state,
      tick,
      elapsedMs: elapsedMs(),
      replay: replay() ?? undefined,
    });

  let saving: Promise<void> = Promise.resolve();
  const persist = (): void => {
    const store = options.storage;
    if (store === undefined) return;
    const save = envelope();
    saving = saving
      .then(() => store.write(save))
      .catch((error: unknown) => report(error, 'Saving the checkpoint failed.'));
  };

  const publisher = createPublisher(snapshot([]), { freeze: options.freeze ?? true, report });
  const publish = (events: readonly Event[]): void => {
    revision += 1;
    publisher.publish(snapshot(events));
  };

  const running = (): boolean => !disposed && !broken && !paused() && !finished();

  const requestFrame = (): void => {
    if (cancelFrame === null && running()) cancelFrame = frames.request(onFrame);
  };

  const stopFrames = (): void => {
    cancelFrame?.();
    cancelFrame = null;
    // Resume starts from a fresh frame: hidden or paused time never becomes ticks.
    lastFrame = null;
    accumulator = 0;
  };

  const step = (): Event[] => {
    const inputs = queued;
    queued = [];
    for (const input of inputs) log?.inputs.push({ tick, input });
    const result = simulation.step(state, inputs, rng);
    state = result.state;
    tick += 1;
    return [...(result.events ?? [])];
  };

  function onFrame(now: number): void {
    cancelFrame = null;
    if (!running()) return;
    if (lastFrame === null) {
      lastFrame = now;
      return requestFrame();
    }
    accumulator += Math.max(0, now - lastFrame);
    lastFrame = now;
    // A small epsilon keeps 16.666… ms frames from landing a hair short of a tick.
    let steps = Math.floor((accumulator + 1e-6) / stepMs);
    if (steps > maxSteps) {
      // Bounded catch-up: run the cap and drop the backlog, keeping the fraction.
      accumulator %= stepMs;
      steps = maxSteps;
    } else {
      accumulator = Math.max(0, accumulator - steps * stepMs);
    }
    const events: Event[] = [];
    for (let i = 0; i < steps && !finished(); i += 1) {
      const savedRng = rng.save();
      const savedQueue = queued;
      try {
        events.push(...step());
      } catch (error) {
        // A throwing step is a bug: keep the last good tick and stop.
        rng = restoreRng(savedRng);
        queued = savedQueue;
        if (log !== null) log.inputs.splice(log.inputs.length - savedQueue.length);
        broken = true;
        report(error, `The simulation threw at tick ${tick}.`);
        notice = { code: 'InternalError', message: 'Something went wrong. The game has stopped.' };
        break;
      }
    }
    if (steps > 0 || broken) {
      if (!broken) notice = null;
      if (finished() || broken || simulation.checkpoint?.(state, events) === true) persist();
      publish(events);
    }
    requestFrame();
  }

  const setPaused = (next: { readonly hidden?: boolean; readonly user?: boolean }): void => {
    const was = paused();
    if (next.hidden !== undefined) hidden = next.hidden;
    if (next.user !== undefined) userPaused = next.user;
    if (was === paused()) return;
    if (paused()) {
      stopFrames();
      persist();
    } else {
      requestFrame();
    }
    publish([]);
  };

  const stopVisibility = visibility.subscribe((value) => {
    if (!disposed) setPaused({ hidden: value });
  });

  requestFrame();

  return {
    get: () => publisher.get(),
    subscribe: (listener) => publisher.subscribe(listener),
    dispatch: (raw) => {
      if (disposed) return;
      if (!isRecord(raw)) return;
      if (raw['kind'] === 'pause' || raw['kind'] === 'resume') return setPaused({ user: raw['kind'] === 'pause' });
      if (raw['kind'] !== 'input') return;
      const reject = (code: string, message: string): void => {
        notice = { code, message };
        publish([]);
      };
      if (finished() || broken) return reject('GameOver', 'The game is over.');
      if (paused()) return reject('Paused', 'The game is paused.');
      const input = decode(simulation.schemas.input, raw['input'], 'input');
      if (!input.ok) return reject(input.error.code, input.error.message);
      // Assigned to the next tick that runs, after everything already queued.
      queued.push(input.value);
    },
    dispose: () => {
      if (disposed) return;
      persist();
      disposed = true;
      stopFrames();
      stopVisibility();
      publisher.close();
    },
    alpha: () => Math.min(1, accumulator / stepMs),
    save: envelope,
    replay,
  };
};
