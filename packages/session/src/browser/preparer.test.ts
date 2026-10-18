import { createRng } from '@joystyk/kit';
import type { Validator } from '@joystyk/contracts';
import { expect, it, vi } from 'vitest';
import { workerPreparer } from './preparer.ts';

const number: Validator<number> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => (typeof value === 'number' ? { value } : { issues: [{ message: 'Not a number.' }] }),
  },
};
class FakeWorker extends EventTarget {
  sent: unknown;
  terminated = false;
  postMessage(value: unknown) {
    this.sent = value;
  }
  terminate() {
    this.terminated = true;
  }
  reply(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
}
const fixture = () => {
  const worker = new FakeWorker();
  const bridge = workerPreparer(number, number, () => worker as unknown as Worker);
  return { worker, bridge };
};

it('sends the original seeded stream and validates the result', async () => {
  const { worker, bridge } = fixture();
  const rng = createRng('launch');
  const result = bridge.prepare(3, rng);
  await vi.waitFor(() => expect(worker.sent).toEqual({ setup: 3, seed: rng.save() }));
  worker.reply({ ok: true, value: 7 });
  expect(await result).toEqual({ ok: true, value: 7 });
  expect(worker.terminated).toBe(true);
  bridge.dispose();
});

it.each([null, { ok: true, value: 'bad' }, { ok: false, error: { message: 3 } }])(
  'rejects malformed replies: %j',
  async (value) => {
    const { worker, bridge } = fixture();
    const result = bridge.prepare(3, createRng('launch'));
    await vi.waitFor(() => expect(worker.sent).toBeDefined());
    worker.reply(value);
    expect(await result).toMatchObject({ ok: false, error: { code: 'BadConfig' } });
    expect(worker.terminated).toBe(true);
    bridge.dispose();
  },
);

it('cancels before a late result can publish and refuses reuse', async () => {
  const { worker, bridge } = fixture();
  const result = bridge.prepare(3, createRng('launch'));
  await vi.waitFor(() => expect(worker.sent).toBeDefined());
  bridge.dispose();
  worker.reply({ ok: true, value: 7 });
  expect(await result).toMatchObject({ ok: false, error: { code: 'Disposed' } });
  expect(worker.terminated).toBe(true);
  bridge.dispose();
  expect(await bridge.prepare(3, createRng('again'))).toMatchObject({ ok: false, error: { code: 'Disposed' } });
});

it('returns a recoverable failure if the worker crashes', async () => {
  const { worker, bridge } = fixture();
  const result = bridge.prepare(3, createRng('launch'));
  await vi.waitFor(() => expect(worker.sent).toBeDefined());
  worker.dispatchEvent(new Event('error'));
  expect(await result).toMatchObject({ ok: false, error: { code: 'WorkerFailed' } });
  expect(worker.terminated).toBe(true);
  bridge.dispose();
});
