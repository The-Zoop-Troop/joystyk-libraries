// `@joystyk/testing/fixtures`: small, correct games for platform tests, each with conformance
// options that pass. Runners, rooms and harnesses can use them instead of inventing their own.
//
// | Fixture        | Layer | Exercises                                                          |
// | -------------- | ----- | ------------------------------------------------------------------ |
// | `nim`          | 2     | Public state, runner-driven AI, saves with a migration chain       |
// | `drawPlay`     | 2     | Hidden hands and deck, opaque card ids, redacted events, 2–4 seats |
// | `sealedBids`   | 2     | Simultaneous moves, a custom `decisionKey`, hidden choices         |
// | `diceRace`     | 2     | Jobs: requests, awaited ids, failures; a solo and a 2-seat mode    |
// | `hintPuzzle`   | 2     | Solo hidden information, undo barriers, clockStart, worthSaving    |
// | `drift`        | 3     | A fixed-step simulation with seeded wind and scripted inputs       |

export {
  isNimState,
  nim,
  nimConformance,
  nimMigrations,
  nimSaveFixtures,
  NIM_SAVE_VERSION,
  type NimCommand,
  type NimConfig,
  type NimEvent,
  type NimState,
  type NimView,
} from './nim.ts';
export {
  DRAW_PLAY_CARDS,
  drawPlay,
  drawPlayConformance,
  perturbDrawPlay,
  type DrawPlayCard,
  type DrawPlayCommand,
  type DrawPlayConfig,
  type DrawPlayEvent,
  type DrawPlayState,
  type DrawPlayView,
} from './draw-play.ts';
export {
  perturbSealedBids,
  sealedBids,
  sealedBidsConformance,
  type SealedBidsCommand,
  type SealedBidsConfig,
  type SealedBidsEvent,
  type SealedBidsState,
  type SealedBidsView,
} from './sealed-bids.ts';
export {
  diceRace,
  diceRaceConformance,
  throwDice,
  type DiceRaceCommand,
  type DiceRaceConfig,
  type DiceRaceEvent,
  type DiceRaceState,
  type ThrowPayload,
} from './dice-race.ts';
export {
  hintPuzzle,
  hintPuzzleConformance,
  isHint,
  MAX_HINTS,
  perturbHintPuzzle,
  type Clue,
  type HintPuzzleCommand,
  type HintPuzzleConfig,
  type HintPuzzleEvent,
  type HintPuzzleState,
  type HintPuzzleView,
} from './hint-puzzle.ts';
export {
  drift,
  driftConformance,
  MAX_SPEED,
  type DriftConfig,
  type DriftEvent,
  type DriftInput,
  type DriftState,
  type DriftView,
} from './drift.ts';
