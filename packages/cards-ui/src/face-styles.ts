// The card art's styles on their own, for components that draw single cards rather than a
// whole table: the hand widget (<jy-card-hand>) and a game's trick or discard area. Put
// `suitDefs()` once in the same shadow root, then a card is
// `<div class="cface s-${suit}">${cardFace(rank, suit)}</div>` and a back is `<div class="cback"></div>`.
//
// Every color has a fallback instead of a default on `:host`, so a game themes these cards by
// setting the custom properties on its own element; they inherit into the hand's shadow root:
//   --card-paper, --card-ink, --suit-black, --suit-red, --suit-blue, --suit-green,
//   --back-a, --back-b, --back-c, --card-font, --card-serif.
// A `.four` ancestor turns on the four-color deck (blue diamonds, green clubs); the suit's
// shape and letter always carry the suit, so color is only a second cue.
import { css } from '@gyral/core';

export const faceStyles = css`
  @layer components {
    .defs {
      position: absolute;
      inline-size: 0;
      block-size: 0;
      overflow: hidden;
    }

    .cface,
    .cback {
      box-sizing: border-box;
      aspect-ratio: 5 / 7;
      border-radius: 9%/6.5%;
      box-shadow: 0 1px 2px oklch(0% 0 0 / 0.28);
    }

    .cface {
      background: var(--card-paper, oklch(98.5% 0.008 90));
      border: 1px solid color-mix(in oklch, var(--card-ink, oklch(24% 0.02 260)) 22%, transparent);
      color: var(--card-ink, oklch(24% 0.02 260));
    }

    .cback {
      background-color: var(--back-a, oklch(42% 0.07 250));
      background-image:
        radial-gradient(circle at 50% 50%, var(--back-c, oklch(80% 0.11 85)) 0 9%, transparent 10%),
        repeating-linear-gradient(45deg, var(--back-b, oklch(62% 0.08 250)) 0 1.5px, transparent 1.5px 8px),
        repeating-linear-gradient(-45deg, var(--back-b, oklch(62% 0.08 250)) 0 1.5px, transparent 1.5px 8px);
      border: 1px solid color-mix(in oklch, var(--back-a, oklch(42% 0.07 250)) 70%, black);
    }

    .face {
      display: block;
      inline-size: 100%;
      block-size: 100%;
      fill: var(--suit);
      font-family: var(--card-font, var(--jy-font-sans, system-ui, sans-serif));
      font-weight: 700;
    }

    .face .index {
      font-size: 21px;
      letter-spacing: -0.5px;
    }

    .face .corner {
      font-size: 14px;
    }

    .face .letter {
      font-size: 11px;
      font-weight: 600;
    }

    .face .monogram {
      font-family: var(--card-serif, Georgia, 'Times New Roman', serif);
      font-size: 46px;
    }

    .face .frame {
      fill: color-mix(in oklch, var(--suit) 9%, transparent);
      stroke: var(--suit);
      stroke-width: 2.5;
    }

    .face .crest {
      fill: var(--suit);
    }

    .s-S,
    .s-C {
      --suit: var(--suit-black, oklch(24% 0.02 260));
    }

    .s-H,
    .s-D {
      --suit: var(--suit-red, oklch(52% 0.2 25));
    }

    .four .s-D {
      --suit: var(--suit-blue, oklch(47% 0.17 255));
    }

    .four .s-C {
      --suit: var(--suit-green, oklch(48% 0.13 150));
    }

    @media (forced-colors: active) {
      .face {
        fill: CanvasText;
      }

      .cface,
      .cback {
        border-color: CanvasText;
      }
    }
  }
`;
