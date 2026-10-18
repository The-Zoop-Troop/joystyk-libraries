// The room server's HTTP and WebSocket front (room-server.md sections 4, 5 and 8): limits,
// decoding, room creation, health checks and draining. Everything that changes a room goes
// through RoomHost.dispatch.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Json, StandardSchemaV1 } from '@joystyk/contracts';
import { rateLimitKey } from '@joystyk/ops';
import { checkDisplayName } from '@joystyk/identity/names';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  ClientMessageSchema,
  CloseCode,
  CreateRoomRequestSchema,
  isSupportedProtocol,
  PROTOCOL_VERSION,
  RejectionCode,
  RoomCode as RoomCodeSchema,
  SUPPORTED_PROTOCOLS,
  type CreateRoomResponse,
  type HostedGames,
  type NoticeCode,
  type RoomInfo,
  type ServerMessage,
} from '../protocol/index.ts';
import { nameReplacedMessage } from '../names.ts';
import type { MatchSeeds, RoomCode } from '../types.ts';
import { RoomHost, type Connection } from './host.ts';
import { inlineJobPool, type JobPool } from './jobs.ts';
import type { EngineRegistry } from './registry.ts';
import { expiresAt, type RoomStore } from './store.ts';
import {
  clientAddress,
  createLogger,
  hashToken,
  newRoomCode,
  newSeatToken,
  parseTrustedProxy,
  systemClock,
  TokenBucket,
  WindowCounter,
  type Clock,
  type Logger,
} from './support.ts';

export type ServerLimits = {
  /** Incoming message size in bytes (`ws` maxPayload). */
  readonly maxPayload: number;
  readonly messagesPerSecond: number;
  readonly messageBurst: number;
  /** Over-limit messages tolerated before closing with 4008. */
  readonly rateStrikes: number;
  /** Only over-limit messages within this rolling window count toward closing. */
  readonly rateStrikeWindowMs: number;
  readonly roomsPerIpPerHour: number;
  readonly joinMissesPerIpPer10Min: number;
  readonly connectionsPerIp: number;
  readonly maxConnections: number;
  readonly maxRooms: number;
  readonly outgoingBufferBytes: number;
  readonly heartbeatMs: number;
  readonly idleUnloadMs: number;
  readonly maintenanceMs: number;
  readonly createBodyBytes: number;
  readonly drainJobsMs: number;
  readonly persistRetryMs: number;
  /** How long a heavy AI may choose on the pool before its seat times out. */
  readonly aiTimeoutMs: number;
};

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  maxPayload: 2048,
  messagesPerSecond: 10,
  messageBurst: 20,
  rateStrikes: 20,
  rateStrikeWindowMs: 60_000,
  roomsPerIpPerHour: 20,
  joinMissesPerIpPer10Min: 20,
  connectionsPerIp: 16,
  maxConnections: 2000,
  maxRooms: 1000,
  outgoingBufferBytes: 256 * 1024,
  heartbeatMs: 25_000,
  idleUnloadMs: 10 * 60_000,
  maintenanceMs: 60_000,
  createBodyBytes: 4096,
  drainJobsMs: 10_000,
  persistRetryMs: 5_000,
  aiTimeoutMs: 30_000,
};

export type RoomServerOptions = {
  readonly store: RoomStore;
  readonly registry: EngineRegistry;
  /** Fresh engine and AI seeds from the CSPRNG, in the rng algorithm the registry's cores use. */
  readonly seeds: () => MatchSeeds;
  readonly pool?: JobPool;
  readonly clock?: Clock;
  readonly log?: Logger;
  /** Exactly this origin may create rooms and open sockets. Null allows any (development only). */
  readonly publicOrigin?: string | null;
  /** Extra origins allowed in development, such as the Vite dev server. */
  readonly devOrigins?: readonly string[];
  /** Traefik's address or CIDR range; only it may report the client address. */
  readonly trustedProxy?: string | null;
  /** The header Traefik reports the client address in; otherwise the last X-Forwarded-For entry. */
  readonly clientIpHeader?: string | null;
  readonly limits?: Partial<ServerLimits>;
};

