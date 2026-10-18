// The card art, drawn for Joystyk (klondike.md, "Theme"): four suit shapes with distinct
// silhouettes, number cards with pip layouts, and monogram court cards (a framed letter
// under a simple geometric crest), never traditional court figures. Every face shows its
// rank and suit shape in a top strip, the part a fanned column leaves visible, and the rank
// with the suit's letter in the opposite corner, so a suit never depends on color or on one
// glyph alone. Faces are SVG in a 100 × 140 box; the card's shape and back are CSS. The
// strip's rank (`.index`) and suit (`.suit-index`) and the middle (`.middle`) carry classes,
// so the card table can enlarge the strip on narrow cards (styles.ts).
import { html, svg } from '@gyral/core';
import type { Rank, Suit } from '@joystyk/kit/cards';

/** Suit shapes in a 100 × 100 box, each its own silhouette. */
export const SUIT_PATHS: Readonly<Record<Suit, string>> = {
  // A spade: a pointed leaf over a flared stem.
  S: 'M50 4C64 26 94 40 94 62C94 76 84 85 72 85C63 85 56 80 53 73C54 83 59 91 67 96H33C41 91 46 83 47 73C44 80 37 85 28 85C16 85 6 76 6 62C6 40 36 26 50 4Z',
  // A heart: two round lobes meeting in a point.
  H: 'M50 92C22 70 4 52 4 30C4 14 16 4 29 4C39 4 46 10 50 19C54 10 61 4 71 4C84 4 96 14 96 30C96 52 78 70 50 92Z',
  // A diamond with gently curved sides.
  D: 'M50 2Q64 28 88 50Q64 72 50 98Q36 72 12 50Q36 28 50 2Z',
  // A club: three round leaves over a flared stem.
  C: 'M50 8A19 19 0 1 1 49.9 8ZM27 38A19 19 0 1 1 26.9 38ZM73 38A19 19 0 1 1 72.9 38ZM46 58Q46 84 33 96H67Q54 84 54 58Z',
};

const RANK_LABELS: Readonly<Record<Rank, string>> = {
  1: 'A',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
};

/** The rank as the card prints it: "A", "7", "10", "Q". */
export const rankLabel = (rank: Rank): string => RANK_LABELS[rank];

/** The suit symbols, once per table; faces refer to them with `<use>`. */
export const suitDefs = () =>
  html`<svg class="defs" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      <symbol id="suit-S" viewBox="0 0 100 100"><path d=${SUIT_PATHS.S} /></symbol>
      <symbol id="suit-H" viewBox="0 0 100 100"><path d=${SUIT_PATHS.H} /></symbol>
      <symbol id="suit-D" viewBox="0 0 100 100"><path d=${SUIT_PATHS.D} /></symbol>
      <symbol id="suit-C" viewBox="0 0 100 100"><path d=${SUIT_PATHS.C} /></symbol>
    </defs>
  </svg>`;

/** One suit shape, `size` wide, centered on (x, y); `flip` turns it upside down. */
const pip = (suit: Suit, x: number, y: number, size: number, flip = false, cls: string | null = null) =>
  svg`<use class=${cls} href=${`#suit-${suit}`} x=${x - size / 2} y=${y - size / 2} width=${size} height=${size} transform=${flip ? `rotate(180 ${x} ${y})` : null} />`;

const L = 31;
const C = 50;
const R = 69;

/** Pip centers for 2–10, in the area below the top strip. Lower pips print upside down. */
export const PIPS: Readonly<Record<number, readonly (readonly [number, number])[]>> = {
  2: [
    [C, 44],
    [C, 118],
  ],
  3: [
    [C, 44],
    [C, 81],
    [C, 118],
  ],
  4: [
    [L, 44],
    [R, 44],
    [L, 118],
    [R, 118],
  ],
  5: [
    [L, 44],
    [R, 44],
    [C, 81],
    [L, 118],
    [R, 118],
  ],
  6: [
    [L, 44],
    [R, 44],
    [L, 81],
    [R, 81],
    [L, 118],
    [R, 118],
  ],
  7: [
    [L, 44],
    [R, 44],
    [C, 62],
    [L, 81],
    [R, 81],
    [L, 118],
    [R, 118],
  ],
  8: [
    [L, 44],
    [R, 44],
    [C, 62],
    [L, 81],
    [R, 81],
    [C, 100],
    [L, 118],
    [R, 118],
  ],
  9: [
    [L, 44],
    [R, 44],
    [L, 69],
    [R, 69],
    [C, 81],
    [L, 93],
    [R, 93],
    [L, 118],
    [R, 118],
  ],
  10: [
    [L, 44],
    [R, 44],
    [C, 56],
    [L, 69],
    [R, 69],
    [L, 93],
    [R, 93],
    [C, 106],
    [L, 118],
    [R, 118],
  ],
};

/** A geometric crest above a court card's letter: a crown's points, a band of beads, a chevron. */
const crest = (rank: 11 | 12 | 13) => {
  switch (rank) {
    case 13:
      return svg`<path class="crest" d="M30 62L34 44L42 54L50 38L58 54L66 44L70 62Z" />`;
    case 12:
      return svg`<g class="crest">
        <path d="M30 60Q50 40 70 60Z" />
        <circle cx="30" cy="54" r="4" /><circle cx="50" cy="42" r="4.5" /><circle cx="70" cy="54" r="4" />
      </g>`;
    case 11:
      return svg`<path class="crest" d="M30 48L50 60L70 48L70 56L50 68L30 56Z" />`;
  }
};

/** The middle of a face: pips, the ace's single large shape, or a court card's monogram. */
const middle = (rank: Rank, suit: Suit) => {
  if (rank === 1) return pip(suit, 50, 82, 46);
  if (rank >= 11) {
    const court = rank as 11 | 12 | 13;
    return svg`<rect class="frame" x="17" y="32" width="66" height="96" rx="9" />
      ${crest(court)}
      <text class="monogram" x="50" y="108" text-anchor="middle">${RANK_LABELS[rank]}</text>
      ${pip(suit, 27, 120, 12)}${pip(suit, 73, 120, 12)}`;
  }
  return (PIPS[rank] ?? []).map(([x, y]) => pip(suit, x, y, 17, y > 82));
};

/** A face-up card's art. Decoration only: the pile's accessible name says what the card is. */
export const cardFace = (rank: Rank, suit: Suit) =>
  html`<svg class="face" viewBox="0 0 100 140" aria-hidden="true" focusable="false">
    <text class="index" x="7" y="22">${RANK_LABELS[rank]}</text>
    ${pip(suit, 82, 13, 22, false, 'suit-index')}
    <g class="middle">${middle(rank, suit)}</g>
    <g transform="rotate(180 50 70)">
      <text class="corner" x="7" y="16">${RANK_LABELS[rank]}</text>
      <text class="letter" x="7" y="29">${suit}</text>
    </g>
  </svg>`;
