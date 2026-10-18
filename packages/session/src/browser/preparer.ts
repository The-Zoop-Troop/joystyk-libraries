import { err, gameError, type AsyncPreparer, type Json, type Result, type Validator } from '@joystyk/contracts';

/** A one-request worker, with cancellation and a validated response at the browser boundary. */
export function workerPreparer<S extends Json, C extends Json>(
  setup: Validator<S>,
  config: Validator<C>,
  createWorker: () => Worker,
): AsyncPreparer<S, C> {
  let disposed = false;
  const pending = new Map<Worker, (result: Result<C>) => void>();
  const reply: Validator<Result<C>> = {
    '~standard': {
      version: 1,
      vendor: 'joystyk',
      validate: async (value) => {
        if (typeof value !== 'object' || value === null) return { issues: [{ message: 'Invalid preparer reply.' }] };
        const row = value as Record<string, unknown>;
        if (row['ok'] === true) {
          const decoded = await config['~standard'].validate(row['value']);
          return decoded.issues === undefined ? { value: { ok: true, value: decoded.value } } : decoded;
        }
        if (row['ok'] === false && typeof row['error'] === 'object' && row['error'] !== null) {
          const error = row['error'] as Record<string, unknown>;
          if (typeof error['code'] === 'string' && typeof error['message'] === 'string')
            return { value: err(gameError(error['code'], error['message'])) };
        }
        return { issues: [{ message: 'Invalid preparer reply.' }] };
      },
    },
  };
  return {
    setup,
    prepare: async (choice, rng) => {
      if (disposed) return err(gameError('Disposed', 'The game was closed.'));
      const decoded = await setup['~standard'].validate(choice);
      if (decoded.issues !== undefined) return err(gameError('BadSetup', 'The game setup could not be read.'));
      if (disposed) return err(gameError('Disposed', 'The game was closed.'));
      return new Promise<Result<C>>((resolve) => {
        let worker: Worker;
        try {
          worker = createWorker();
        } catch {
          resolve(err(gameError('WorkerFailed', 'The game could not be prepared. Try again.')));
          return;
        }
        const finish = (result: Result<C>) => {
          if (!pending.delete(worker)) return;
          worker.terminate();
          resolve(result);
        };
        pending.set(worker, finish);
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
          void Promise.resolve(reply['~standard'].validate(event.data)).then(
            (parsed) =>
              finish(
                parsed.issues === undefined
                  ? parsed.value
                  : err(gameError('BadConfig', 'The prepared game could not be read.')),
              ),
            () => finish(err(gameError('BadConfig', 'The prepared game could not be read.'))),
          );
        });
        worker.addEventListener('error', () =>
          finish(err(gameError('WorkerFailed', 'The game worker could not finish.'))),
        );
        worker.addEventListener('messageerror', () =>
          finish(err(gameError('BadConfig', 'The prepared game could not be read.'))),
        );
        try {
          worker.postMessage({ setup: decoded.value, seed: rng.save() });
        } catch {
          finish(err(gameError('WorkerFailed', 'The game could not be prepared. Try again.')));
        }
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const finish of pending.values()) finish(err(gameError('Disposed', 'The game was closed.')));
    },
  };
}
