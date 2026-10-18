// The job pool (room-server.md section 4.4): background work on worker_threads, behind an
// interface so tests and development can run jobs inline.
import { Worker } from 'node:worker_threads';
import type { JobOutcome, Json } from '@joystyk/contracts';
import type { AiFailure, RoomCode } from '../types.ts';
import type { Logger } from './support.ts';

export type PoolJob = {
  readonly room: RoomCode;
  readonly jobId: string;
  readonly gameId: string;
  /** A room always supplies its pin; omitted internal probes use the current engine. */
  readonly rulesVersion?: number;
  readonly kind: string;
  readonly payload: Json;
  readonly timeoutMs: number;
  /**
   * 'outcome' (default): the module answers with a JobOutcome. 'value': it answers with a
   * plain value (a heavy AI's command), which the pool wraps as { ok: true, value }.
   */
  readonly answer?: 'outcome' | 'value';
};

/** A job's outcome, or why the pool could not run it to the end (see `AiFailure`). */
export type PoolOutcome = JobOutcome | { readonly ok: false; readonly reason: AiFailure };

export interface JobPool {
  /** Never rejects: failures come back as { ok: false }. */
  run(job: PoolJob): Promise<PoolOutcome>;
  readonly inFlight: number;
  /** Resolves true once nothing is running, or false after `timeoutMs`. */
  idle(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Shared bookkeeping for `inFlight` and `idle`. */
class Tracker {
  inFlight = 0;
  private waiters: (() => void)[] = [];

  track<T>(work: Promise<T>): Promise<T> {
    this.inFlight += 1;
    return work.finally(() => {
      this.inFlight -= 1;
      if (this.inFlight === 0) for (const wake of this.waiters.splice(0)) wake();
    });
  }

  idle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/** Runs jobs in the main thread through a handler. For tests and development fixtures. */
export const inlineJobPool = (handler: (job: PoolJob) => PoolOutcome | Promise<PoolOutcome>): JobPool => {
  const tracker = new Tracker();
  return {
    run: (job) =>
      tracker.track(
        Promise.resolve()
          .then(() => handler(job))
          .catch((): PoolOutcome => ({ ok: false, reason: 'failed' })),
      ),
    get inFlight() {
      return tracker.inFlight;
    },
    idle: (timeoutMs) => tracker.idle(timeoutMs),
    close: async () => {},
  };
};

/**
 * The worker host. It imports a job's entry module (a game's `jobs/<kind>.worker.ts`, whose
 * default export maps a payload to a JobOutcome, or `jobs/ai.worker.ts`, which maps
 * `{ view, seat, level, rng }` to a command) and answers each request. Jobs run one at a
 * time, in order, and each says when it starts, so its timeout never includes its wait in the
 * queue. Written as an eval'd script so it works the same from source and from a bundle.
 */
const HOST = `
const { parentPort } = require('node:worker_threads');
const modules = new Map();
let queue = Promise.resolve();
const run = async ({ job, module, payload, answer }) => {
  parentPort.postMessage({ job, started: true });
  try {
    let loaded = modules.get(module);
    if (loaded === undefined) { loaded = await import(module); modules.set(module, loaded); }
    const result = await loaded.default(payload);
    parentPort.postMessage({ job, outcome: answer === 'value' ? { ok: true, value: result } : result });
  } catch (error) {
    parentPort.postMessage({ job, error: String(error) });
  }
};
parentPort.on('message', (message) => { queue = queue.then(() => run(message)); });
`;

type Pending = {
  readonly resolve: (outcome: PoolOutcome) => void;
  readonly timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};
type Slot = { worker: Worker; readonly pending: Map<number, Pending>; running: number | null };

export type WorkerPoolOptions = {
  /** Worker threads (ROOMS_JOB_WORKERS). */
  readonly workers: number;
  /** The entry module URL for a game's job kind, or null when this build has none. */
  readonly module: (gameId: string, kind: string, rulesVersion?: number) => URL | null;
  /** Queued or running jobs per worker. */
  readonly perWorker?: number;
  readonly log?: Logger;
};

/**
 * Greed's physics pool, generalized. A full pool refuses a job at once (`busy`). A timeout or
 * crash terminates that worker and starts a fresh one; the job it was running fails with
 * `timeout` or `crashed`, and every job queued behind it with `lost`.
 */
export const workerJobPool = (options: WorkerPoolOptions): JobPool => {
  const perWorker = options.perWorker ?? 16;
  const tracker = new Tracker();
  let sequence = 0;
  let stopped = false;
  const slots: Slot[] = [];

  const spawn = (slot?: Slot): Slot => {
    const worker = new Worker(HOST, { eval: true });
    worker.unref();
    const target: Slot = slot ?? { worker, pending: new Map(), running: null };
    target.worker = worker;
    target.running = null;
    worker.on('message', (data: { job: number; started?: true; outcome?: JobOutcome; error?: string }) => {
      if (target.worker !== worker) return;
      const pending = target.pending.get(data.job);
      if (pending === undefined) return;
      if (data.started === true) {
        target.running = data.job;
        pending.timer = setTimeout(() => restart(target, worker, 'timeout'), pending.timeoutMs);
        return;
      }
      if (pending.timer !== null) clearTimeout(pending.timer);
      target.pending.delete(data.job);
      if (target.running === data.job) target.running = null;
      if (data.error !== undefined) options.log?.write('warn', 'job_failed', { error: data.error });
      pending.resolve(data.outcome ?? { ok: false, reason: 'failed' });
    });
    worker.on('error', () => restart(target, worker, 'crashed'));
    worker.on('exit', () => restart(target, worker, 'crashed'));
    return target;
  };

  const restart = (slot: Slot, worker: Worker, reason: 'timeout' | 'crashed'): void => {
    if (stopped || slot.worker !== worker) return;
    for (const [job, pending] of slot.pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: job === slot.running ? reason : 'lost' });
    }
    slot.pending.clear();
    spawn(slot);
    void worker.terminate();
  };

  for (let i = 0; i < Math.max(1, options.workers); i += 1) slots.push(spawn());

  const run = (job: PoolJob): Promise<PoolOutcome> => {
    const module = options.module(job.gameId, job.kind, job.rulesVersion);
    const slot = [...slots].sort((a, b) => a.pending.size - b.pending.size)[0];
    if (stopped || module === null || slot === undefined || slot.pending.size >= perWorker) {
      options.log?.write('warn', module === null ? 'job_module_missing' : 'job_rejected_busy', {
        room: job.room,
        kind: job.kind,
      });
      return Promise.resolve({ ok: false, reason: module === null || stopped ? 'failed' : 'busy' });
    }
    sequence += 1;
    const id = sequence;
    const worker = slot.worker;
    return tracker.track(
      new Promise<PoolOutcome>((resolve) => {
        slot.pending.set(id, { resolve, timeoutMs: job.timeoutMs, timer: null });
        worker.postMessage({ job: id, module: module.href, payload: job.payload, answer: job.answer ?? 'outcome' });
      }),
    );
  };

  return {
    run,
    get inFlight() {
      return tracker.inFlight;
    },
    idle: (timeoutMs) => tracker.idle(timeoutMs),
    close: async () => {
      stopped = true;
      for (const slot of slots) {
        for (const pending of slot.pending.values()) {
          if (pending.timer !== null) clearTimeout(pending.timer);
          pending.resolve({ ok: false, reason: 'failed' });
        }
        slot.pending.clear();
      }
      await Promise.all(slots.map((slot) => slot.worker.terminate()));
    },
  };
};