export interface RoomServer {
  readonly http: Server;
  readonly host: RoomHost;
  /** Listens and resumes rooms with outstanding jobs. Resolves with the bound port. */
  listen(port: number, hostname?: string): Promise<number>;
  /** SIGTERM: refuse new work, let jobs finish, tell clients to reconnect, close the store. */
  drain(): Promise<void>;
}

type ConnState = Connection & {
  readonly socket: WebSocket;
  readonly ip: string;
  readonly bucket: TokenBucket;
  room: RoomCode | null;
  strikes: number[];
  alive: boolean;
};

/** Validates synchronously; schemas that answer with a Promise are refused (they would reorder messages). */
const validate = <T>(schema: StandardSchemaV1<unknown, T>, value: unknown): { ok: true; value: T } | { ok: false } => {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise || result.issues !== undefined) return { ok: false };
  return { ok: true, value: result.value };
};

export const createRoomServer = (options: RoomServerOptions): RoomServer => {
  const limits: ServerLimits = { ...DEFAULT_SERVER_LIMITS, ...options.limits };
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLogger();
  const pool = options.pool ?? inlineJobPool(() => ({ ok: false, reason: 'failed' }));
  const { store, registry } = options;
  const trusted = options.trustedProxy ? parseTrustedProxy(options.trustedProxy) : null;
  const header = options.clientIpHeader ?? null;
  const publicOrigin = options.publicOrigin ?? null;
  const allowedOrigins = new Set([...(publicOrigin === null ? [] : [publicOrigin]), ...(options.devOrigins ?? [])]);

  let draining = false;
  let connSequence = 0;
  const host = new RoomHost({
    store,
    registry,
    clock,
    pool,
    log,
    maxRooms: limits.maxRooms,
    outgoingBufferBytes: limits.outgoingBufferBytes,
    persistRetryMs: limits.persistRetryMs,
    aiTimeoutMs: limits.aiTimeoutMs,
    draining: () => draining,
  });
  const creations = new WindowCounter(3_600_000, limits.roomsPerIpPerHour);
  const misses = new WindowCounter(600_000, limits.joinMissesPerIpPer10Min);
  const perIp = new Map<string, number>();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxPayload,
    perMessageDeflate: { threshold: 1024 },
  });

  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined) return true; // Not a browser: curl, server-to-server, tests.
    if (publicOrigin === null) return true;
    return allowedOrigins.has(origin);
  };

  const rateLimited = (limit: string): void => log.write('warn', 'rate_limited', { limit });

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────

  const json = (res: ServerResponse, status: number, value: Json, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
  };

  const readBody = (req: IncomingMessage, max: number): Promise<string | null> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > max) {
          done = true;
          resolve(null);
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', () => {
        if (!done) resolve(null);
      });
    });

  const createRoom = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (draining)
      return json(res, 503, { error: 'The server is restarting. Try again in a moment.' }, { 'retry-after': '5' });
    if (!originAllowed(req.headers.origin)) return json(res, 403, { error: 'Origin refused.' });
    const body = await readBody(req, limits.createBodyBytes);
    if (body === null) return json(res, 413, { error: 'The request is too large.' });
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'The request is not JSON.' });
    }
    const parsed = CreateRoomRequestSchema.safeParse(raw);
    if (!parsed.success) return json(res, 400, { error: 'The request is not valid.' });
    const request = parsed.data;
    const now = clock.now();
    const ip = rateLimitKey(clientAddress(req, trusted, header));
    if (!creations.allow(ip, now)) {
      rateLimited('rooms-per-ip');
      return json(res, 429, { error: 'Too many rooms. Try again later.' }, { 'retry-after': '600' });
    }
    if (host.rooms.size >= limits.maxRooms)
      return json(res, 503, { error: 'The server is full. Try again soon.' }, { 'retry-after': '30' });
    const current = registry.current(request.game);
    if (current === null) return json(res, 404, { error: 'That game has no online rooms.' });
    const config = validate(current.core.engine.schemas.config, request.config ?? {});
    if (!config.ok) return json(res, 400, { error: 'That game configuration is not valid.' });
    // A per-move clock and a bank exclude each other: choosing one turns the other off.
    const { decisionMs, bank } = request.settings ?? {};
    let policy = current.policy;
    if (decisionMs !== undefined) policy = { ...policy, decisionMs, ...(decisionMs === null ? {} : { bank: null }) };
    if (bank !== undefined) policy = { ...policy, bank, ...(bank === null ? {} : { decisionMs: null }) };
    let code = newRoomCode();
    while (store.exists(code)) code = newRoomCode();
    const token = newSeatToken();
    // The core filters the name and generates one in place of a refused name; the check here
    // only words the notice.
    const created = current.core.create(
      {
        code,
        policy,
        config: config.value,
        seeds: options.seeds(),
        creator: { name: request.name, tokenHash: hashToken(token) },
      },
      now,
    );
    if (!created.ok) {
      if (created.error.diagnostic !== undefined)
        log.write('error', 'room_init_failed', { game: current.pin.id, ...created.error.diagnostic });
      return json(res, 400, { error: created.error.message });
    }
    store.insert(created.value);
    log.write('info', 'room_created', { room: code, game: current.pin.id, rules: current.pin.rulesVersion });
    const name = created.value.seats[0]?.claim?.name ?? request.name;
    const checked = checkDisplayName(request.name);
    const response: CreateRoomResponse = {
      room: code,
      token,
      name,
      ...(checked.ok ? {} : { notice: { code: 'name-replaced', message: nameReplacedMessage(checked.error, name) } }),
      game: current.pin,
      expiresAt: expiresAt(created.value),
    };
    json(res, 201, response);
  };

  const roomInfo = (req: IncomingMessage, res: ServerResponse, code: string): void => {
    const ip = rateLimitKey(clientAddress(req, trusted, header));
    const now = clock.now();
    if (!misses.allow(ip, now, false)) {
      rateLimited('join-misses');
      return json(res, 429, { error: 'Too many unknown rooms. Try again later.' });
    }
    const record = RoomCodeSchema.safeParse(code).success
      ? (host.rooms.get(code)?.room.record ?? store.load(code))
      : null;
    if (record === null || record.phase === 'closed') {
      misses.hit(ip, now);
      return json(res, 404, { error: 'No such room.' });
    }
    const open =
      record.phase === 'lobby'
        ? record.seats.filter((s) => s.claim === null && s.controller === 'human').length
        : record.policy.lateJoin === 'take-ai-seat'
          ? record.seats.filter((s) => s.claim === null && s.controller === 'ai').length
          : 0;
    const info: RoomInfo = {
      game: record.match?.game ?? record.game,
      phase: record.phase,
      seatsOpen: open,
      spectatorsAllowed: record.policy.maxSpectators > 0,
    };
    json(res, 200, info);
  };

  /** The games this build opens rooms for, and its protocol versions. Cheap and public, so it may be cached briefly. */
  const hostedGames = (res: ServerResponse): void => {
    const hosted: HostedGames = {
      protocol: PROTOCOL_VERSION,
      protocols: [...SUPPORTED_PROTOCOLS],
      games: [...registry.games()],
    };
    json(res, 200, hosted, { 'cache-control': 'public, max-age=60' });
  };

  const http = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://rooms.invalid');
    const path = url.pathname;
    const route = async (): Promise<void> => {
      if (path === '/healthz') return json(res, 200, { ok: true });
      if (path === '/readyz')
        return draining || !store.ping() ? json(res, 503, { ok: false }) : json(res, 200, { ok: true });
      if (path === '/api/rooms' && req.method === 'POST') return createRoom(req, res);
      // Before the room-code route: "games" is never a code (codes are six capitals and digits).
      if (path === '/api/rooms/games' && req.method === 'GET') return hostedGames(res);
      const match = /^\/api\/rooms\/([^/]+)$/.exec(path);
      if (match !== null && req.method === 'GET') return roomInfo(req, res, match[1] ?? '');
      json(res, 404, { error: 'Not found.' });
    };
    route().catch((error: unknown) => {
      log.write('error', 'http_error', { path, error: String(error) });
      if (!res.headersSent) json(res, 500, { error: 'The room server could not complete this request.' });
      else res.end();
    });
  });

  // ── WebSockets ────────────────────────────────────────────────────────────────────────

  const refuseUpgrade = (socket: Duplex, status: string, extra = ''): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
  };

  http.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://rooms.invalid').pathname;
    if (path !== '/ws') return refuseUpgrade(socket, '404 Not Found');
    if (draining) return refuseUpgrade(socket, '503 Service Unavailable', 'Retry-After: 5\r\n');
    if (!originAllowed(req.headers.origin)) return refuseUpgrade(socket, '403 Forbidden');
    if (sockets.clients.size >= limits.maxConnections)
      return refuseUpgrade(socket, '503 Service Unavailable', 'Retry-After: 10\r\n');
    const ip = rateLimitKey(clientAddress(req, trusted, header));
    if ((perIp.get(ip) ?? 0) >= limits.connectionsPerIp) {
      rateLimited('connections-per-ip');
      return refuseUpgrade(socket, '429 Too Many Requests');
    }
    sockets.handleUpgrade(req, socket, head, (ws) => accept(ws, ip));
  });

  const notice = (conn: ConnState, code: NoticeCode, message: string): void => {
    conn.send(JSON.stringify({ v: conn.protocol, t: 'notice', code, message } satisfies ServerMessage));
  };

  /** Connection state per socket, for the heartbeat. */
  const connOf = new WeakMap<WebSocket, ConnState>();

  const accept = (ws: WebSocket, ip: string): void => {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    connSequence += 1;
    const conn: ConnState = {
      id: `conn-${connSequence}`,
      protocol: PROTOCOL_VERSION,
      pendingToken: null,
      socket: ws,
      ip,
      bucket: new TokenBucket(limits.messagesPerSecond, limits.messageBurst, clock.now()),
      room: null,
      strikes: [],
      alive: true,
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: (code, reason) => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
          ws.close(code, reason.slice(0, 120));
      },
    };
    connOf.set(ws, conn);
    ws.on(
      'pong', // ip-note: the WebSocket heartbeat frame, not the game
      () => {
        conn.alive = true;
      },
    );
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      const count = (perIp.get(ip) ?? 1) - 1;
      if (count <= 0) perIp.delete(ip);
      else perIp.set(ip, count);
      if (conn.room === null) return;
      const live = host.rooms.get(conn.room);
      if (live?.conns.get(conn.id) !== conn) return;
      live.conns.delete(conn.id);
      if (live.conns.size === 0) live.idleSince = clock.now();
      host.dispatch(conn.room, { type: 'leave', conn: conn.id });
    });
  };

  const onMessage = (conn: ConnState, data: RawData, isBinary: boolean): void => {
    const now = clock.now();
    if (!conn.bucket.take(now)) {
      conn.strikes = conn.strikes.filter((at) => at > now - limits.rateStrikeWindowMs);
      conn.strikes.push(now);
      if (conn.strikes.length > limits.rateStrikes) {
        rateLimited('messages');
        conn.close(CloseCode.policy, 'too fast');
      } else {
        notice(conn, 'too-fast', 'Slow down.');
      }
      return;
    }
    if (isBinary) return notice(conn, 'bad-message', 'Messages are JSON text.');
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return notice(conn, 'bad-message', 'That message is not JSON.');
    }
    const version = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined;
    if (typeof version === 'number' && !isSupportedProtocol(version)) {
      notice(conn, 'protocol-unsupported', 'Reload the page to get the latest version.');
      conn.close(CloseCode.policy, 'protocol unsupported');
      return;
    }
    const parsed = ClientMessageSchema.safeParse(raw);
    if (!parsed.success) return notice(conn, 'bad-message', 'That message is not valid.');
    const message = parsed.data;
    if (message.t === 'join') return join(conn, message, now);
    const code = conn.room;
    const live = code === null ? undefined : host.rooms.get(code);
    if (code === null || live === undefined) return notice(conn, 'bad-message', 'Join a room first.');
    switch (message.t) {
      case 'act': {
        const command = validate(live.core.engine.schemas.command, message.command);
        if (!command.ok) {
          conn.send(
            JSON.stringify({
              v: conn.protocol,
              t: 'receipt',
              id: message.id,
              result: {
                status: 'rejected',
                code: RejectionCode.badCommand,
                message: 'That move is not valid.',
                revision: live.room.record.revision,
              },
            } satisfies ServerMessage),
          );
          return;
        }
        host.dispatch(code, {
          type: 'act',
          conn: conn.id,
          id: message.id,
          expectedRevision: message.rev,
          command: command.value,
        });
        return;
      }
      case 'control': {
        let control = message.control;
        if (control.kind === 'settings' && control.config !== undefined) {
          const engine = registry.current(live.room.record.game.id)?.core.engine ?? live.core.engine;
          const config = validate(engine.schemas.config, control.config);
          if (!config.ok) {
            conn.send(
              JSON.stringify({
                v: conn.protocol,
                t: 'receipt',
                id: message.id,
                result: {
                  status: 'rejected',
                  code: RejectionCode.badCommand,
                  message: 'Those settings are not valid.',
                  revision: live.room.record.revision,
                },
              } satisfies ServerMessage),
            );
            return;
          }
          control = { ...control, config: config.value };
        }
        host.dispatch(code, {
          type: 'control',
          conn: conn.id,
          id: message.id,
          expectedRevision: message.rev,
          control,
          seeds: options.seeds(),
        });
        return;
      }
      case 'resync':
        host.dispatch(code, { type: 'resync', conn: conn.id });
        return;
    }
  };

  const join = (
    conn: ConnState,
    message: Extract<ReturnType<typeof ClientMessageSchema.parse>, { t: 'join' }>,
    now: number,
  ): void => {
    if (conn.room !== null) return notice(conn, 'bad-message', 'This connection already joined a room.');
    conn.protocol = message.v;
    if (!misses.allow(conn.ip, now, false)) {
      rateLimited('join-misses');
      notice(conn, 'too-fast', 'Too many unknown rooms. Try again later.');
      conn.close(CloseCode.policy, 'too many misses');
      return;
    }
    if (draining) {
      conn.send(
        JSON.stringify({
          v: conn.protocol,
          t: 'closing',
          reason: 'restart',
          retryAfterMs: 2000,
        } satisfies ServerMessage),
      );
      conn.close(CloseCode.restarting, 'restarting');
      return;
    }
    let loaded: ReturnType<RoomHost['load']>;
    try {
      loaded = host.load(message.room);
    } catch (error) {
      log.write('error', 'room_load_failed', { room: message.room, error: String(error) });
      loaded = { problem: 'busy' };
    }
    if ('problem' in loaded) {
      if (loaded.problem === 'busy') {
        notice(conn, 'server-busy', 'The server is busy. Try again soon.');
        conn.close(CloseCode.tryAgainLater, 'busy');
      } else if (loaded.problem === 'engine-missing') {
        conn.send(
          JSON.stringify({
            v: conn.protocol,
            t: 'closing',
            reason: 'closed',
            retryAfterMs: null,
          } satisfies ServerMessage),
        );
        conn.close(CloseCode.noSuchRoom, 'closed');
      } else {
        misses.hit(conn.ip, now);
        notice(conn, 'no-such-room', 'This room has closed.');
        conn.close(CloseCode.noSuchRoom, 'no such room');
      }
      return;
    }
    const live = loaded.live;
    if (live.room.record.game.id !== message.game) {
      misses.hit(conn.ip, now);
      notice(conn, 'no-such-room', 'This room has closed.');
      conn.close(CloseCode.noSuchRoom, 'no such room');
      return;
    }
    conn.room = message.room;
    live.conns.set(conn.id, conn);
    const fresh = newSeatToken();
    conn.pendingToken = fresh;
    host.dispatch(message.room, {
      type: 'join',
      conn: conn.id,
      name: message.name,
      protocol: message.v,
      presentedTokenHash: message.token === undefined ? null : hashToken(message.token),
      freshTokenHash: hashToken(fresh),
      watch: message.watch ?? false,
    });
    conn.pendingToken = null;
  };

  // ── Timers, start-up and draining ─────────────────────────────────────────────────────

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let maintenance: ReturnType<typeof setInterval> | null = null;

  const startTimers = (): void => {
    heartbeat = setInterval(() => {
      for (const ws of sockets.clients) {
        const conn = connOf.get(ws);
        if (conn === undefined) continue;
        if (!conn.alive) {
          ws.terminate();
          continue;
        }
        conn.alive = false;
        ws.ping();
      }
    }, limits.heartbeatMs);
    maintenance = setInterval(() => {
      const now = clock.now();
      creations.prune(now);
      misses.prune(now);
      host.sweep(limits.idleUnloadMs);
      try {
        const pruned = store.prune(now);
        if (pruned > 0) log.write('info', 'rooms_pruned', { rooms: pruned });
      } catch (error) {
        log.write('error', 'prune_failed', { error: String(error) });
      }
    }, limits.maintenanceMs);
    heartbeat.unref();
    maintenance.unref();
  };

  const listen = async (port: number, hostname = '0.0.0.0'): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, hostname, () => {
        http.off('error', reject);
        resolve();
      });
    });
    startTimers();
    // Resume on start: rooms with an outstanding job load now, so the job re-runs at once.
    for (const code of store.withPendingJobs()) {
      try {
        host.load(code);
      } catch (error) {
        log.write('error', 'room_load_failed', { room: code, error: String(error) });
      }
    }
    const address = http.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    log.write('info', 'listening', { port: bound });
    return bound;
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    log.write('info', 'drain_started', { rooms: host.rooms.size, connections: sockets.clients.size });
    await pool.idle(limits.drainJobsMs);
    const closing = JSON.stringify({
      v: PROTOCOL_VERSION,
      t: 'closing',
      reason: 'restart',
      retryAfterMs: 2000,
    } satisfies ServerMessage);
    const open = [...sockets.clients];
    for (const ws of open) {
      if (ws.readyState === WebSocket.OPEN) ws.send(closing);
      ws.close(CloseCode.restarting, 'restarting');
    }
    for (const code of [...host.rooms.keys()]) host.unload(code, 'drain');
    if (heartbeat !== null) clearInterval(heartbeat);
    if (maintenance !== null) clearInterval(maintenance);
    // Give clients a moment to finish the closing handshake, then cut whoever hasn't.
    const closed = Promise.all(
      open.map((ws) =>
        ws.readyState === WebSocket.CLOSED
          ? Promise.resolve()
          : new Promise<void>((resolve) => ws.once('close', () => resolve())),
      ),
    );
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref())]);
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => {
      http.close(() => resolve());
      http.closeAllConnections();
    });
    await pool.close();
    store.close();
    log.write('info', 'drain_finished', {});
  };

  return { http, host, listen, drain };
};
