// Two real WebSocket clients against a real server on port 0 with a temporary SQLite file.
import { ok } from '@joystyk/contracts';
import { checkDisplayName } from '@joystyk/identity/names';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { nim, peek, pinOf, policy, seeds, testRng, type PeekView } from '../__tests__/fixtures.ts';
import { tempDir } from '../__tests__/node-helpers.ts';
import type { CreateRoomResponse, ServerMessage } from '../protocol/index.ts';
import { HostedGamesSchema, PROTOCOL_VERSION, ServerMessageSchema } from '../protocol/index.ts';
import { createEngineRegistry } from './registry.ts';
import { createRoomServer, type RoomServer } from './server.ts';
import { openSqliteStore } from './store.ts';
import { memoryLogger } from './support.ts';

const ORIGIN = 'https://joystyk.test';

class Client {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];
  private actions = 0;

  readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(String(data)));
      if (!parsed.success) throw new Error(`The server sent an invalid message: ${String(data)}`);
      this.messages.push(parsed.data as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
  }

  static open(port: number, origin = ORIGIN): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
      const client = new Client(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  join(room: string, game: string, name: string, token?: string, watch = false): void {
    this.send({
      v: 1,
      t: 'join',
      room,
      game,
      name,
      build: '1.0.0',
      ...(token === undefined ? {} : { token }),
      ...(watch ? { watch } : {}),
    });
  }

  /** The last revision this client saw. */
  get revision(): number {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (m?.t === 'update' || m?.t === 'snapshot') return m.revision;
    }
    return 0;
  }

  act(command: unknown): string {
    this.actions += 1;
    const id = `act-${this.actions}-abcdefgh`;
    this.send({ v: 1, t: 'act', id, rev: this.revision, command });
    return id;
  }

  control(control: unknown): string {
    this.actions += 1;
    const id = `ctl-${this.actions}-abcdefgh`;
    this.send({ v: 1, t: 'control', id, rev: this.revision, control });
    return id;
  }

  /** Waits for a message after `from` that satisfies `test`. */
  async next<T extends ServerMessage['t']>(
    t: T,
    test: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    from = 0,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const found = this.messages
        .slice(from)
        .find((m): m is Extract<ServerMessage, { t: T }> => m.t === t && test(m as Extract<ServerMessage, { t: T }>));
      if (found !== undefined) return found;
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for ${t}; got ${JSON.stringify(this.messages.map((m) => m.t))}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  receipt(id: string) {
    return this.next('receipt', (m) => m.id === id).then((m) => m.result);
  }

  close(): void {
    this.ws.close();
  }
}

const servers: RoomServer[] = [];
const temps: { remove: () => void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.drain();
  for (const t of temps.splice(0)) t.remove();
});

const start = async (file?: string) => {
  const t = tempDir();
  temps.push(t);
  const log = memoryLogger();
  const store = await openSqliteStore(file ?? t.file('rooms.sqlite'));
  const registry = createEngineRegistry(
    [
      {
        pin: pinOf('peek'),
        engine: peek,
        policy: policy({ seats: { min: 2, max: 2 }, maxSpectators: 2, absent: 'wait' }),
      },
      { pin: pinOf('nim'), engine: nim, policy: policy() },
    ],
    testRng,
  );
  let n = 0;
  const server = createRoomServer({
    store,
    registry,
    seeds: () => seeds((n += 1)),
    log,
    publicOrigin: ORIGIN,
    limits: { heartbeatMs: 60_000 },
  });
  servers.push(server);
  const port = await server.listen(0, '127.0.0.1');
  return { server, port, log, file: file ?? t.file('rooms.sqlite') };
};

const create = async (
  port: number,
  body: unknown,
  origin = ORIGIN,
): Promise<{ status: number; body: CreateRoomResponse & { error?: string } }> => {
  const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as CreateRoomResponse & { error?: string } };
};

