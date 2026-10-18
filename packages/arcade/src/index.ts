export { bindInput, bindHold, bindHoldPad, bindDrag, type InputAction, type InputOptions } from './input.ts';
export { bindPause, type PauseOptions } from './pause.ts';
export { PACES, createRecords, createGhost, type Pace, type BestRun } from './records.ts';
export { mountArcade, type ArcadeView, type ArcadeDrawing, type ArcadeGameOptions } from './game.ts';
export {
  createControlDrivers,
  resumeAfter,
  bindPagePause,
  swipeDirection,
  SWIPE_THRESHOLD,
  ARROW_DIRECTIONS,
  LETTER_DIRECTIONS,
} from './legacy.ts';
