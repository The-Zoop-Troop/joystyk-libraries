# @joystyk/launcher

The frame around a game (host policy). `<jy-launcher>` lets the player choose how to play, starts a
local session or opens a server room, mounts the game's canvas, and draws the platform's own
screens around it: the resume offer, the pass-and-play hand-off (host policy), the room lobby, the
pause overlay with preferences, and the results with their ad slot. It talks to games only through the contracts in
game-contract.md (Joystyk host reference) and never imports a game.

## npm package

The first `0.1.0` release is being prepared; it has not been published. Once available:

```sh
npm install @joystyk/launcher
```

Node consumers require Node 24.15 or later. Browser entry points require a modern
browser and should be loaded in the browser. Tested with Gyral 0.3.1.

| Import | Format |
| --- | --- |
| `@joystyk/launcher` | ES module and TypeScript declarations |
| `@joystyk/launcher/browser` | ES module and TypeScript declarations |
| `@joystyk/launcher/fixture` | ES module and TypeScript declarations |
| `@joystyk/launcher/report` | ES module and TypeScript declarations |

Only the entries listed above are public API. Installed packages contain compiled ESM,
type declarations and runtime assets. Repository-relative links describe the Joystyk
workspace and are not needed to use the npm package.

## Entry points

| Import | Runs in | Contents |
| --- | --- | --- |
| `@joystyk/launcher` | Server and browser | `<jy-launcher>` (server-rendered), its pure model, the safe-point event |
| `@joystyk/launcher/browser` | Browser | `createLauncherServices`, `provideLauncherServices`, `watchSafePoints`, `requestSave` |
| `@joystyk/launcher/fixture` | Tests | Tally, a tiny test game, and `tallyProbe` |

The stage element (`<jy-game-stage>`), the session runners, storage and identity load on
the first Start, so a game page that nobody plays never downloads them.

## Use

A page renders the launcher with what its game page knows about the game:

```ts
html`<jy-launcher .game=${{ id, name, modes, players, aiLevels, status, aiContent }}></jy-launcher>`;
```

`players` is `{ min, max }`, plus the manifest's optional `default`: against the computer
the Players picker starts at that count, and otherwise at the fewest.

The app provides the games it can load, once per page (platform packages never import a
game, so the list comes from the app; `apps/site/src/game-loaders.ts` builds it):

```ts
import { createLauncherServices, provideLauncherServices } from '@joystyk/launcher/browser';

provideLauncherServices(document, createLauncherServices({
  games: { nim: { entry: () => import('@joystyk/game-nim').then((m) => m.entry) } },
}));
```

A loader may also give `aiWorker: () => new Worker(…)` for a manifest with `ai.heavy`; the
local runner then chooses AI moves in that worker (`workerAiRunner`). A game whose engine
requests jobs that local play may run gives `jobWorker: (kind) => new Worker(…)`; the runner
then performs each job in a fresh worker (`workerJobRunner`). Greed's dice throws work this
way, with the factory from `@joystyk/game-greed/jobs`.

Without JavaScript the setup form still renders, with a disabled Start button and the line
"JavaScript is needed to play".

## How a game starts

