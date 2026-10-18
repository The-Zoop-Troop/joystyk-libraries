// `@joystyk/cards-ui`: the card table every card game shares, so drag and drop, click-to-move,
// smart moves, the keyboard model and screen-reader names are learned once
// (klondike.md, "Interaction and accessibility"; hearts.md, "Shared needs"), and the hand
// widget the multiplayer card games share, <jy-card-hand>.
export { CardTable, FLIGHT_MS, density, shownCards, type TableMsg, type TableProps, type TableState } from './table.ts';
export {
  DRAG_THRESHOLD,
  describe,
  focusedPile,
  initialCtl,
  spoken,
  step,
  sync,
  type Ctl,
  type CtlMsg,
  type Held,
  type Press,
  type Step,
  type TableOut,
  type Via,
} from './controller.ts';
export {
  DEFAULT_OPTIONS,
  EMPTY_LAYOUT,
  allPiles,
  findPile,
  isFaceCard,
  isTableLayout,
  isTableOptions,
  isTarget,
  topCards,
  type Back,
  type DownCard,
  type FaceCard,
  type Fan,
  type HintSpec,
  type PileCard,
  type PileSpec,
  type Place,
  type RegionSpec,
  type TableLayout,
  type TableOptions,
} from './layout.ts';
export { PIPS, SUIT_PATHS, cardFace, rankLabel, suitDefs } from './faces.ts';
export { tableStyles } from './styles.ts';
export { faceStyles } from './face-styles.ts';
export {
  CardHand,
  DEFAULT_HAND_OPTIONS,
  EMPTY_HAND,
  handCardLabel,
  handStep,
  initialHand,
  isHandLayout,
  isHandOptions,
  syncHand,
  type HandCard,
  type HandLayout,
  type HandMode,
  type HandMsg,
  type HandOptions,
  type HandOut,
  type HandState,
  type HandStep,
} from './hand.ts';

export { tileFace } from './tiles.ts';
