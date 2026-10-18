// The emergency worker (offline-and-updates.md, Rule 5). The build writes it as
// `sw-remove.js` beside sw.js, and the site serves it as /sw.js while the kill switch is on.
// The browser's own update check then replaces a broken worker on every device, even one too
// broken to read the flag file: it activates at once, deletes the PWA's caches and
// unregisters itself. Open pages keep running (a game in progress is never reloaded,
// Rule 2); their next load comes straight from the network. Saves in IndexedDB are untouched.
import { isPwaCache } from '../names.ts';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = (await caches.keys()).filter(isPwaCache);
      await Promise.all(names.map((name) => caches.delete(name)));
      await self.registration.unregister();
    })(),
  );
});
