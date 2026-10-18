import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../__tests__/node-helpers.ts';
import { inlineJobPool, workerJobPool, type JobPool } from './jobs.ts';
import { memoryLogger } from './support.ts';

const temps: { remove: () => void }[] = [];
const pools: JobPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.close();
  for (const t of temps.splice(0)) t.remove();
});

const modules = () => {
  const t = tempDir();
  temps.push(t);
  const write = (name: string, source: string): URL => {
    writeFileSync(t.file(name), source);
    return pathToFileURL(t.file(name));
  };
  return {
    double: write('double.worker.mjs', 'export default (payload) => ({ ok: true, value: { n: payload.n * 2 } });'),
    hang: write('hang.worker.mjs', 'export default () => new Promise(() => {});'),
    crash: write('crash.worker.mjs', 'export default () => { throw new Error("broken"); };'),
    ai: write('ai.worker.mjs', 'export default ({ view }) => ({ take: view.heap % 3 + 1 });'),
    slow: write(
      'slow.worker.mjs',
      'export default ({ ms }) => { const end = Date.now() + ms; while (Date.now() < end); return { ok: true, value: {} }; };',
    ),
    exit: write('exit.worker.mjs', 'export default () => process.exit(1);'),
  };
};

const job = (kind: string, payload = {}, timeoutMs = 2_000) => ({
  room: 'ROOMAA',
  jobId: `${kind}-1`,
  gameId: 'test',
  kind,
  payload,
  timeoutMs,
});

describe('the worker_threads job pool', () => {
  it('runs a game’s worker module and returns its outcome', async () => {
    const m = modules();
    const pool = workerJobPool({ workers: 1, module: (_game, kind) => (kind === 'double' ? m.double : null) });
    pools.push(pool);
    expect(await pool.run(job('double', { n: 21 }))).toEqual({ ok: true, value: { n: 42 } });
    expect(await pool.run(job('missing'))).toEqual({ ok: false, reason: 'failed' });
  });

  it('wraps a heavy AI’s plain answer as a successful outcome', async () => {
    const m = modules();
    const pool = workerJobPool({ workers: 1, module: () => m.ai });
    pools.push(pool);
    expect(
      await pool.run({
        ...job('ai', { view: { heap: 4 }, seat: 1, level: 'hard', rng: { algorithm: 'sfc32', words: [1, 2, 3, 4] } }),
        answer: 'value',
      }),
    ).toEqual({ ok: true, value: { take: 2 } });
  });

  it('passes the room rules pin to module lookup for ordinary jobs and heavy AI', async () => {
    const m = modules();
    const pool = workerJobPool({
      workers: 1,
      module: (game, kind, version) =>
        game === 'test' && kind === 'ai' ? (version === 1 ? m.ai : version === 2 ? m.double : null) : null,
    });
    pools.push(pool);
    expect(await pool.run({ ...job('ai', { view: { heap: 4 } }), rulesVersion: 1, answer: 'value' })).toEqual({
      ok: true,
      value: { take: 2 },
    });
    expect(await pool.run({ ...job('ai', { n: 21 }), rulesVersion: 2 })).toEqual({ ok: true, value: { n: 42 } });
    expect(await pool.run({ ...job('ai'), rulesVersion: 3 })).toEqual({ ok: false, reason: 'failed' });
  });

  it('times out a stuck job, restarts the worker and keeps serving', async () => {
    const m = modules();
    const pool = workerJobPool({ workers: 1, module: (_game, kind) => (kind === 'hang' ? m.hang : m.double) });
    pools.push(pool);
    expect(await pool.run(job('hang', {}, 100))).toEqual({ ok: false, reason: 'timeout' });
    expect(await pool.run(job('double', { n: 2 }))).toEqual({ ok: true, value: { n: 4 } });
    expect(pool.inFlight).toBe(0);
  });

  it('counts a job’s timeout from when the worker starts it, not from when it was queued', async () => {
    const m = modules();
    const pool = workerJobPool({ workers: 1, module: (_game, kind) => (kind === 'slow' ? m.slow : m.double) });
    pools.push(pool);
    const slow = pool.run(job('slow', { ms: 400 }, 30_000));
    expect(await pool.run(job('double', { n: 5 }, 200))).toEqual({ ok: true, value: { n: 10 } });
    expect(await slow).toEqual({ ok: true, value: {} });
  });

  it('reports the jobs a restart cost as lost, apart from the one that caused it', async () => {
    const m = modules();
    const pool = workerJobPool({
      workers: 1,
      module: (_game, kind) => (kind === 'hang' ? m.hang : kind === 'exit' ? m.exit : m.double),
    });
    pools.push(pool);
    const hung = pool.run(job('hang', {}, 200));
    const queued = pool.run(job('double', { n: 1 }, 30_000));
    expect(await hung).toEqual({ ok: false, reason: 'timeout' });
    expect(await queued).toEqual({ ok: false, reason: 'lost' });
    const exited = pool.run(job('exit', {}, 30_000));
    const behind = pool.run(job('double', { n: 1 }, 30_000));
    expect(await exited).toEqual({ ok: false, reason: 'crashed' });
    expect(await behind).toEqual({ ok: false, reason: 'lost' });
    expect(await pool.run(job('double', { n: 3 }))).toEqual({ ok: true, value: { n: 6 } });
  });

  it('reports a module that throws as failed', async () => {
    const m = modules();
    const log = memoryLogger();
    const pool = workerJobPool({ workers: 1, module: () => m.crash, log });
    pools.push(pool);
    expect(await pool.run(job('crash'))).toEqual({ ok: false, reason: 'failed' });
    expect(log.lines.map((l) => l.event)).toContain('job_failed');
  });

  it('refuses work beyond its bound at once', async () => {
    const m = modules();
    const log = memoryLogger();
    const pool = workerJobPool({ workers: 1, perWorker: 1, module: () => m.hang, log });
    pools.push(pool);
    void pool.run(job('hang', {}, 5_000));
    expect(await pool.run(job('hang', {}, 5_000))).toEqual({ ok: false, reason: 'busy' });
    expect(log.lines.map((l) => l.event)).toContain('job_rejected_busy');
    expect(await pool.idle(10)).toBe(false);
  });
});

describe('the inline job pool', () => {
  it('turns a throwing handler into a failed outcome and reports idleness', async () => {
    const pool = inlineJobPool(() => {
      throw new Error('nope');
    });
    expect(await pool.run(job('x'))).toEqual({ ok: false, reason: 'failed' });
    expect(await pool.idle(10)).toBe(true);
  });
});
