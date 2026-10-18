import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod/mini';
import { Harness, coreFor, hashOf, peek, policy } from '../__tests__/fixtures.ts';
import {
  ClientMessageSchema,
  CreateRoomRequestSchema,
  DisplayName,
  encodeFor,
  isSupportedProtocol,
  PROTOCOL_VERSION,
  RoomCode,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from './index.ts';

describe('the wire protocol', () => {
  it('accepts well-formed client messages and refuses everything else', () => {
    const join = { v: 1, t: 'join', room: 'K7M2QX', game: 'hearts', name: 'Ana', build: '1.4.0' };
    expect(ClientMessageSchema.safeParse(join).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...join, token: 'A'.repeat(32), watch: true }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ ...join, room: 'K7M2Q0' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...join, extra: 1 }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ ...join, token: 'short' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ v: 1, t: 'act', id: 'abc', rev: 0, command: {} }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ v: 1, t: 'act', id: 'abcdefgh', rev: -1, command: {} }).success).toBe(false);
    expect(
      ClientMessageSchema.safeParse({ v: 1, t: 'act', id: 'abcdefgh', rev: 3, command: { take: 2 } }).success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({ v: 1, t: 'control', id: 'abcdefgh', rev: 3, control: { kind: 'resign' } })
        .success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({ v: 1, t: 'control', id: 'abcdefgh', rev: 3, control: { kind: 'kick', seat: 1 } })
        .success,
    ).toBe(false);
    expect(ClientMessageSchema.safeParse({ v: 1, t: 'shout' }).success).toBe(false);
  });

  it('checks names and codes', () => {
    expect(DisplayName.safeParse('Ana').success).toBe(true);
    expect(DisplayName.safeParse(' Ana').success).toBe(false);
    expect(DisplayName.safeParse('A\u0000na').success).toBe(false);
    expect(DisplayName.safeParse('x'.repeat(25)).success).toBe(false);
    expect(RoomCode.safeParse('ABCDEF').success).toBe(true);
    expect(RoomCode.safeParse('abcdef').success).toBe(false);
    expect(CreateRoomRequestSchema.safeParse({ game: 'peek', name: 'Ana', settings: { decisionMs: 10 } }).success).toBe(
      false,
    );
  });

  it('decodes every message the core sends', () => {
    const h = Harness.create(coreFor(peek, 'peek'), policy({ decisionMs: 10_000 }), { hand: 2 });
    h.join('a', 'Ana', hashOf('ana'));
    h.join('b', 'Ben');
    h.join('s', 'Cy', null, true);
    h.control('a', { kind: 'ready', ready: true });
    h.control('b', { kind: 'ready', ready: true });
    h.control('a', { kind: 'start' });
    h.act('a', { draw: true });
    h.step({ type: 'job-completed', jobId: 'draw-0', outcome: { ok: true, value: { card: 50 } } });
    h.act('b', { play: 1 });
    h.step({ type: 'leave', conn: 's' });
    const all = [...h.inbox.values()].flat();
    expect(new Set(all.map((m) => m.t))).toEqual(new Set(['welcome', 'snapshot', 'update', 'receipt', 'presence']));
    for (const message of all) expect(ServerMessageSchema.safeParse(message).error).toBeUndefined();
  });

  it('stamps the version a connection speaks', () => {
    const message: ServerMessage = { v: PROTOCOL_VERSION, t: 'replaced' };
    expect(encodeFor(message, PROTOCOL_VERSION)).toBe(message);
    expect(isSupportedProtocol(PROTOCOL_VERSION)).toBe(true);
    expect(isSupportedProtocol(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('decodes into the hand-written types', () => {
    expectTypeOf<z.infer<typeof ClientMessageSchema>>().toExtend<ClientMessage>();
    expectTypeOf<z.infer<typeof ServerMessageSchema>>().toExtend<ServerMessage>();
  });
});
