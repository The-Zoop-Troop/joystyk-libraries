// The hand widget's layout: a fan of overlapping cards that fits its container. Each card
// shows at least a 44 px strip (hearts.md, "Keyboard and pointer controls"); when the fan
// can't fit at that, it wraps onto another row. Chosen cards lift with an outline, cards that
// can't be played sit lower behind a hatch, and the focused card gets a thick ring: none of
// these rely on color alone. Theme with --hand-focus, --hand-select and --hand-note.
// The site's Content Security Policy refuses style attributes, so the card count is a class.
import { css } from '@gyral/core';

const counts = Array.from({ length: 32 }, (_, k) => `.n-${k + 1} { --n: ${k + 1}; }`).join('\n');

export const handStyles = css`
  @layer components {
    ${counts}

    :host {
      display: block;
      container-type: inline-size;
    }

    .hand {
      --card-w: clamp(3.6rem, 16cqi, 6.5rem);
      --card-h: calc(var(--card-w) * 1.4);
      --step: clamp(2.75rem, calc((100cqi - var(--card-w) - 0.5rem) / max(1, var(--n, 1) - 1)), calc(var(--card-w) * 0.66));

      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      row-gap: 0.4rem;
      padding-block-start: calc(var(--card-h) * 0.2);
      padding-inline-end: calc(var(--card-w) - var(--step));
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
    }

    .hand.tiles { --card-h: calc(var(--card-w) * 2); }
    .hand.tiles .slot { touch-action: none; }
    .hand.tiles .slot:not(.off) .cface { outline: 2px solid var(--hand-select, oklch(40% .06 170)); outline-offset: 1px; translate: 0 -.25rem; }

    .slot {
      position: relative;
      flex: none;
      inline-size: var(--step);
      block-size: var(--card-h);
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
      touch-action: manipulation;
    }

    .slot .cface {
      position: absolute;
      inset-block-start: 0;
      inset-inline-start: 0;
      inline-size: var(--card-w);
      block-size: var(--card-h);
      transition: translate 140ms ease-out;
    }

    .slot:focus-visible {
      outline: none;
    }

    .slot:focus-visible .cface {
      outline: 3px solid var(--hand-focus, oklch(55% 0.2 255));
      outline-offset: 2px;
      z-index: 1;
    }

    .chosen .cface {
      translate: 0 calc(var(--card-h) * -0.18);
      outline: 3px solid var(--hand-select, oklch(62% 0.19 45));
      outline-offset: 1px;
    }

    .off .cface {
      translate: 0 calc(var(--card-h) * 0.06);
      cursor: not-allowed;
    }

    .off .cface::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: repeating-linear-gradient(135deg, oklch(40% 0.02 260 / 0.22) 0 3px, transparent 3px 7px);
      pointer-events: none;
    }

    /* A noted card (just received) carries a corner tab, besides the word in its name. */
    .noted .cface::before {
      content: '';
      position: absolute;
      inset-block-start: -0.35rem;
      inset-inline-end: 0.3rem;
      inline-size: 0.7rem;
      block-size: 0.7rem;
      border-radius: 50%;
      background: var(--hand-note, oklch(62% 0.19 45));
      border: 2px solid var(--card-paper, oklch(98.5% 0.008 90));
    }

    .calm .slot .cface {
      transition: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .slot .cface {
        transition: none;
      }
    }

    @media (forced-colors: active) {
      .slot:focus-visible .cface,
      .chosen .cface {
        outline-color: Highlight;
      }
    }
  }
`;
