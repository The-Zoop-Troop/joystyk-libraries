# @joystyk/arcade

Shared browser helpers for real-time games. It has no Three.js dependency. The platform's
fixed-step runner remains the authority; these helpers send intentions and draw its snapshots.

- `bindInput` maps keys, swipe/tap/drag and standard gamepads to named actions. Printable-key
  shortcuts follow the player's preference; held actions release on blur and disconnect.
- `bindHold` gives native buttons pointer, keyboard and switch activation. `bindHoldPad`
  delegates those events for pads rendered by Gyral; `bindDrag` projects absolute pointer
  movement for paddles. Both share the owning game’s abort signal.
- `bindPause` pauses on hide, blur and page hide; explicit resume waits one second. Its
  injected `after` port makes countdown tests deterministic.
- `createRecords` stores pace and best score/replay through the game's `GameStorage`.
  Another rules version discards the replay and retains the score.
- `createGhost` owns an independent state and RNG. Call `advance(liveTick)` for the ghost view;
  it never dispatches to the live runner. Inputs use the runner's zero-based tick convention.
- `mountArcade` combines the Gyral HUD with these helpers. A game supplies its status, input
  mapping, score and a lazy renderer factory. Daily locks pace and omits ghost races.
  Direct viewport paragraphs are graphics notices: empty notices occupy no space;
  a renderer's nonempty error or recovery message remains visible above the board.
- `createControlDrivers`, `resumeAfter`, `bindPagePause`, `swipeDirection` and the direction
  maps let existing games adopt the helpers without changing their public controls or rules.

Dispose every returned binding when its game leaves the page. Games import this package from
`ui/` or `render/`. The design and performance budgets are in
host policy (Joystyk host reference).