describe('the room server over WebSockets', () => {
  it('answers health checks and creates rooms with a creator token', async () => {
    const { port } = await start();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    const created = await create(port, { game: 'peek', name: 'Ana', config: { hand: 2 } });
    expect(created.status).toBe(201);
    expect(created.body.room).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(created.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.body.game).toEqual(pinOf('peek'));
    const info = await fetch(`http://127.0.0.1:${port}/api/rooms/${created.body.room}`);
    expect(await info.json()).toEqual({ game: pinOf('peek'), phase: 'lobby', seatsOpen: 1, spectatorsAllowed: true });
    expect((await create(port, { game: 'chess', name: 'Ana' })).status).toBe(404);
    expect((await create(port, { game: 'peek', name: '' })).status).toBe(400);
    expect((await create(port, { game: 'peek', name: 'Ana' }, 'https://evil.test')).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/api/rooms/NOPE22`)).status).toBe(404);
  });

  it('lists the games it hosts and its protocol versions, for the launcher', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms/games`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body: unknown = await res.json();
    expect(HostedGamesSchema.parse(body)).toEqual({
      protocol: PROTOCOL_VERSION,
      protocols: [PROTOCOL_VERSION],
      games: ['peek', 'nim'],
    });
    expect((await fetch(`http://127.0.0.1:${port}/api/rooms/games`, { method: 'POST' })).status).toBe(404);
  });

  it('replaces a refused name with a generated one and tells the client why', async () => {
    const { port } = await start();
    const kept = await create(port, { game: 'peek', name: 'Ada   Byte', config: { hand: 2 } });
    expect(kept.status).toBe(201);
    expect(kept.body.name).toBe('Ada Byte');
    expect(kept.body.notice).toBeUndefined();

    // Over HTTP: the creator's seat gets a generated name and the response says why.
    const { status, body } = await create(port, { game: 'peek', name: 'Fox 69', config: { hand: 2 } });
    expect(status).toBe(201);
    expect(body.name).not.toBe('Fox 69');
    expect(checkDisplayName(body.name)).toEqual(ok(body.name));
    expect(body.notice).toEqual({
      code: 'name-replaced',
      message: `That name isn't allowed. Try another, or roll a random one. You're playing as ${body.name}.`,
    });

    const ana = await Client.open(port);
    ana.join(body.room, 'peek', 'Fox 69', body.token);
    expect((await ana.next('snapshot')).seats[0]?.name).toBe(body.name);

    // Over WebSockets: the joining player is welcomed, told, and shown under the new name.
    const ben = await Client.open(port);
    ben.join(body.room, 'peek', 'xX');
    expect((await ben.next('welcome')).seat).toBe(1);
    const notice = await ben.next('notice');
    expect(notice.code).toBe('name-replaced');
    expect(notice.message).toMatch(/^Names need at least 3 characters\. You're playing as .+\.$/);
    const snapshot = await ben.next('snapshot');
    const name = snapshot.seats[1]?.name ?? '';
    expect(name).not.toBe('xX');
    expect(checkDisplayName(name)).toEqual(ok(name));
    expect(notice.message).toContain(name);
    expect((await ana.next('update', (m) => m.seats?.[1]?.claimed === true)).seats?.[1]?.name).toBe(name);
    expect(ana.messages.filter((m) => m.t === 'notice')).toEqual([]);
  });

  it('plays a match: join, play, reconnect with the seat token, newest tab wins, spectators see no hands', async () => {
    const { port } = await start();
    const { body } = await create(port, { game: 'peek', name: 'Ana', config: { hand: 2 } });
    const room = body.room;

    const ana = await Client.open(port);
    ana.join(room, 'peek', 'Ana', body.token);
    expect((await ana.next('welcome')).seat).toBe(0);
    await ana.next('snapshot');

    const ben = await Client.open(port);
    ben.join(room, 'peek', 'Ben');
    const welcome = await ben.next('welcome');
    expect(welcome.seat).toBe(1);
    const benToken = welcome.token!;
    expect(benToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await ben.next('snapshot');
    expect((await ana.next('update')).seats?.[1]?.claimed).toBe(true);

    expect(await ana.receipt(ana.control({ kind: 'ready', ready: true }))).toMatchObject({ status: 'accepted' });
    await ben.next('update', (m) => m.revision === ana.revision);
    expect(await ben.receipt(ben.control({ kind: 'ready', ready: true }))).toMatchObject({ status: 'accepted' });
    await ana.next('update', (m) => m.revision === ben.revision);
    expect(await ana.receipt(ana.control({ kind: 'start' }))).toMatchObject({ status: 'accepted' });
    const anaStart = await ana.next('snapshot', (m) => m.phase === 'playing');
    const benStart = await ben.next('snapshot', (m) => m.phase === 'playing');
    const anaHand = (anaStart.view as PeekView).hand!;
    const benHand = (benStart.view as PeekView).hand!;
    expect(anaHand).toHaveLength(2);
    for (const card of anaHand) expect((benStart.view as PeekView).hand).not.toContain(card);

    const played = ana.act({ play: anaHand[0] });
    expect(await ana.receipt(played)).toMatchObject({ status: 'accepted' });
    const update = await ben.next('update', (m) => m.beats.length > 0);
    expect(update.beats[0]?.event).toEqual({ type: 'played', seat: 0, card: anaHand[0] });

    const watcher = await Client.open(port);
    watcher.join(room, 'peek', 'Cy', undefined, true);
    expect((await watcher.next('welcome')).seat).toBeNull();
    const watched = await watcher.next('snapshot');
    expect((watched.view as PeekView).hand).toBeNull();
    expect(JSON.stringify(watched)).not.toContain(`[${benHand.join(',')}]`);
    expect(await watcher.receipt(watcher.act({ play: 1 }))).toMatchObject({ status: 'rejected', code: 'spectator' });

    // Ben's connection drops; he reconnects with his token and keeps his seat.
    ben.close();
    await ben.closed;
    const ben2 = await Client.open(port);
    ben2.join(room, 'peek', 'Ben', benToken);
    const rewelcome = await ben2.next('welcome');
    expect(rewelcome.seat).toBe(1);
    expect(rewelcome.token).toBeUndefined();
    expect(((await ben2.next('snapshot')).view as PeekView).hand).toEqual(benHand);

    // A second tab with the same token takes the seat; the first is told and closed.
    const ben3 = await Client.open(port);
    ben3.join(room, 'peek', 'Ben', benToken);
    await ben3.next('welcome');
    await ben3.next('snapshot');
    await ben2.next('replaced');
    expect((await ben2.closed).code).toBe(4001);
    const move = ben3.act({ play: benHand[0] });
    expect(await ben3.receipt(move)).toMatchObject({ status: 'accepted' });
    await ana.next('update', (m) => m.beats.some((b) => (b.event as { seat?: number }).seat === 1));

    ana.close();
    ben3.close();
    watcher.close();
  });

  it('refuses malformed, oversized and unknown-room messages without crashing', async () => {
    const { port } = await start();
    const client = await Client.open(port);
    client.ws.send('not json');
    expect((await client.next('notice')).code).toBe('bad-message');
    client.send({ v: 1, t: 'act', id: 'whatever-1', rev: 0, command: {} });
    expect((await client.next('notice', (m) => m.message.includes('Join'))).code).toBe('bad-message');
    client.send({ v: 9, t: 'resync' });
    expect((await client.next('notice', (m) => m.code === 'protocol-unsupported')).code).toBe('protocol-unsupported');
    expect((await client.closed).code).toBe(4008);

    const lost = await Client.open(port);
    lost.join('ZZZZZZ', 'peek', 'Ana');
    expect((await lost.next('notice')).code).toBe('no-such-room');
    expect((await lost.closed).code).toBe(4004);

    const big = await Client.open(port);
    big.ws.send('x'.repeat(5000));
    expect((await big.closed).code).toBe(1009);

    await expect(Client.open(port, 'https://evil.test')).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  });

  it('drains: clients hear closing and 1012, and the room resumes on a new server', async () => {
    const first = await start();
    const { body } = await create(first.port, { game: 'nim', name: 'Ana', config: { heap: 7 } });
    const ana = await Client.open(first.port);
    ana.join(body.room, 'nim', 'Ana', body.token);
    await ana.next('snapshot');
    const ready = ana.control({ kind: 'ready', ready: true });
    await ana.receipt(ready);
    const server = servers.splice(0)[0]!;
    await server.drain();
    expect((await ana.next('closing')).reason).toBe('restart');
    expect((await ana.closed).code).toBe(1012);
    expect(first.log.lines.map((l) => l.event)).toEqual(expect.arrayContaining(['drain_started', 'drain_finished']));

    const second = await start(first.file);
    const again = await Client.open(second.port);
    again.join(body.room, 'nim', 'Ana', body.token);
    const snapshot = await again.next('snapshot');
    expect(snapshot.seat).toBe(0);
    expect(snapshot.seats[0]?.ready).toBe(true);
    // A retried control finds its receipt across the restart.
    again.send({ v: 1, t: 'control', id: ready, rev: 0, control: { kind: 'ready', ready: true } });
    expect(await again.receipt(ready)).toEqual({ status: 'accepted', revision: snapshot.revision });
    again.close();
  });
});

describe('room creation limits', () => {
  it('limits rooms per address', async () => {
    const { port } = await start();
    const results: number[] = [];
    for (let i = 0; i < 21; i += 1)
      results.push((await create(port, { game: 'nim', name: 'Ana', config: { heap: 5 } })).status);
    expect(results.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(results[20]).toBe(429);
  });
});
