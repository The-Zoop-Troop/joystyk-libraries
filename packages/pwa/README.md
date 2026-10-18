# @joystyk/pwa

The installable, offline-capable Joystyk (host policy). A service worker built from Workbox keeps
the site's shell, recently played games and the games a player pins; the page offers updates
only where nothing can be lost; a flag file can switch the whole thing off. The design is
offline-and-updates.md (Joystyk host reference); the blog's worker
(pwa-offline.md (Joystyk host reference)) is the model.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/pwa
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser. The build entry uses Vite 8.3.3, declared
as a peer dependency.

| Import | Format |
| --- | --- |
| `@joystyk/pwa` | ES module and TypeScript declarations |
| `@joystyk/pwa/client` | ES module and TypeScript declarations |
| `@joystyk/pwa/build` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@joystyk/pwa` | Anywhere | Cache names, routing decisions, the asset-manifest, pin-record and flag-file formats |
| `@joystyk/pwa/client` | Browser page | `registerPwa`, `pinGame`, `unpinGame`, `pinnedGames`, `refreshPinnedGames`, `<jy-offline-toggle>`, `<jy-update-toast>`, `<jy-security-update>` |
| `@joystyk/pwa/build` | Node, at build time | `joystykPwa`, the Vite plugin that writes `sw.js` and the manifests |

The worker's source is `src/sw/sw.ts`. It is never imported: the build bundles it into one
classic `sw.js`. `tsconfig.sw.json` type-checks it with the worker's globals instead of the DOM.

Workbox (`workbox-core`, `-precaching`, `-routing`, `-strategies`, `-expiration`, pinned to
one exact version in `pnpm-workspace.yaml`) is the one non-Gyral runtime dependency here,
as host policy and the blog notes allow. It runs only inside the worker.

## Use

The site's client build adds the plugin, and the browser entry registers the worker in
production builds (`apps/site/vite.config.ts` and `src/entry-client.ts` do both):

```ts
// vite.config.ts
import { joystykPwa } from '@joystyk/pwa/build';

plugins: [joystykPwa({ release, releaseTime, site: ({ outDir }) => pwaBuildInput({ clientDir: outDir }) })];

// entry-client.ts
import { requestSave, watchSafePoints } from '@joystyk/launcher/browser';
import { registerPwa } from '@joystyk/pwa/client';

