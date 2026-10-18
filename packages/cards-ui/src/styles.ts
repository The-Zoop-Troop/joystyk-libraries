// The card table's styles: a grid of card-sized columns that fits its container, piles that
// fan down, right or not at all, the card faces and three original backs, and the states the
// controller shows (spec: "Not by color alone"): a lifted, outlined pick-up; dashed outlines
// and a drop marker on legal destinations; a thick ring on the focused pile and card.
//
// Games theme the table through inherited custom properties on <jy-card-table>:
//   --table-felt, --table-ink, --table-slot, --table-focus, --table-select, --table-target,
//   --table-hint, --back-a, --back-b, --back-c, --card-paper, --card-ink, --suit-black,
//   --suit-red, --suit-blue, --suit-green, --card-max (the widest card).
// The site's Content Security Policy refuses style attributes, so counts become classes.
import { css } from '@gyral/core';

/** Grid columns, region widths and pile spans as classes (no inline styles). */
const counts = Array.from({ length: 12 }, (_, k) => k + 1)
  .map((n) => `.cols-${n} { --cols: ${n}; } .n-${n} { --n: ${n}; } .w-${n} { grid-column: span ${n}; }`)
  .join('\n');
const positions = Array.from({ length: 49 }, (_, n) => `.pos-c-${n} { grid-column: ${n + 1} / span 4; }`)
  .concat(Array.from({ length: 12 }, (_, n) => `.pos-r-${n} { grid-row: ${n + 1} / span 2; }`))
  .join('\n');

