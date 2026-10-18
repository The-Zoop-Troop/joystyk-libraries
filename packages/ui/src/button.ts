import { css, define, html, outputs, prop, type PropsOf } from '@gyral/core';

/**
 * `<jy-button>`: the frame's button. It wraps a native `<button>`, so it gets keyboard
 * activation, focus and the button role from the platform. The label is the element's
 * content: `<jy-button>Play</jy-button>`.
 *
 * With the `toggle` attribute it is a toggle button: it exposes `aria-pressed`, flips on
 * each activation and starts from the `pressed` attribute.
 *
 * Outputs (listen with `child()` in a Gyral parent, or `OUTPUT_EVENT` elsewhere):
 * - `{ _tag: 'Activated' }` for a plain button;
 * - `{ _tag: 'Toggled', pressed }` for a toggle button, with the new state.
 */
const props = {
  toggle: prop.boolean(),
  pressed: prop.boolean(),
};
export type ButtonProps = PropsOf<typeof props>;

export interface ButtonState {
  readonly pressed: boolean;
}

export type ButtonMsg = { readonly _tag: 'Activate' };

export type ButtonOutput = { readonly _tag: 'Activated' } | { readonly _tag: 'Toggled'; readonly pressed: boolean };

const emit = outputs<ButtonOutput>();

const styles = css`
  @layer components {
    :host {
      display: inline-block;
    }

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--jy-space-2xs, 0.5rem);
      min-block-size: var(--jy-target-min, 2.75rem);
      min-inline-size: var(--jy-target-min, 2.75rem);
      padding-block: var(--jy-space-2xs, 0.5rem);
      padding-inline: var(--jy-space-s, 1rem);
      border: 1px solid transparent;
      border-radius: var(--jy-radius-pill, 999px);
      background: var(--jy-accent, oklch(50% 0.2 285));
      color: var(--jy-on-accent, oklch(99% 0.005 285));
      font: inherit;
      font-weight: 600;
      line-height: 1.2;
      cursor: pointer;
      touch-action: manipulation;
      transition:
        background-color var(--jy-duration-fast, 120ms) var(--jy-ease-out, ease-out),
        scale var(--jy-duration-fast, 120ms) var(--jy-ease-out, ease-out);

      &:hover {
        background: var(--jy-accent-hover, oklch(44% 0.2 285));
      }

      &:active {
        scale: 0.97;
      }

      &:focus-visible {
        outline: 2px solid var(--jy-focus-ring, oklch(55% 0.22 285));
        outline-offset: 2px;
      }

      &[aria-pressed='false'] {
        border-color: var(--jy-border, currentColor);
        background: var(--jy-surface-raised, Canvas);
        color: var(--jy-text, CanvasText);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button:active {
        scale: none;
      }
    }

    @media (forced-colors: active) {
      button {
        border-color: ButtonText;
      }

      button[aria-pressed='true'] {
        background: Highlight;
        color: HighlightText;
      }
    }
  }
`;

export const Button = define<ButtonState, ButtonMsg, ButtonProps, ButtonOutput>()('jy-button', {
  props,
  init: (p) => ({ pressed: p.pressed }),
  intent: {
    Activate: () => ({ _tag: 'Activate' }),
  },
  update: {
    Activate: (s, _m, { props: p }) => {
      if (!p.toggle) return [s, [emit({ _tag: 'Activated' })]];
      const pressed = !s.pressed;
      return [{ pressed }, [emit({ _tag: 'Toggled', pressed })]];
    },
    // A parent that changes `pressed` takes control of the toggle state.
    PropsChanged: (s, { props: p, prev }) => (p.pressed === prev.pressed ? s : { pressed: p.pressed }),
  },
  view: (s, i, { props: p }) => html`
    <button
      type="button"
      part="button"
      aria-pressed=${p.toggle ? String(s.pressed) : null}
      data-intent=${i.Activate}
    >
      <slot></slot>
    </button>
  `,
  styles,
});

declare global {
  interface HTMLElementTagNameMap {
    'jy-button': InstanceType<typeof Button>;
  }
}