registerPwa({
  release: __JOYSTYK_RELEASE__,
  releaseTime: __JOYSTYK_RELEASE_TIME__,
  watchSafePoints,
  saveGame: requestSave,
  daily: [/* daily content clients */],
});
```

`site` gives the build the games it ships (id, versions, the folder holding the game's code,
its asset-manifest path and page) and a `render(path)` that answers exactly as the production
server will. `unlisted` names games whose code is bundled but not listed (the site's test
games outside test builds); their code never enters the precache. The site serves the files
the build writes (see below), all `no-cache` except the hashed ones.

A game page renders `<jy-offline-toggle game-id="nim" game-name="Nim" assets="/games/nim/manifest.json">`;
the catalog does this for every playable game and reserves its box, so nothing shifts when
the control appears.

Catalog cards and lineup rows include `<jy-offline-availability game-id="nim" hidden>`.
The client reads completed pins, updates labels after pin changes and navigation, and
marks unpinned game links unavailable while offline. Completed pins read “Available
offline”; unpinned games read “Unavailable offline” when the network is down.
For a cached offline page, the worker renders those labels from completed pin records
before first paint, keeping catalog cards and table rows stable through hydration.

## What the build writes

After Vite writes the client build, the plugin reads `.vite/manifest.json` and adds:

| File | Served | What it is |
| --- | --- | --- |
| `sw.js` | `/sw.js`, no-cache | The worker, one classic script, with the precache list and the release ID injected |
| `games/<id>/manifest.json` | the game manifest's `assets`, no-cache | Every file the game's page needs to play: the shell's and the game's own, with sizes, kinds, the game's build, rules and save versions, and the release |
| `manifest.webmanifest` | `/manifest.webmanifest`, no-cache | Name, colors and icons for installing Joystyk |
| `offline.html` | `/offline`, no-cache | The offline page; its script lists the games this device can play offline |
| `assets/icon-*.svg`, `assets/icon-*.png` | `/assets/…`, immutable | The joystick icon: SVG, 192 and 512 pixel PNGs and a maskable 512, drawn by the build (no image library) |
| `assets/offline-*.js`, `assets/offline-*.css` | `/assets/…`, immutable | The offline page's script and styles (no inline code: the site's CSP) |
| `pwa-control.json` | `/pwa-control.json`, no-cache | The default flag file: `{ "schemaVersion": 1, "serviceWorker": "enabled" }` |
| `sw-remove.js` | `/sw.js` while the kill switch is on | The emergency worker: it removes itself and the PWA's caches |
| `release.json` | Never | The release ID and release time; the site reads it to cap the minimum release it serves |

**Which files a game needs.** The shell is everything the site's entry reaches, including
the launcher's lazily loaded stage, storage and identity code, but no game: a dynamic import
whose source lies in a game's folder starts that game. A game needs the shell plus everything
its own dynamic entries reach. Static imports are always followed, even into another game's
chunk, because the bundler may put shared code there.

A file the bundler emits for a module (a worker named with `new Worker(new URL(…))`, a font)
is an asset of the chunk holding that module, so it belongs to whoever reaches that chunk. The
site therefore imports a game's job worker factory lazily (`apps/site/src/games.ts`): Greed's
4 MB physics worker is then Greed's own file, not part of the shell that every visitor
precaches and every pin copies. The build fails if the shell reaches any worker script.

**The precache list** holds the shell's files, the icons, the offline page and its files, the
web app manifest, and the server-rendered `/` and `/favicon.svg`. Hashed files carry no
revision; the rest carry a hash of their rendered bytes, so a revision changes exactly when
what is served changes. The build fails if any entry is missing, because one bad entry would
fail the worker's install for every visitor.

## The cache tiers

| Tier | Cache | Holds | Eviction |
| --- | --- | --- | --- |
| 1 | `joystyk-shell-v1-<scope>` (Workbox) | The precache list | Replaced each release; Workbox removes outdated entries on activation |
| 2 | `recent:code:v1`, `recent:art:v1`, `recent:audio:v1`, `recent:wasm:v1` | Hashed files of games played but not pinned | Capped per kind (`RECENT_LIMITS`), least recently used first, 30 days, `purgeOnQuotaError` |
| 3 | `game:<id>:<version>` | A pinned game's whole build, its page and catalog data, and the pin's record | Never evicted by the worker; refreshed and replaced at safe points |

How the worker answers (`routeFor` in `src/routing.ts`):

- **Pages** go to the network first. If it fails (or takes over 8 seconds while a copy
  exists), a pinned copy of the page, then the precached shell, then the offline page. A
  page answered from a cache gets `data-offline` on its `<html>` tag (`src/offline-mark.ts`),
  so its CSS reserves no ad space at first paint.
  Worker-controlled HTML also removes `modulepreload` links before the browser parses
  it, avoiding duplicate fetches across the page and worker. Initial network responses
  keep the server's preload hints. Module scripts and CSP hashes remain intact.
  The site disables Vite's runtime JavaScript preload hints to prevent lazy imports
  from adding them back; stylesheet dependency loading stays enabled.
- **Catalog data** (`/api/games…`) goes to the network first, then to a pinned copy.
- **Hashed files** come from the precache, then the pins, then their kind's Tier 2 cache
  (stale-while-revalidate; the revalidating request is answered by the browser's HTTP cache,
  since the files are immutable). Each strategy's background work is handed to the fetch
  event's `waitUntil`, the blog's fix that keeps the caps holding.
- `/sw.js`, `/pwa-control.json`, `/healthz`, other origins and other methods are never cached.

## Pinning

`pinGame({ gameId, assets })` reads the asset manifest, fills `game:<id>:<version>` with every
file, then the page and its data, then the pin's record. It checks that the page names no
hashed file the manifest lacks (a deploy mid-pin), and tries once more if so. Only after the
new build is complete does it drop stale files and older versions. The first pin asks for
persistent storage (`@joystyk/storage/browser`). Errors come back as a `PinError` with a
player-facing message: offline, out of space, or not available right now.

A pin is self-sufficient: it holds the shell files its page names, so a pinned game still
plays offline after a worker update replaced the precache. `refreshPinnedGames` brings every
pin to the server's current build; `registerPwa` runs it at safe points while online.

## Updates

- The worker never activates itself. `registerPwa` watches the registration; when a new
  worker is installed and waiting, it shows "Update ready" **only while the launcher reports a
  safe point** (`joystyk:safe-point`, through `watchSafePoints`), and hides it when play
  starts. Refresh posts `SKIP_WAITING`; the page reloads on `controllerchange`.
- If another tab accepted the update, this page runs the old release under the new worker
  (safe: hashed files outlive their release). It offers a reload at its next safe point and
  never reloads by itself.
- Checks: every 45 minutes, when the tab becomes visible, and on each navigation to the index.
- **Forced security updates** (`forced.ts`). Given `releaseTime`, the page reads the flag
  file at load, every 15 minutes, when the tab becomes visible and on each navigation to the
  index. If its `minimumRelease` is later than this release, `<jy-security-update>` opens: a
  modal dialog with the reason and one action, Update now, which Escape can't close.
  `saveGame` (the launcher's `requestSave`) runs at once and pauses play; Update now waits for
  the save, brings in the new worker when it can (a few seconds at most) and reloads. A failed
  read changes nothing, so offline play goes on. The design is
  Forced security updates (Joystyk host reference).
- At safe points while online, at most every 30 minutes: refresh pins, then prefetch daily
  puzzles (today and tomorrow, host policy) for every daily client in an installed app, or for the
  pinned ones in a browser tab. The site passes no daily clients yet; no daily game exists.

## The kill switch

The site serves `/pwa-control.json` from `PWA_CONTROL_FILE` (default: the build's own file).
Setting `"serviceWorker": "disabled"`:

- a page reads it before registering, unregisters every worker and deletes the PWA's caches;
- a worker reads it on install (and refuses to install), on activation, and on navigations
  (at most every five minutes), then unregisters itself and deletes the PWA's caches.
- the site serves `sw-remove.js` as `/sw.js`, so the browser's own update check replaces even
  a worker too broken to read the flag with one that removes itself and its caches.

IndexedDB (saves, stats, preferences) is never touched. A missing or unreadable flag file
changes nothing, so a broken file can't wipe every player's offline games.

The same file's optional `minimumRelease` forces older pages to update (see Updates above).
The site serves a minimum later than its own release as its own release's time.

## Tests

- `src/*.test.ts` and `src/build/*.test.ts` (Node): routing decisions and cache names, the
  offline mark on cached pages, the update-prompt rule, asset-manifest decoding and pin planning, the flag file (release-time
  comparison, the minimum release and its cap) and pin records, the shell/game split over a Vite manifest, the asset manifest, precache list and
  injection the build writes, the web app manifest, the offline page, and the PNG encoder and
  icon drawing.
- `src/client/*.browser.test.ts` (Chromium): pinning against real Cache Storage with a fake
  server (first pin, refresh in place, a version switch, a page from a newer deploy, offline
  and bad manifests, unpinning), the elements, and the forced update's order: the notice,
  the save, then the reload, never before the save.
- `apps/site/src/pwa.e2e.test.ts`: two real releases on the production server. With the
  network off, the shell loads, a pinned Nim plays to the end and an unpinned game shows the
  offline page; the index served offline reserves no ad space and shifts nothing, and its
  slots return with the connection; a pinned Greed throws its dice in the physics worker, which only Greed's asset
  manifest lists; the update waits through a game of Nim and appears at the results; a raised
  minimum release blocks a game of Nim with the notice, saves it and reloads into release B,
  which resumes it; an old tab
  lazily loads its own release's chunks after a deploy; the kill switch unregisters the worker
  and empties the caches.
