// The launcher's room effects as Gyral drivers: asking the room server which games it hosts,
// reading an invite code from the page's URL, keeping the room's code in the address bar (so a
// reload rejoins and the link can be shared from there), and copying the invite. Reducers stay
// pure; tests substitute the drivers by name.
import { command, defineDriver, type Command } from '@gyral/core';
import { ONLINE_UNREACHABLE, parseHostedGames, parseRoomCode, type OnlineRooms } from './model.ts';

/** How long the launcher waits for the room server's answer before calling it unreachable. */
const ONLINE_TIMEOUT_MS = 10_000;

/**
 * `GET /api/rooms/games` on this page's origin, where Traefik routes the room server
 * (room-server.md section 5.4). Any failure, a refused answer or a slow one, is Unreachable:
 * Online with friends shows as unavailable and the local modes play on.
 */
export const onlineRoomsDriver = defineDriver<undefined, OnlineRooms>({
  name: 'launcher-online-rooms',
  run: async (_input, { signal }) => {
    try {
      const response = await fetch(new URL('/api/rooms/games', location.origin), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(ONLINE_TIMEOUT_MS)]),
      });
      if (!response.ok) return ONLINE_UNREACHABLE;
      return parseHostedGames(await response.json()) ?? ONLINE_UNREACHABLE;
    } catch {
      return ONLINE_UNREACHABLE;
    }
  },
  // One question at a time: a second ask while one is out is dropped.
  concurrency: 'exhaust',
});

export const checkOnline = <M>(toMsg: (online: OnlineRooms) => M): Command<M> =>
  command<undefined, OnlineRooms, unknown, M>(onlineRoomsDriver, undefined, {
    onSuccess: toMsg,
    onFailure: () => toMsg(ONLINE_UNREACHABLE),
  });

/** The `?room=CODE` of the page's URL, or null. */
export const inviteDriver = defineDriver<undefined, string | null>({
  name: 'launcher-invite',
  run: () => {
    const raw = new URL(location.href).searchParams.get('room');
    return raw === null ? null : parseRoomCode(raw);
  },
});

/** Reads the invite once the page is live; a page without one sends nothing. */
export const readInvite = <M>(toMsg: (code: string) => M): Command<M> =>
  command<undefined, string | null, unknown, M>(inviteDriver, undefined, {
    onSuccess: (code) => (code === null ? undefined : toMsg(code)),
  });

/** Puts the room's code in the address bar (`?room=CODE`), or takes it out, without a navigation. */
export const roomUrlDriver = defineDriver<string | null, void>({
  name: 'launcher-room-url',
  run: (code) => {
    const url = new URL(location.href);
    if (code === null) url.searchParams.delete('room');
    else url.searchParams.set('room', code);
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  },
  concurrency: 'queue',
});

export const showRoomInUrl = <M>(code: string | null): Command<M> =>
  command<string | null, void, unknown, M>(roomUrlDriver, code, { onFailure: () => undefined });

/** The clipboard. It fails without a user gesture or permission; the caller says so. */
export const clipboardDriver = defineDriver<string, void, string>({
  name: 'launcher-clipboard',
  run: async (text) => {
    await navigator.clipboard.writeText(text);
  },
  toError: (cause) => (cause instanceof Error ? cause.message : String(cause)),
});

export const copyText = <M>(text: string, toMsg: (ok: boolean) => M): Command<M> =>
  command<string, void, string, M>(clipboardDriver, text, {
    onSuccess: () => toMsg(true),
    onFailure: () => toMsg(false),
  });

/**
 * Daily share text (content-pipeline.md, "Share text"): the Web Share API where the device
 * offers it, otherwise the clipboard. Answers how it went: shared, copied, or cancelled when
 * the player closed the share sheet. Fails when neither works; the caller says so.
 */
export const shareDriver = defineDriver<string, 'shared' | 'copied' | 'cancelled', string>({
  name: 'launcher-share',
  run: async (text) => {
    if (typeof navigator.share === 'function' && (navigator.canShare?.({ text }) ?? true)) {
      try {
        await navigator.share({ text });
        return 'shared';
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return 'cancelled';
      }
    }
    await navigator.clipboard.writeText(text);
    return 'copied';
  },
  concurrency: 'exhaust',
  toError: (cause) => (cause instanceof Error ? cause.message : String(cause)),
});

export const shareText = <M>(
  text: string,
  toMsg: (how: 'shared' | 'copied' | 'cancelled' | 'failed') => M,
): Command<M> =>
  command<string, 'shared' | 'copied' | 'cancelled', string, M>(shareDriver, text, {
    onSuccess: toMsg,
    onFailure: () => toMsg('failed'),
  });
