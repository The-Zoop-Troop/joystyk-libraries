// A room server inside the test page: the real room core (@joystyk/rooms) behind the
// launcher's RoomServices, with sockets that deliver messages on a microtask. The launcher's
// browser tests play the whole room flow against it without a Node server; apps/site's
// end-to-end tests run the real apps/rooms.
import type { AnyDiscreteEngine, GameManifest } from '@joystyk/contracts';
import { restoreRng, seedState } from '@joystyk/kit';
import { createRoomCore, policyFromManifest, type LiveRoom, type RoomCommand, type RoomEffect } from '@joystyk/rooms';
import { createRemoteSession, memoryTokens, type Clock, type RemoteSession, type SocketEvents } from '@joystyk/session';
import type { RoomServices } from '../browser/services.ts';

type Conn = { readonly events: SocketEvents; open: boolean };

const clock: Clock = {
  now: () => Date.now(),
  after: (ms, callback) => {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
};

export const loopbackRoom = (engine: AnyDiscreteEngine, manifest: GameManifest, code = 'K7M2QX') => {
  const core = createRoomCore({
    engine,
    pin: {
      id: manifest.id,
      build: manifest.versions.build,
      rulesVersion: engine.rulesVersion,
      saveVersion: manifest.versions.save,
    },
    rng: restoreRng,
  });
  const policy = policyFromManifest(manifest);
  const conns = new Map<string, Conn>();
  const fresh = new Map<string, string>();
  let live: LiveRoom | null = null;
  let sequence = 0;
  let alarm: ReturnType<typeof setTimeout> | null = null;
  const hash = (token: string): string => `hash:${token}`;
  const token = (): string => `T${String((sequence += 1)).padStart(31, '0')}`;
  const seeds = () => ({
    engine: seedState(`engine-${String((sequence += 1))}`),
    ai: seedState(`ai-${String(sequence)}`),
  });

  const deliver = (id: string, message: unknown): void => {
    const conn = conns.get(id);
    if (conn === undefined || !conn.open) return;
    const text = JSON.stringify(message);
    queueMicrotask(() => {
      if (conn.open) conn.events.message(text);
    });
  };

  const close = (id: string, closeCode: number): void => {
    const conn = conns.get(id);
    if (conn === undefined || !conn.open) return;
    conn.open = false;
    queueMicrotask(() => conn.events.close(closeCode));
  };

  const perform = (effect: RoomEffect): void => {
    switch (effect.type) {
      case 'welcome': {
        const issued = fresh.get(effect.conn);
        deliver(
          effect.conn,
          effect.issueToken && issued !== undefined ? { ...effect.message, token: issued } : effect.message,
        );
        return;
      }
      case 'send':
        for (const id of effect.to) deliver(id, effect.message);
        return;
      case 'drop':
        close(
          effect.conn,
          effect.reason === 'replaced'
            ? 4001
            : effect.reason === 'left-room'
              ? 4002
              : effect.reason === 'room-closed'
                ? 4004
                : 4008,
        );
        return;
      case 'alarm':
        if (alarm !== null) clearTimeout(alarm);
        alarm =
          effect.at === null
            ? null
            : setTimeout(() => step({ type: 'timer-fired' }), Math.max(0, effect.at - Date.now()));
        return;
      default:
        return;
    }
  };

  const step = (command: RoomCommand): void => {
    if (live === null) return;
    const result = core.step(live, command, Date.now());
    live = result.room;
    for (const effect of result.effects) perform(effect);
  };

  const receive = (id: string, text: string): void => {
    const message = JSON.parse(text) as { t: string; [key: string]: unknown };
    switch (message.t) {
      case 'join': {
        const issued = token();
        fresh.set(id, issued);
        const presented = typeof message['token'] === 'string' ? hash(message['token']) : null;
        step({
          type: 'join',
          conn: id,
          name: String(message['name']),
          protocol: 1,
          presentedTokenHash: presented,
          freshTokenHash: hash(issued),
          watch: message['watch'] === true,
        });
        return;
      }
      case 'act':
        step({
          type: 'act',
          conn: id,
          id: String(message['id']),
          expectedRevision: Number(message['rev']),
          command: message['command'] as never,
        });
        return;
      case 'control':
        step({
          type: 'control',
          conn: id,
          id: String(message['id']),
          expectedRevision: Number(message['rev']),
          control: message['control'] as never,
          seeds: seeds(),
        });
        return;
      case 'resync':
        step({ type: 'resync', conn: id });
        return;
    }
  };

  let actions = 0;
  const rooms: RoomServices = {
    create: async (gameId, name) => {
      if (gameId !== manifest.id) return { ok: false, message: "This game can't be played online here." };
      const issued = token();
      const created = core.create(
        { code, policy, config: {}, seeds: seeds(), creator: { name, tokenHash: hash(issued) } },
        Date.now(),
      );
      if (!created.ok) return { ok: false, message: created.error.message };
      live = core.load(created.value);
      step({ type: 'resume' });
      return { ok: true, value: { room: code, token: issued, notice: null } };
    },
    find: async (asked) =>
      live !== null && asked === code
        ? { ok: true, value: { gameId: manifest.id } }
        : { ok: false, message: 'No room has that code. Check it, or ask for a new link.' },
    connect: (events) => {
      const id = `conn-${String((sequence += 1))}`;
      conns.set(id, { events, open: true });
      queueMicrotask(() => events.open());
      return {
        send: (text) => {
          if (conns.get(id)?.open === true) receive(id, text);
        },
        close: () => {
          const conn = conns.get(id);
          if (conn === undefined || !conn.open) return;
          conn.open = false;
          step({ type: 'leave', conn: id });
        },
      };
    },
    tokens: memoryTokens(),
    actionId: () => `action-${String((actions += 1))}-loopback`,
    inviteLink: (room) => `https://joystyk.test/games/${manifest.id}?room=${room}`,
  };

  /** Another player at the same room, with their own tokens: a remote session over the loopback. */
  const player = (name: string, watch = false): RemoteSession<unknown, unknown, unknown> =>
    createRemoteSession({
      game: {
        id: manifest.id,
        build: manifest.versions.build,
        rulesVersion: engine.rulesVersion,
        schemas: engine.schemas,
      },
      room: code,
      name,
      watch,
      connect: rooms.connect,
      tokens: memoryTokens(),
      clock,
      actionId: () => `${name}-${String((actions += 1))}-loopback`,
    });

  /** Opens the room as if `name` had created it elsewhere; returns their session. */
  const hostedBy = async (name: string): Promise<RemoteSession<unknown, unknown, unknown>> => {
    const tokens = memoryTokens();
    const created = await rooms.create(manifest.id, name);
    if (!created.ok) throw new Error(created.message);
    tokens.set(code, created.value.token);
    return createRemoteSession({
      game: {
        id: manifest.id,
        build: manifest.versions.build,
        rulesVersion: engine.rulesVersion,
        schemas: engine.schemas,
      },
      room: code,
      name,
      connect: rooms.connect,
      tokens,
      clock,
      actionId: () => `${name}-${String((actions += 1))}-loopback`,
    });
  };

  return { rooms, player, hostedBy, dispose: () => alarm !== null && clearTimeout(alarm) };
};
