// @joystyk/session/browser/rooms: the remote session client's ports for server rooms, with
// browser APIs: a WebSocket, seat tokens in local storage, action IDs from the CSPRNG, and the
// room server's HTTP API. A separate entry, so pages that never open a room never load the
// protocol's schemas; the launcher imports it from the stage, on the first Start.
import {
  CreateRoomResponseSchema,
  RoomInfoSchema,
  type CreateRoomRequest,
  type CreateRoomResponse,
  type RoomInfo,
} from '@joystyk/rooms/protocol';
import type { RemoteSocket, SocketEvents, SocketFactory, TokenStore } from '../remote.ts';

/** The room server's WebSocket URL for a page on `origin`: same host, `/ws` (Traefik routes it). */
export const roomsSocketUrl = (origin: string): string => {
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
};

/** A `SocketFactory` over the browser's `WebSocket`. */
export const browserSocket =
  (url: string): SocketFactory =>
  (events: SocketEvents): RemoteSocket => {
    const ws = new WebSocket(url);
    let closed = false;
    const finish = (code: number): void => {
      if (closed) return;
      closed = true;
      events.close(code);
    };
    ws.addEventListener('open', () => events.open());
    ws.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string') events.message(event.data);
    });
    ws.addEventListener('close', (event) => finish(event.code));
    ws.addEventListener('error', () => finish(1006));
    return {
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: (code, reason) => {
        closed = true;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code ?? 1000, reason);
      },
    };
  };

/**
 * Seat tokens in local storage, one key per room code, so every tab of this browser presents
 * the same token and the newest tab takes the seat (room-server.md section 5.5). Storage that
 * throws (blocked site data) falls back to memory for this page.
 */
export const webStorageTokens = (storage: Storage | null = globalThis.localStorage ?? null): TokenStore => {
  const memory = new Map<string, string>();
  const key = (room: string): string => `joystyk:room-token:${room}`;
  return {
    get: (room) => {
      try {
        return storage?.getItem(key(room)) ?? memory.get(room) ?? null;
      } catch {
        return memory.get(room) ?? null;
      }
    },
    set: (room, token) => {
      memory.set(room, token);
      try {
        storage?.setItem(key(room), token);
      } catch {
        // Kept in memory for this page.
      }
    },
    delete: (room) => {
      memory.delete(room);
      try {
        storage?.removeItem(key(room));
      } catch {
        // Nothing stored.
      }
    },
  };
};

/** 32 URL-safe characters from the browser's cryptographic randomness. */
export const randomActionId = (): string => crypto.randomUUID().replaceAll('-', '');

/** Why a room request failed, worded for players. */
export type RoomRequestError = { readonly status: number; readonly message: string };

const ROOM_ERRORS: Readonly<Record<number, string>> = {
  400: 'The room could not be set up with those settings.',
  403: 'This page may not open rooms.',
  404: "This game can't be played online here.",
  413: 'The room could not be set up with those settings.',
  429: 'Too many rooms were opened from here. Try again later.',
  503: 'The room server is busy or restarting. Try again in a moment.',
};

const roomError = (status: number): RoomRequestError => ({
  status,
  message: ROOM_ERRORS[status] ?? "The room server couldn't be reached. Check your connection, then try again.",
});

/** `POST /api/rooms`: creates a room and returns its code with the creator's seat token. */
export const createRoom = async (
  origin: string,
  request: CreateRoomRequest,
  fetcher: typeof fetch = fetch,
): Promise<
  { readonly ok: true; readonly value: CreateRoomResponse } | { readonly ok: false; readonly error: RoomRequestError }
> => {
  let response: Response;
  try {
    response = await fetcher(new URL('/api/rooms', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    return { ok: false, error: roomError(0) };
  }
  if (response.status !== 201) return { ok: false, error: roomError(response.status) };
  const parsed = CreateRoomResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { ok: true, value: parsed.data as CreateRoomResponse } : { ok: false, error: roomError(0) };
};

/** `GET /api/rooms/:code`: the room's game build, phase and open seats, or why not. */
export const fetchRoomInfo = async (
  origin: string,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<
  { readonly ok: true; readonly value: RoomInfo } | { readonly ok: false; readonly error: RoomRequestError }
> => {
  let response: Response;
  try {
    response = await fetcher(new URL(`/api/rooms/${encodeURIComponent(code)}`, origin));
  } catch {
    return { ok: false, error: roomError(0) };
  }
  if (response.status === 404)
    return { ok: false, error: { status: 404, message: 'No room has that code. Check it, or ask for a new link.' } };
  if (!response.ok) return { ok: false, error: roomError(response.status) };
  const parsed = RoomInfoSchema.safeParse(await response.json().catch(() => null));
  return parsed.success ? { ok: true, value: parsed.data as RoomInfo } : { ok: false, error: roomError(0) };
};
