# @joystyk/storage

Everything a player keeps on their device: save slots, stats, daily streaks, preferences and
each game's own key-value data. It sits on IndexedDB in the browser and on memory in tests
and server rendering, and it never trusts what it reads back.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/storage
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/storage` | ES module and TypeScript declarations |
| `@joystyk/storage/browser` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

The design comes from offline-and-updates.md (Joystyk host reference)
(the Data tier, Rule 3 on saves) and game-contract.md (Joystyk host reference)
(the save envelope, migrations and `PlatformApi.storage`).

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@joystyk/storage` | Anywhere (no DOM) | Record stores, the save, stats, streak and preference stores, the memory backend, schemas, the migration runner |
| `@joystyk/storage/browser` | Browser | The IndexedDB backend, `openBrowserStorage`, the persistent-storage helpers, `systemEnvironment` |

`tsconfig.core.json` type-checks the core without DOM types, so browser code can't leak into
it: anything that needs `window`, `navigator` or `indexedDB` goes in `src/browser/`.

## How it fits together

```ts
import { openBrowserStorage, requestPersistentStorage } from '@joystyk/storage/browser';

const storage = await openBrowserStorage({ onNotice: (notice) => frame.show(notice.message) });
const player = storage.player(profile.id); // from @joystyk/identity

await player.saves.write('nim', 'auto', envelope);              // a contracts SaveEnvelope
const resumed = await player.saves.load('nim', 'auto', {          // migrated and validated
  saveVersion: manifest.versions.save,
  migrations: module.migrations,
  state: module.engine.schemas.state,
});
await player.stats.record('nim', outcome);                        // a contracts Outcome
await player.streaks.set('daily-word', { current: 3, best: 5, lastDay: '2026-10-08' });
await player.preferences.update({ singleKeyShortcuts: false });
const platformStorage = player.gameStorage('nim');                // PlatformApi.storage

await requestPersistentStorage(); // when the player pins a game, never on page load
```

In tests and on the server, use `openStorage({ backend: createMemoryBackend() })`.

### The layers

1. **Backend** (`StorageBackend`): raw get, put, delete, list-by-prefix and clear over named
   object stores, with JSON values. `createMemoryBackend` and `openIndexedDbBackend`
   implement it. Every operation resolves to a contracts `Result`; expected failures such as
   a full quota never reject.
2. **Record stores** (`RecordKind`, `createRecordStore`): every record is stored as
   `{ version, writtenAt, value }`. On read, the store checks that shape, runs the kind's
   migrations from the record's version to the current one (the contracts' `runMigrations`),
   then validates the value with the kind's Standard Schema. On write, it validates first.
3. **Player stores** (`storage.player(id)`): saves, stats, streaks, preferences and game data,
   with keys that start with the player id (`<playerId>/<gameId>/<slot>`), never a device id.

Other packages define their own record kinds on the same machinery: `@joystyk/identity` keeps
its profile in the `identity` store with `storage.records(PROFILE_RECORD)`.

### Ports for the session runner

`SaveStore`, `StatsStore`, `StreakStore` and `PreferencesStore` are interfaces, keyed by game
id and slot name, so `@joystyk/session` can declare narrower ports and pass these stores in.
Every method returns `Promise<Result<…, StorageError>>`.

## Never trusted

A record that fails any step is never handed to the caller:

| What went wrong | What happens |
| --- | --- |
| Not a record, not JSON, fails its schema, or a migration fails or is missing | Deleted, or for saves moved to the `archive` store, with a `RecordDiscarded` or `RecordArchived` notice. The read returns null (or the defaults). |
| Written by a newer build (`version` above the current one) | Kept for that build, with a `RecordFromFuture` notice; the read returns null. |
| A save's game state fails the game's migrations or `schemas.state` (`saves.load`) | Archived with a notice, or kept with `RecordFromFuture` when the game's save version is newer. |

`saves.load` doesn't compare `rulesVersion`; the caller decides whether an old-rules game can
continue (Rule 3).

Notices carry a player-facing `message` and developer `issues`; show only the message.

## Quota

When a write fails with `QuotaExceeded`, the store clears the `archive` store, the least
valuable data it keeps, and tries once more. If that fails too, the write returns a
`QuotaExceeded` error and a notice. `estimateStorage()` reports usage, and
`requestPersistentStorage()` asks the browser not to evict the site's data.

A failed `PlatformApi.storage` write rejects with a `StorageFailure`, because the contract's
`Promise<void>` has no other channel; reads resolve to null.

## Versions

- **Record shapes**: each `RecordKind` has a `version` and a migration chain. Bump the
  version and add a `Migration` (from the contracts) when a shape changes; records upgrade on
  their next read and are rewritten in the new shape.
- **Object stores**: `DATABASE_UPGRADES` in `src/browser/indexeddb.ts`, numbered from 1 with
  no gaps. Add a step only to create or remove an object store. When another tab opens a
  newer version, this connection closes, calls `onVersionChange`, and later operations
  return `Unavailable`.

## Preferences

`StoredPreferences` holds the player's choices, where `system` follows the operating system:
reduced motion (`system`, `reduce`, `no-preference`), sound and volume, single-key
shortcuts (WCAG 2.1.4) and theme (`system`, `light`, `dark`), plus an optional locale.
`resolvePreferences(stored, systemEnvironment())` turns them into the contracts'
`Preferences`, with `singleKeyShortcuts` added. `aiContentAccepted` records that the player
accepted the AI-content notice (host policy); it is optional, so records written before it read as
"not yet" without a migration.

### Other tabs

A preference set in one tab reaches every other open tab of the site (bead host integration work).
`update` notifies this tab's subscribers, then publishes `{ kind: 'preferences', playerId }`
on the storage's `ChangeFeed`. Each other tab parses the message, reads the preferences back
from IndexedDB through their schema, and calls its subscribers with the source
`other-tab`. The message carries no values, so nothing reaches a tab without passing the
record's schema.

`openBrowserStorage` builds the feed with `openChangeFeed()`: a `BroadcastChannel` named
`joystyk-storage`, or, where the browser has none, a `storage` event fired by writing and at
once removing a localStorage key of the same name. Where neither works, and when storage
fell back to memory (which tabs don't share), changes stay in their tab. In tests,
`createMemoryChangeHub()` gives each simulated tab a feed.

## Writing only if absent

`StorageBackend.putIfAbsent` writes a key only when it is empty, in one step. IndexedDB does
the read and the `add` in one readwrite transaction, and it runs readwrite transactions on a
store one at a time across every connection, so two tabs can't both find the key empty. The
record stores expose it as `setIfAbsent`, which resolves to the record the key holds
afterwards. `@joystyk/identity` creates the guest with it.

## Tests

- `src/*.test.ts` run in Node against the memory backend: decoding, migrations, archive and
  discard, quota retry, saves, stats, streaks, preferences and game data.
- `src/browser/*.browser.test.ts` run in real Chromium: opening and upgrading the database,
  `versionchange` from another connection, corrupt and non-JSON records written behind the
  store's back, quota errors and the persistent-storage request. `cross-tab.browser.test.ts`
  stands two storages on one database for two tabs and checks that a preference change
  reaches the other, over `BroadcastChannel` and over the `storage` event from a same-origin
  iframe (Vitest's browser mode can't open a second page).

Chromium's real quota can't be reached in these tests: Playwright's browser contexts are off
the record, and `Storage.overrideQuotaForOrigin` over CDP leaves their quota unchanged. The
quota tests make `IDBObjectStore.put` throw the browser's own `QuotaExceededError` instead,
and everything around it runs for real.
