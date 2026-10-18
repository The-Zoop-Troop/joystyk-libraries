// The offline page's script: lists the games this device can play offline, read from the
// pinned caches' own records. The worker serves this page, precached, for any page that
// failed to load, so it also names the page that wasn't available.
import { OFFLINE_URL } from '../names.ts';
import { pinnedGames } from '../client/pinned.ts';

const where = document.getElementById('where');
const list = document.getElementById('games');
const none = document.getElementById('none');

if (where !== null && location.pathname !== OFFLINE_URL) {
  where.textContent = `This page (${decodeURI(location.pathname)}) isn't available offline. It needs an internet connection.`;
}

document.getElementById('retry')?.addEventListener('click', () => location.reload());

void (async () => {
  if (list === null || none === null || !('caches' in window)) return;
  const games = await pinnedGames().catch(() => []);
  for (const game of games) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = game.page;
    link.textContent = game.name;
    item.append(link);
    list.append(item);
  }
  list.hidden = games.length === 0;
  none.hidden = games.length > 0;
})();
