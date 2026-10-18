import type { Json, Validator } from '@joystyk/contracts';
import { decode } from './solitaire.ts';
/** A short-lived certification worker per request. Every reply is parsed; disposal stops
 * outstanding work and prevents a finished proof from changing an unmounted game. */
export const workerSetup = <C extends Json>(make: () => Worker, schema: Validator<C>) => {
  const active = new Map<Worker, (reason: Error) => void>();
  let disposed = false;
  return {
    prepare: (command: Json): Promise<Json> =>
      new Promise((resolve, reject) => {
        if (disposed) {
          reject(new Error('Disposed'));
          return;
        }
        const worker = make();
        const stop = () => {
          worker.terminate();
          active.delete(worker);
        };
        active.set(worker, reject);
        worker.addEventListener('message', (event: MessageEvent<unknown>) => {
          stop();
          const reply = decode(schema, event.data);
          if (reply === null) reject(new Error('Invalid preparation reply'));
          else resolve(reply);
        });
        worker.addEventListener('error', () => {
          stop();
          reject(new Error('The preparation worker failed'));
        });
        worker.postMessage(command);
      }),
    dispose: () => {
      disposed = true;
      for (const [worker, reject] of active) {
        worker.terminate();
        reject(new Error('Disposed'));
      }
      active.clear();
    },
  };
};
