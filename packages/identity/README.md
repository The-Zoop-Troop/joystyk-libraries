# @joystyk/identity

The guest player of v1 (host policy): a stable player id made on the device, a display name that
passes a strict all-ages filter, and an avatar from a preset set. There is no email, no
sign-in, no analytics and no fingerprinting (host policy). Everything else the site keeps, from
saves to streaks, keys on the player id, never on the device, so v2 can attach the id to an
account and carry the history across (v2-accounts-and-social.md (Joystyk host reference)).

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/identity
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser.

| Import | Format |
| --- | --- |
| `@joystyk/identity` | ES module and TypeScript declarations |
| `@joystyk/identity/browser` | ES module and TypeScript declarations |
| `@joystyk/identity/names` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@joystyk/identity` | Anywhere (no DOM) | `createIdentity`, the name filter and generator, avatars, record kinds |
| `@joystyk/identity/browser` | Browser | `createBrowserIdentity`, which injects `crypto.randomUUID` and `crypto.getRandomValues` |
| `@joystyk/identity/names` | Anywhere (no DOM, no storage) | `checkDisplayName`, `generateName`, the blocklist and their types; the room server imports only this |

## Use

```ts
import { openBrowserStorage } from '@joystyk/storage/browser';
import { createBrowserIdentity } from '@joystyk/identity/browser';

const storage = await openBrowserStorage({ onNotice });
const identity = createBrowserIdentity(storage);

const profile = await identity.current(); // { id, displayName: 'Pixel Fox 42', nameSource, avatar, createdAt }
await identity.rename('Ada Byte');         // Result: the normalized name, or why it was refused
await identity.rollName();                 // a fresh generated name
await identity.setAvatar('robot');         // preset ids only
const player = storage.player(profile.id); // saves, stats, streaks, preferences
```

`current()` never fails. When storage can't keep a new guest (private browsing, blocked site
data), the guest lasts for this page and storage has already told the player.

Two tabs opened together on a first visit get one guest (bead host integration work). The `device` record
and the profile are each written with `setIfAbsent`, one IndexedDB transaction that writes
only when the key is empty, so the tab that loses the race plays as the guest the other
created. This needs no Web Locks, so it holds in every browser with IndexedDB; storage that
fell back to memory isn't shared between tabs, so each tab there is its own guest.

The core takes its randomness as arguments (`randomUUID`, `random`), so tests and server
code pass deterministic ones.

## Records

Both live in the storage package's `identity` object store and decode through Zod schemas.

| Key | Record | Notes |
| --- | --- | --- |
| `device` | `{ playerId }` | Which player this device plays as; the only record not keyed on a player id |
| `player/<id>` | `Profile` | The name is re-checked on every read. A name that a newer blocklist refuses is discarded, and the player gets a fresh generated name under the same id. |

## Display names

`checkDisplayName(input)` normalizes (NFKC, trim, collapse spaces) and then refuses a name
that:

- has fewer than 3 or more than 20 characters;
- uses anything but ASCII letters and digits, with single spaces, hyphens or underscores
  between them (this alone rules out URLs, emails, emoji and look-alike letters from other
  scripts, which would slip past the blocklist);
- has no letter, or more than 4 digits (no phone numbers or birthdays);
- matches the blocklist.

Rejection messages never repeat the word that was blocked. Rooms and anything else that
shows a name to another player should run the same check; `@joystyk/identity/names` offers it
without storage or the DOM. The room server replaces a refused name with a generated one and
tells the player why.

The blocklist (`src/names/blocklist.ts`) has three parts. Matching lowercases the name, undoes
digit substitutions (`sh1t`, `n4z1`) and matches stretched letters (`fuuuck`):

| List | Matches | Example |
| --- | --- | --- |
| `BLOCKED_ANYWHERE` | Anywhere, even across word breaks | `F U C K`, `BigShitFan` |
| `BLOCKED_WORDS` | Only a whole word, or the whole name with its breaks removed | `Big Ass`, but not `Classic` or `Peacock` |
| `BLOCKED_NUMBERS` | A number standing alone | `Fox 69` |

The filter is strict on purpose and will sometimes refuse an innocent name ("Cosmic Untamed"
contains a blocked stem across the space). The player can type another or roll one.

### Blocklist provenance

The list was curated from the English list of
[List of Dirty, Naughty, Obscene, and Otherwise Bad Words](https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words)
(file `en`, commit `5faf2ba42d7b1c0977169ec3611df25a3c08eb13`, SHA-256
`af851ecef1d5f212caba17339b12ac39cc2fef7d78c74876f67237644fcee8bd`), © Shutterstock, Inc.
and contributors, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: phrases reduced to their
key word or dropped, words with everyday meanings dropped, stems in place of inflections, and
a few slurs, hate codes and insults added (marked `// added` in the file). When you change
the list, keep the attribution and add a test case.

## Generated names

`generateName(random)` returns names like "Pixel Fox 42": an arcade adjective, a friendly
noun and a number from 10 to 99, skipping blocked numbers. A test runs every combination
through the filter, so a generated name never needs a second roll. Add words only if they
are kind, all-ages and free of trademarks (`pnpm check:names` scans this package).

## Avatars

`AVATAR_IDS` lists 16 preset ids (`fox`, `robot`, `joystick`, …). The art will come later
from `@joystyk/ui`. Ids are stored in profiles, so never rename or remove one; add new ones
at the end.
