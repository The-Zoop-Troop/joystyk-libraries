import { afterEach, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nim, pinOf, policy, seeds, testRng } from '../__tests__/fixtures.ts';
import { createEngineRegistry } from './registry.ts';
import { createRoomServer, type RoomServer } from './server.ts';
import { openSqliteStore } from './store.ts';

const ORIGIN = 'https://joystyk.test';
const servers: RoomServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.drain();
});

it.each(['creation', 'lookup', 'connections'] as const)('groups IPv6 /64 peers for room %s limits', async (kind) => {
  const store = await openSqliteStore(':memory:');
  const registry = createEngineRegistry([{ pin: pinOf('nim'), engine: nim, policy: policy() }], testRng);
  let seed = 0;
  const server = createRoomServer({
    store,
    registry,
    seeds: () => seeds(++seed),
    publicOrigin: ORIGIN,
    trustedProxy: '127.0.0.1',
    clientIpHeader: 'x-real-ip',
    limits: { roomsPerIpPerHour: 2, joinMissesPerIpPer10Min: 2, connectionsPerIp: 2 },
  });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  const request = async (ip: string): Promise<number> => {
    if (kind === 'connections') {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: ORIGIN, headers: { 'x-real-ip': ip } });
        ws.once('open', () => resolve(101));
        ws.once('error', reject);
        ws.once('unexpected-response', (_req, response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
      });
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms${kind === 'lookup' ? '/ABCDEF' : ''}`, {
      method: kind === 'lookup' ? 'GET' : 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': ip },
      ...(kind === 'lookup' ? {} : { body: JSON.stringify({ game: 'nim', name: 'Ada', config: {} }) }),
    });
    await response.arrayBuffer();
    return response.status;
  };
  const accepted = kind === 'connections' ? 101 : kind === 'creation' ? 201 : 404;
  expect(await request('2001:db8:1:2::1')).toBe(accepted);
  expect(await request('2001:db8:1:2::2')).toBe(accepted);
  expect(await request('2001:0DB8:1:2:0:0:0:ffff')).toBe(429);
  expect(await request('2001:db8:1:3::1')).toBe(accepted);
});
