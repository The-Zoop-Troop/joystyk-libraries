// @joystyk/session/browser: the runners' ports, implemented with browser APIs. The core
// package never touches these globals; the launcher passes these adapters in.
import type { JobRequest, JobSpec, SaveEnvelope } from '@joystyk/contracts';
import type {
  AiRunner,
  AiTask,
  Clock,
  FrameScheduler,
  JobRunner,
  Reporter,
  SaveStore,
  Task,
  Visibility,
} from '../ports.ts';
export { workerPreparer } from './preparer.ts';
export { createGameAudio, watchGameAudio, type GameAudioService, type AudioEnvironment } from './audio.ts';

/** `performance.now()` and `setTimeout`. */
export const browserClock = (): Clock => ({
  now: () => performance.now(),
  after: (ms, callback) => {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
});

/** The Page Visibility API. `pagehide` also counts as hidden, for pages entering the back/forward cache. */
export const documentVisibility = (doc: Document = document): Visibility => ({
  hidden: () => doc.visibilityState === 'hidden',
  subscribe: (listener) => {
    const onChange = (): void => listener(doc.visibilityState === 'hidden');
    const onHide = (): void => listener(true);
    const view = doc.defaultView;
    doc.addEventListener('visibilitychange', onChange);
    view?.addEventListener('pagehide', onHide);
    view?.addEventListener('pageshow', onChange);
    return () => {
      doc.removeEventListener('visibilitychange', onChange);
      view?.removeEventListener('pagehide', onHide);
      view?.removeEventListener('pageshow', onChange);
    };
  },
});

/** `requestAnimationFrame`, passing the frame's timestamp. */
export const animationFrames = (): FrameScheduler => ({
  request: (callback) => {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
});

/**
 * A save slot in Web Storage, until the `storage` package's IndexedDB store exists. Writes
 * reject when storage is unavailable or full (private browsing, quota).
 */
export const webStorageSaveStore = (key: string, storage: Storage = localStorage): SaveStore & { read(): unknown } => ({
  write: (save: SaveEnvelope) => {
    try {
      storage.setItem(key, JSON.stringify(save));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
  clear: () => {
    try {
      storage.removeItem(key);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
  /** The stored value, unparsed beyond JSON (restore parses it), or null. */
  read: () => {
    try {
      const raw = storage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  },
});

/**
 * Runs each job in a fresh worker from `createWorker(kind)`. The worker receives
 * `{ id, kind, payload }` and answers with one message: the job outcome
 * (`{ ok: true, value, presentation? }` or `{ ok: false, reason }`). Cancelling, or the
 * answer arriving, terminates the worker. The runner parses the answer.
 */
export const workerJobRunner = (createWorker: (kind: string) => Worker): JobRunner => ({
  run: (job: JobRequest, _spec: JobSpec): Task<unknown> => {
    const worker = createWorker(job.kind);
    const result = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<unknown>) => {
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || `The ${job.kind} worker failed.`));
      };
    });
    worker.postMessage({ id: job.id, kind: job.kind, payload: job.payload });
    return { result, cancel: () => worker.terminate() };
  },
});

/**
 * Runs each AI choice in a fresh worker from `createWorker()`, for games whose manifest
 * declares heavy AI. The worker receives the `AiTask` (`{ view, seat, level, rng }`, all
 * JSON) and answers with one message: the command. A game's worker entry is a few lines:
 *
 * ```ts
 * // games/<id>/jobs/ai.worker.ts
 * import { restoreRng } from '@joystyk/kit';
 * import { engine } from '../engine/index.ts';
 * onmessage = ({ data }) => postMessage(engine.ai.choose(data.view, data.seat, data.level, restoreRng(data.rng)));
 * ```
 *
 * Cancelling terminates the worker, which is the only way to stop a search that's running.
 * The runner parses the answer with the engine's command schema.
 */
export const workerAiRunner = <View>(createWorker: () => Worker): AiRunner<View> => ({
  choose: (task: AiTask<View>): Task<unknown> => {
    const worker = createWorker();
    const result = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<unknown>) => {
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message || 'The AI worker failed.'));
      };
    });
    worker.postMessage(task);
    return { result, cancel: () => worker.terminate() };
  },
});

/** Logs caught bugs to the console. */
export const consoleReporter: Reporter = (error, context) => {
  console.error(`[session] ${context}`, error);
};

/** The usual browser ports in one object, to spread into a runner's options. */
export const browserPorts = (): {
  readonly clock: Clock;
  readonly visibility: Visibility;
  readonly frames: FrameScheduler;
  readonly report: Reporter;
} => ({
  clock: browserClock(),
  visibility: documentVisibility(),
  frames: animationFrames(),
  report: consoleReporter,
});
