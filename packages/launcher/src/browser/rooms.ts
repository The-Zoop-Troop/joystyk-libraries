// The default room services: the room server on this page's own origin. In production
// Traefik routes `/api/rooms` and `/ws` on the site's host to the room service (DEPLOY.md);
// in development the site's dev server forwards them to a local apps/rooms. Loaded with the
// stage, so a page nobody plays never fetches the protocol's schemas.
import {
  browserSocket,
  createRoom,
  fetchRoomInfo,
  randomActionId,
  roomsSocketUrl,
  webStorageTokens,
} from '@joystyk/session/browser/rooms';
import type { RoomServices } from './services.ts';

export const pageRooms = (page: Location = location): RoomServices => {
  const origin = page.origin;
  return {
    create: async (gameId, name) => {
      const created = await createRoom(origin, { game: gameId, name });
      if (!created.ok) return { ok: false, message: created.error.message };
      return {
        ok: true,
        value: { room: created.value.room, token: created.value.token, notice: created.value.notice?.message ?? null },
      };
    },
    find: async (code) => {
      const found = await fetchRoomInfo(origin, code);
      return found.ok
        ? { ok: true, value: { gameId: found.value.game.id } }
        : { ok: false, message: found.error.message };
    },
    connect: browserSocket(roomsSocketUrl(origin)),
    tokens: webStorageTokens(),
    actionId: randomActionId,
    inviteLink: (code) => {
      const url = new URL(page.href);
      url.hash = '';
      url.search = '';
      url.searchParams.set('room', code);
      return url.href;
    },
  };
};