export const tableStyles = css`
  @layer components {
    ${counts}
    ${positions}

    :host {
      --table-felt: oklch(93% 0.03 85);
      --table-ink: oklch(25% 0.03 60);
      --table-slot: color-mix(in oklch, var(--table-ink) 28%, transparent);
      --table-focus: oklch(55% 0.2 255);
      --table-select: oklch(62% 0.19 45);
      --table-target: oklch(50% 0.17 150);
      --table-hint: oklch(72% 0.16 85);
      --back-a: oklch(42% 0.07 250);
      --back-b: oklch(62% 0.08 250);
      --back-c: oklch(80% 0.11 85);
      --card-paper: oklch(98.5% 0.008 90);
      --card-ink: oklch(24% 0.02 260);
      --suit-black: oklch(24% 0.02 260);
      --suit-red: oklch(52% 0.2 25);
      --suit-blue: oklch(47% 0.17 255);
      --suit-green: oklch(48% 0.13 150);

      display: block;
      container-type: inline-size;
      color: var(--table-ink);
    }

    .defs {
      position: absolute;
      inline-size: 0;
      block-size: 0;
      overflow: hidden;
    }

    .table {
      --gap: clamp(0.2rem, 1.3cqi, 0.85rem);
      --card-w: min(calc((100cqi - (var(--cols) - 1) * var(--gap)) / var(--cols)), var(--card-max, 7.5rem));
      --card-h: calc(var(--card-w) * 1.4);
      --radius: calc(var(--card-w) * 0.09);
      --fan-down: calc(var(--card-h) * 0.1);
      --fan-up: calc(var(--card-h) * 0.25);
      --fan-right: calc(var(--card-w) * 0.32);

      display: grid;
      grid-template-columns: repeat(var(--cols), var(--card-w));
      justify-content: center;
      column-gap: var(--gap);
      row-gap: calc(var(--gap) * 2 + 0.5rem);
      padding-block: 0.6rem calc(var(--card-h) * 0.4);
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }

    .region {
      display: grid;
      grid-template-columns: subgrid;
      align-items: start;
      grid-row: var(--row);
    }
    .free-placement {
      grid-template-columns: repeat(calc(var(--cols) * 4), minmax(0, 1fr));
      grid-auto-rows: calc(var(--card-h) / 2);
      column-gap: 0;
      align-items: start;
    }
    .free-placement .pile {
      inline-size: var(--card-w);
      padding-block-end: 0;
    }
    .free-placement .pile.empty { pointer-events: none; }
    .pile-badge {
      position: absolute;
      inset-block-end: 0;
      inset-inline-end: 0;
      padding: 0.15em 0.3em;
      border: 2px solid currentColor;
      border-radius: 0.3em;
      background: var(--card-paper);
      color: var(--card-ink);
      font: 700 0.85rem/1.2 system-ui;
      z-index: 2;
    }

    .at-top-start {
      --row: 1;
      grid-column: 1 / span var(--n);
    }

    .at-top-end {
      --row: 1;
      grid-column: span var(--n) / -1;
    }

    .at-main {
      --row: 2;
      grid-column: 1 / -1;
      align-items: stretch;
    }

    .at-bottom-start {
      --row: 3;
      grid-column: 1 / span var(--n);
    }

    .at-bottom-end {
      --row: 3;
      grid-column: span var(--n) / -1;
    }

    /* A pile: its cards in flow, each pulled up over the one before it. */
    .pile {
      position: relative;
      display: flex;
      flex-direction: column;
      min-block-size: var(--card-h);
      border-radius: var(--radius);
      outline: none;
      cursor: default;
    }

    .at-main .pile {
      /* The whole column is the drop target (spec: Pointer). */
      padding-block-end: calc(var(--card-h) * 0.5);
    }

    .fan-right {
      flex-direction: row;
    }

    .slot {
      position: absolute;
      inset-block-start: 0;
      inset-inline-start: 0;
      display: grid;
      place-items: center;
      inline-size: var(--card-w);
      block-size: var(--card-h);
      border: 2px solid var(--table-slot);
      border-radius: var(--radius);
      color: var(--table-slot);
      font-size: calc(var(--card-w) * 0.42);
      font-weight: 700;
      line-height: 1;
    }

    .card {
      position: relative;
      flex: none;
      inline-size: var(--card-w);
      block-size: var(--card-h);
      border-radius: var(--radius);
      box-shadow: 0 1px 2px oklch(0% 0 0 / 0.28);
      transition:
        translate 140ms ease-out,
        box-shadow 140ms ease-out;
    }

    .card + .card {
      margin-block-start: calc(var(--fan-up) - var(--card-h));
    }

    .card.down + .card {
      margin-block-start: calc(var(--fan-down) - var(--card-h));
    }

    .fan-stack .card + .card,
    .fan-stack .card.down + .card {
      margin-block-start: calc(-1 * var(--card-h));
    }

    .fan-right .card + .card,
    .fan-right .card.down + .card {
      margin-block-start: 0;
      margin-inline-start: calc(var(--fan-right) - var(--card-w));
    }

    /* Long columns overlap more tightly; the top strip of each face-up card stays visible. */
    .dense-1 {
      --fan-up: calc(var(--card-h) * 0.21);
      --fan-down: calc(var(--card-h) * 0.08);
    }

    .dense-2 {
      --fan-up: calc(var(--card-h) * 0.18);
      --fan-down: calc(var(--card-h) * 0.06);
    }

    .dense-3 {
      --fan-up: calc(var(--card-h) * 0.165);
      --fan-down: calc(var(--card-h) * 0.05);
    }

    /*
     * Narrow cards, under 3.5rem wide (Spider, FreeCell and Klondike on a phone; bead
     * gp-dx1). At that size the strip's suit symbol drew about 6 CSS pixels tall, so it
     * grows 2.4 times, to at least 12 pixels each way on a 32-pixel card (a diamond is the
     * narrowest shape), and the rank by 40%; the middle's pips, too small to read there,
     * give way. A column then leaves 40% of each face-up card showing, whatever its density,
     * so the taller strip is never covered. The step below switches at the same width as the
     * container query: (3.5rem - card width) × 1000 is 0 or less at 3.5rem and wider, and
     * far above the 40% cap when narrower.
     */
    .card {
      container: card / inline-size;
    }

    .fan-down .card.up + .card {
      margin-block-start: calc(max(var(--fan-up), clamp(0px, (3.5rem - var(--card-w)) * 1000, var(--card-h) * 0.4)) - var(--card-h));
    }

    @container card (inline-size < 3.5rem) {
      .index {
        font-size: 30px;
        translate: 0 4px;
      }

      .suit-index {
        transform-origin: 93px 2px;
        scale: 2.4;
        translate: 4px 0;
      }

      .middle {
        display: none;
      }
    }

    .up {
      background: var(--card-paper);
      border: 1px solid color-mix(in oklch, var(--card-ink) 22%, transparent);
      touch-action: none;
      cursor: grab;
    }

    .face {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      fill: var(--suit);
      font-family: var(--card-font, var(--jy-font-sans, system-ui, sans-serif));
      font-weight: 700;
    }

    .index {
      font-size: 21px;
      letter-spacing: -0.5px;
    }

    .corner {
      font-size: 14px;
    }

    .letter {
      font-size: 11px;
      font-weight: 600;
    }

    .monogram {
      font-family: var(--card-serif, Georgia, 'Times New Roman', serif);
      font-size: 46px;
    }

    .frame {
      fill: color-mix(in oklch, var(--suit) 9%, transparent);
      stroke: var(--suit);
      stroke-width: 2.5;
    }

    .crest {
      fill: var(--suit);
    }

    .s-S,
    .s-C {
      --suit: var(--suit-black);
    }

    .s-H,
    .s-D {
      --suit: var(--suit-red);
    }

    .four .s-D {
      --suit: var(--suit-blue);
    }

    .four .s-C {
      --suit: var(--suit-green);
    }

    /* Backs: original patterns, colored by the game's theme. */
    .down {
      background-color: var(--back-a);
      border: 1px solid color-mix(in oklch, var(--back-a) 70%, black);
      box-shadow:
        inset 0 0 0 calc(var(--card-w) * 0.05) var(--back-a),
        inset 0 0 0 calc(var(--card-w) * 0.07) var(--back-c),
        0 1px 2px oklch(0% 0 0 / 0.28);
    }

    .back-lattice .down {
      background-image:
        radial-gradient(circle at 50% 50%, var(--back-c) 0 9%, transparent 10%),
        repeating-linear-gradient(45deg, var(--back-b) 0 1.5px, transparent 1.5px 8px),
        repeating-linear-gradient(-45deg, var(--back-b) 0 1.5px, transparent 1.5px 8px);
    }

    .back-web .down {
      background-image:
        repeating-radial-gradient(circle at 50% 50%, transparent 0 6px, var(--back-b) 6px 7px),
        repeating-conic-gradient(from 15deg at 50% 50%, var(--back-b) 0 1.2deg, transparent 1.2deg 30deg);
    }

    .back-cells .down {
      background-image:
        radial-gradient(circle at 50% 50%, var(--back-c) 0 2px, transparent 2.5px),
        linear-gradient(var(--back-b) 1px, transparent 1px),
        linear-gradient(90deg, var(--back-b) 1px, transparent 1px);
      background-size:
        9px 9px,
        9px 9px,
        9px 9px;
    }
    .back-terraces .down {
      background-image: repeating-linear-gradient(0deg, transparent 0 8px, var(--back-b) 8px 10px), repeating-linear-gradient(90deg, transparent 0 13px, var(--back-c) 13px 14px);
    }
    .back-contours .down {
      background-image: repeating-radial-gradient(ellipse at 15% 80%, transparent 0 9px, var(--back-b) 9px 10px, transparent 10px 14px);
    }
    .back-dunes .down {
      background-image: repeating-radial-gradient(ellipse at 120% 120%, transparent 0 7px, var(--back-b) 7px 9px, transparent 9px 16px);
    }

    /* Focus: the pile, and in a pile the card Enter would pick up. */
    .pile:focus-visible {
      outline: 3px solid var(--table-focus);
      outline-offset: 3px;
    }

    .pile:focus-visible .pointed {
      outline: 3px solid var(--table-focus);
      outline-offset: 1px;
    }

    /* Picked up: lifted, with a shadow and a thick outline. */
    .held {
      z-index: 2;
      translate: 0 calc(var(--card-h) * -0.07);
      box-shadow: 0 0.5rem 1rem oklch(0% 0 0 / 0.35);
      outline: 3px solid var(--table-select);
      outline-offset: 1px;
    }

    .dragging {
      z-index: 20;
      pointer-events: none;
      transition: none;
      cursor: grabbing;
    }

    /* Legal destinations: a dashed outline and a drop marker, not just a tint. */
    .target::after,
    .hint-to::after {
      content: '';
      position: absolute;
      inset: -5px;
      border: 3px dashed var(--table-target);
      border-radius: calc(var(--radius) + 4px);
      pointer-events: none;
    }

    .drop {
      display: none;
      position: absolute;
      z-index: 3;
      inset-block-start: -0.95rem;
      inset-inline-start: 50%;
      translate: -50% 0;
      border: 0.5rem solid transparent;
      border-block-end-width: 0;
      border-block-start-color: var(--table-target);
      pointer-events: none;
    }

    .target .drop {
      display: block;
    }

    .over::after {
      border-style: solid;
      background: color-mix(in oklch, var(--table-target) 16%, transparent);
    }

    .hint-to::after {
      border-color: var(--table-hint);
    }

    .hinted {
      outline: 4px solid var(--table-hint);
      outline-offset: 1px;
      animation: hint 0.9s ease-in-out 2;
    }

    @keyframes hint {
      50% {
        translate: 0 calc(var(--card-h) * -0.06);
      }
    }

    .calm .card,
    .calm .hinted {
      transition: none;
      animation: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .card,
      .hinted {
        transition: none;
        animation: none;
      }
    }

    @media (forced-colors: active) {
      .pile:focus-visible,
      .pile:focus-visible .pointed,
      .held {
        outline-color: Highlight;
      }

      .target::after,
      .hint-to::after {
        border-color: LinkText;
      }

      .face {
        fill: CanvasText;
      }
    }
  }
`;