1. **Setup.** The modes come from the manifest. Solo, vs AI (with a level), pass-and-play
   (with seat names, checked by `@joystyk/identity`'s name filter) and, for a manifest that
   lists `daily`, the daily puzzle are playable; P2P rooms show as coming soon (host policy). Solo,
   vs-AI and daily play seat the guest under their display name. In pass-and-play the count is
   people: a game with AI and more seats than people (Hearts and Spades seat four) lets two or
   more share the device, and the computer plays the other seats at the chosen level
   (`computerSeatsFor`). Online with friends is
   playable only for a game the room server hosts: once live, a launcher whose manifest lists
   `server` asks `GET /api/rooms/games` (the `launcher-online-rooms` driver) and reads an
   invite after the answer. A game the server doesn't host shows online play as coming soon
   (host policy); while it asks, the option waits without a note; and when the server can't be
   reached (an error, a page that isn't the answer, or 10 seconds of silence) it shows as
   "Unavailable right now". The local modes never wait for it. The answer holds for the page,
   so client navigation to another game reuses it.
2. **Loading.** `<jy-game-stage>` loads the entry through the app's loader, checks that the
   manifest allows the mode and that the access gate is open (always, until premium access
   in v2), loads the module, opens the player's storage and reads their preferences.
3. **AI-made content (host policy).** A manifest with `aiContent: true` stays locked until the
   player accepts a short notice. The answer is a preference (`aiContentAccepted`), stored
   once per device and changeable in the overlay. Such a game's results and pause menu carry
   `<jy-report-problem>` (*Report a problem*, host policy): a reason from a fixed list and an
   optional note, posted to the site's `POST /api/reports` with the game and, for a daily
   puzzle, its ID (the stage's `Puzzle` output). `@joystyk/launcher/report` holds the wire
   constants the site shares.
4. **Resume or new.** Each local mode has its own save slot. A save in progress is offered
   for resuming; a finished one, one from older rules, or one the engine's `worthSaving`
   rejects (an untouched game), is cleared. The slot's port lets the runner clear it too.
5. **Playing.** The stage builds the session (`createLocalSession` for a Layer 2 engine,
   `createFixedStepRunner` for a simulation, or the game's own `createSession`) and calls
   `mount(canvas, session, platform)`.
6. **Results.** At the outcome the stage clears the save slot, records stats and, if the
   engine has a `rematch` hook, the config for "Play again". The launcher shows the outcome,
   play time, any assistance (`Outcome.undosUsed` and `assists`), Play again, Change mode,
   Back to all games, and the `results` ad slot, over the final board (see below). The
   session is disposed only when the player picks Play again or Change mode, the game asks
   to exit, or the page goes away.

## Online with friends

Server rooms (host policy), for any game whose manifest lists `server` and that the room server
hosts:

1. **Create or join.** "Create a room" asks the room server for a room (`POST /api/rooms`)
   with the guest's display name; the creator holds seat 0 and hosts. Below it, a join form
   takes a code or a pasted invite link, and "Just watch" joins as a spectator (host policy). A page
   opened from an invite (`?room=CODE`) picks the mode and fills in the code; the player still
   presses Join. A malformed code is refused in the form; an unknown one, or one for another
   game, gets the stage's message.
2. **Lobby.** The invite link (in a read-only field, with Copy link and Copy code) and the
   code; the seats, each open, the computer at the room's level, or a player marked host, you,
   ready or away; the spectator count; the turn clock. Everyone with a seat presses Ready
   (`aria-pressed`). The host picks the clock, from the manifest's presets (the usual one
   marked) or Off, which is never the default (host policy, host policy), and the computer's level; adds the
   computer to an open seat or removes a seat; and starts once every seat is filled and
   ready. The hint under Start says what it waits for. Leave room gives the seat up.
3. **Play.** When the match starts the stage mounts the game on the remote session. The bar
   shows the room code, the connection ("Connection lost. Reconnecting…"), and the running
   turn clock (`role="timer"`). The menu doesn't pause a room ("The match goes on while this
   menu is open") and offers Leave room. A newer tab taking the seat shows "Use this tab
   instead". Hosts can't remove a player mid-match (host policy).
4. **Results** show over the final board as for local play, worded for the viewer ("You
   won!", "Ben wins", or "Ben wins!" for a spectator). The host's Rematch starts a new match
   in the same room, on a fresh canvas; Leave room goes back to the setup.

The stage reports the room after every change as a `Room` output (`RoomFrame`: plain data,
checked at the boundary) and performs the lobby's requests (`StageControl.roomRequests`) in
order. The room's code goes in the address bar while it is open (`history.replaceState`),
so a reload or a shared address finds it again. `LauncherServices.rooms` (`RoomServices`) is
how the stage reaches the room server; the default (`browser/rooms.ts`) uses the page's own
origin, where Traefik routes `/api/rooms` and `/ws`, and tests pass a loopback.

## The daily puzzle

For a manifest that lists `daily` (host policy, content-pipeline.md (Joystyk host reference)):

1. **After the notice.** The stage downloads nothing until the game may start: an AI-content
   game's notice comes first (host policy).
2. **Today's puzzle.** It asks `@joystyk/daily/browser`'s content client for today's UTC date
   (`LauncherServices.daily`: the base URL, default `/daily`, a `fetch` and the wall clock).
   The client revalidates the index, uses or refreshes the cached file and decodes `config`
   with the engine's `schemas.config`; offline, a cached copy plays. With nothing to play, the
   stage fails with the client's plain message ("This puzzle needs a connection…").
3. **Played once.** If the results store already holds today's result, the launcher shows it
   ("You've played today's puzzle") with the streak and share text, and mounts nothing.
   Otherwise the game starts on the day's config (a resumed save finishes the puzzle it holds,
   even after the next release, and its result counts for that puzzle's date).
4. **Results.** At the outcome the stage records the `DailyResult` (with the engine's `share`
   rows in both forms), reads the streaks and reports a `Daily` frame. The results show the
   streak, the win streak for a daily that can be lost, "New puzzle at 8:00 PM (in 6 hours)"
   in local time, the share preview, *Share* (Web Share, else the clipboard) and *Copy as
   text*. There is no Play again; *Change mode* appears when the game has other modes.
5. **Prefetch.** `dailyPrefetchers(services, gameIds)` gives the PWA's `registerPwa` one
   prefetcher per daily game. It prefetches today and tomorrow through the same client and
   storage, and nothing for an AI-content game until the notice is accepted.

## What the game gets

`mount` receives the canvas, a `<div>` in the stage's own shadow root (the frame's styles
never reach it), and a `PlatformApi`:

| Field | Source |
| --- | --- |
| `storage` | `@joystyk/storage`'s game storage, scoped to the game id and the player |
| `preferences` | The stored preferences resolved against the system (reduced motion, sound and volume, single-key shortcuts, color scheme, locale), updated live when the player changes them in the overlay or the system setting changes |
| `announce` | The launcher's polite and assertive live regions |
| `requestExit` | Back to the setup, saving the game |

**Theme handoff.** The canvas carries the manifest's theme as `--game-accent`,
`--game-surface` and `--game-ink`, and the player's color scheme, which resolves any
`light-dark()` pair; the frame keeps Joystyk's tokens. It paints the surface and sets its
text color to the ink. A surface and its ink always follow the same scheme: a single surface
without an ink gets near-black or near-white, whichever reads better (`readableInk`), and a
game without a surface gets the frame's own surface and text. `canvasTheme` in `src/theme.ts`
computes the tokens; the rules are in the
game contract (Joystyk host reference) ("Theme").

## The frame's screens

- **Hand-off (host policy).** When the session publishes a `handoff`, the canvas is hidden and the
  frame shows "Pass to <name>, then tap to reveal". Focus moves to the reveal button.
- **Results over the final board.** The results open as a non-modal `<dialog>` laid over the
  canvas, out of the flow, so neither the board nor the page moves; a board shorter than the
  results scrolls them. The canvas stays mounted, dimmed and `inert` behind them. Focus moves
  to the headline, which names the dialog. Escape or "Review the board" closes the results
  and moves focus to the board, which can be read (and heard) again but not played: the
  session refuses moves once the game is over. "Show results" in the bar reopens them, with
  the same ad slot. The dialog is not modal because a modal one would make the page inert,
  and the results are where the PWA may offer an update.
- **Overlay.** The Menu button opens a modal `<dialog>`: Resume, Save and exit, and the
  preferences. The dialog traps focus and closes on Escape; the session is paused while it
  is open. Focus returns to the Menu button.
- **Reduced motion.** The frame's own transitions stop when the system asks for reduced
  motion, unless the player chose full motion, and always when the player chose to reduce
  it. Games receive the resolved value and remove only decorative motion.

## Safe points

The launcher reports every change with a `joystyk:safe-point` event on the document
(`{ safe, gameId }`). The page is safe outside play and on the results screen, open or closed; during play
it is safe only when the session says so (`meta.safePoint`). The PWA listens with
`watchSafePoints` and offers updates only when `safe` is true
(offline-and-updates.md (Joystyk host reference), Rule 2).

A forced security update can't wait for one, so it asks: `requestSave()` dispatches a
`joystyk:save-request` event, and each game stage stops play (pausing a real-time game) and
writes the current position through its save slot. The promise settles once every write has
landed or failed, and at once when no game is in play. Rooms and Layer 1 games add nothing:
the room server keeps a room's state, and those games save themselves.

## Tests

- `model.test.ts` and `launcher.test.ts`: the pure helpers and the component's model, with
  `@gyral/testing`, in Node.
- `theme.test.ts` and `theme.browser.test.ts`: the canvas theme tokens, the picked ink and
  its CSS fallback.
- `fixture/engine.test.ts`: the Tally fixture's rules.
- `launcher.browser.test.ts`: the real stage, runner and storage (memory backend) in
  Chromium: modes from the keyboard, mounting and disposal, theme tokens and readable canvas
  text in light and dark, resume, the hand-off screen, rematch, the AI-content notice, the
  overlay's focus trap and Escape, preferences and reduced motion, safe points, results over
  the inert final board (Escape, Show results, no layout shift, disposal on Play again) and a
  Layer 1 game.
- `launcher.daily.browser.test.ts`: the daily mode with a fake `fetch` and a fixed clock:
  nothing downloads before the notice, the published config plays, the results show the
  streak and share text, a second visit shows today's result, offline with nothing cached says
  so, and the prefetcher waits for the notice.
- `launcher.rooms.browser.test.ts`: Online with friends in Chromium against the real room
  core running in the page (`__tests__/loopback-room.ts`): create, invite, the computer in a
  seat, ready, start, results, rematch and leave; a guest joining from an invite with a
  spectator watching; malformed and unknown codes.
- `apps/site`'s end-to-end tests play Tally and Nim through the launcher on the real server,
  where no room server answers, so online play shows as unavailable; `rooms.e2e.test.ts`
  plays Nim, Greed and Shift 23 rooms on the real site and room servers, and checks that a
  game the room server doesn't host shows online play as coming soon.
