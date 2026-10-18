import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nim, pinOf, policy, seeds, testRng } from '../__tests__/fixtures.ts';
import { createEngineRegistry } from './registry.ts';
import { createRoomServer, type RoomServer } from './server.ts';
import { openSqliteStore } from './store.ts';
import { memoryLogger } from './support.ts';

const ORIGIN = 'https://joystyk.test';
const servers: RoomServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.drain();
});

it('returns a safe initialization error and logs its detail under the same reference', async () => {
  const log = memoryLogger();
  const engine = {
    ...nim,
    init: () => {
      throw new Error('private engine detail');
    },
  };
  const registry = createEngineRegistry(
    [{ pin: pinOf('nim'), engine, policy: policy({ start: 'immediate' }) }],
    testRng,
  );
  const store = await openSqliteStore(':memory:');
  const server = createRoomServer({ store, registry, log, seeds: () => seeds(1), publicOrigin: ORIGIN });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'nim', name: 'Ada', config: { heap: 10 } }),
  });
  const body = await response.text();
  expect(body).not.toContain('private engine detail');
  expect(response.status).toBe(400);
  const failure = log.lines.find((line) => line.event === 'room_init_failed');
  expect(failure?.fields['error']).toContain('private engine detail');
  expect(failure?.fields['reference']).toEqual(expect.any(String));
  expect(body).toContain(String(failure?.fields['reference']));
  expect(server.host.rooms.size).toBe(0);
});

it('expires old message strikes while still closing a sustained burst', async () => {
  let now = 0;
  const store = await openSqliteStore(':memory:');
  const registry = createEngineRegistry([{ pin: pinOf('nim'), engine: nim, policy: policy() }], testRng);
  const server = createRoomServer({
    store,
    registry,
    log: memoryLogger(),
    seeds: () => seeds(1),
    publicOrigin: ORIGIN,
    clock: { now: () => now, setTimer: () => ({ cancel() {} }) },
    limits: { messageBurst: 1, messagesPerSecond: 1, rateStrikes: 2 },
  });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: ORIGIN });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const send = (): Promise<{ code: string | number }> =>
    new Promise((resolve) => {
      const message = (data: unknown): void => {
        ws.off('close', closed);
        resolve(JSON.parse(String(data)) as { code: string });
      };
      const closed = (code: number): void => {
        ws.off('message', message);
        resolve({ code });
      };
      ws.once('message', message);
      ws.once('close', closed);
      ws.send('{}');
    });
  expect((await send()).code).toBe('bad-message');
  expect((await send()).code).toBe('too-fast');
  expect((await send()).code).toBe('too-fast');
  now = 60_000;
  expect((await send()).code).toBe('bad-message');
  expect((await send()).code).toBe('too-fast');
  expect((await send()).code).toBe('too-fast');
  expect((await send()).code).toBe(4008);
});
