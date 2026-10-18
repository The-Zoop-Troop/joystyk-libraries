// @joystyk/rooms/protocol: the versioned wire protocol (room-server.md section 5). Pure: it
// imports only @joystyk/contracts and zod/mini, so the browser's remote session client and
// the P2P host can import it without pulling in the room core or the Node adapter.
import { SUPPORTED_PROTOCOLS } from './schemas.ts';
import type { ServerMessage } from './types.ts';

export * from './schemas.ts';
export type * from './types.ts';

/** WebSocket close codes (section 5.2). */
export const CloseCode = {
  normal: 1000,
  /** Server restarting; reconnect after `retryAfterMs`. */
  restarting: 1012,
  /** Too slow (outgoing buffer full) or the server is busy; reconnect with backoff. */
  tryAgainLater: 1013,
  /** A newer tab took the seat; stop and offer "Use this tab instead". */
  replaced: 4001,
  /** The player left the room; stop. */
  leftRoom: 4002,
  /** No such room, or it closed; stop. */
  noSuchRoom: 4004,
  /** A rate or policy limit; reconnect after a longer backoff. */
  policy: 4008,
} as const;

/** Rejection codes the platform itself uses; engines add `game:<GameError.code>`. */
export const RejectionCode = {
  stale: 'stale',
  badRevision: 'bad-revision',
  actionIdReused: 'action-id-reused',
  spectator: 'spectator',
  notHost: 'not-host',
  wrongPhase: 'wrong-phase',
  storageUnavailable: 'storage-unavailable',
  engineError: 'engine-error',
  badCommand: 'bad-command',
  notAllowed: 'not-allowed',
} as const;

export type RejectionCode = (typeof RejectionCode)[keyof typeof RejectionCode];

/** The rejection code for an engine's `GameError`. */
export const gameRejection = (code: string): string => `game:${code}`;

/** True when the server speaks this protocol version. */
export const isSupportedProtocol = (version: number): boolean => SUPPORTED_PROTOCOLS.includes(version);

/**
 * A server message as a connection that joined with `version` must receive it. There is one
 * version today, so this only stamps `v`; when version 2 exists, the down-conversion for
 * version-1 clients lives here and nowhere else.
 */
export const encodeFor = (message: ServerMessage, version: number): ServerMessage =>
  message.v === version ? message : { ...message, v: version };
