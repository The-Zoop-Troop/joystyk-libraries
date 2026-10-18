import type { ChildValue } from '@gyral/core';
// <jy-card-hand>: the player's own hand in a multiplayer card game (hearts.md, "Shared needs"
// and "Keyboard and pointer controls"). The hand is one Tab stop, a toolbar of card buttons
// with a roving focus: Left and Right move along it, Home and End jump to its ends. Each card
// is a real <button> named in full ("Queen of spades"), never by glyph.
//
// Two modes, chosen by the game for the current decision:
// - `play`: Enter, Space or a tap plays the card. A card that can't be played now is
//   `aria-disabled`; activating it reports `Refused`, so the game can say why.
// - `choose`: a multi-card choice such as Hearts' pass. Space or a tap toggles a card
//   (`aria-pressed`), and Enter reports `Commit`.
//
// The hand knows no rules: the game passes the cards with what each may do, and the engine
// still decides. Other keys bubble to the game, which adds its own (H, T, S…). Cards are
// fanned and overlap; each keeps at least a 44 px strip, and the fan wraps onto a second row
// on narrow screens rather than shrink below it. Focus follows the hand when a played card
// leaves it.
import { define, each, focus, html, intentsOf, outputs, prop, type Command } from '@gyral/core';
import { cardName, type Rank, type Suit } from '@joystyk/kit/cards';
import { cardFace, suitDefs } from './faces.ts';
import { tileName, type TileFace } from '@joystyk/kit/tiles';
import { tileFace } from './tiles.ts';
import { handStyles } from './hand-styles.ts';
import { faceStyles } from './face-styles.ts';

/** One card in the hand, with what the player may do with it now. */
export type HandCard = (
  | {
      readonly tile?: never;
      readonly id: string;
      readonly rank: Rank;
      readonly suit: Suit;
    }
  | { readonly tile: TileFace; readonly rank?: never; readonly suit?: never }
) & {
  readonly id: string;
  /** It may be played (or chosen) now. A card that may not is aria-disabled. */
  readonly playable: boolean;
  /** Chosen for a multi-card choice (aria-pressed), drawn lifted. */
  readonly chosen?: boolean;
  /** Added to the card's name and marked on its face: "just received". */
  readonly note?: string;
};

export type HandMode = 'play' | 'choose';

export type HandLayout = {
  /** The hand's name: "Your hand, 13 cards". */
  readonly label: string;
  /** In display order. */
  readonly cards: readonly HandCard[];
  readonly mode: HandMode;
};

export type HandOptions = {
  /** Reduced motion: chosen cards lift without a transition. */
  readonly calm: boolean;
  /** Blue diamonds and green clubs. */
  readonly fourColor: boolean;
  readonly numbers?: boolean;
  readonly draggable?: boolean;
};

/** What the hand tells the game. */
export type HandOut =
  | { readonly _tag: 'Play'; readonly id: string }
  | { readonly _tag: 'Refused'; readonly id: string }
  | { readonly _tag: 'Toggle'; readonly id: string }
  | { readonly _tag: 'Commit' };

export type HandState = {
  /** The index of the card the Tab stop is on. */
  readonly focus: number;
  /** The ids last rendered, to keep the focus on the same card when the hand changes. */
  readonly ids: readonly string[];
  /** Focus is inside the hand, so a card that leaves it hands the focus on. */
  readonly inside: boolean;
};

export type HandMsg =
  | { readonly _tag: 'Key'; readonly key: string }
  | { readonly _tag: 'Press'; readonly id: string }
  | { readonly _tag: 'Enter'; readonly id: string }
  | { readonly _tag: 'Leave' };

export const EMPTY_HAND: HandLayout = { label: 'Your hand', cards: [], mode: 'play' };
export const DEFAULT_HAND_OPTIONS: HandOptions = { calm: false, fourColor: false };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const isHandLayout = (value: unknown): value is HandLayout =>
  isRecord(value) &&
  typeof value['label'] === 'string' &&
  Array.isArray(value['cards']) &&
  (value['mode'] === 'play' || value['mode'] === 'choose');

export const isHandOptions = (value: unknown): value is HandOptions =>
  isRecord(value) && typeof value['calm'] === 'boolean' && typeof value['fourColor'] === 'boolean';

/** A card's accessible name: "Queen of spades", "9 of hearts, just received". */
export const handCardLabel = (card: HandCard): string =>
  card.note === undefined
    ? card.tile === undefined
      ? cardName(card)
      : tileName(card.tile)
    : `${card.tile === undefined ? cardName(card) : tileName(card.tile)}, ${card.note}`;

const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n));

export const initialHand = (layout: HandLayout): HandState => ({
  focus: 0,
  ids: layout.cards.map((c) => c.id),
  inside: false,
});

/** One step of the hand's controller: the new state, outputs, and a card to focus after rendering. */
export type HandStep = { readonly state: HandState; readonly outs: readonly HandOut[]; readonly focus: string | null };

/**
 * Brings the state in line with a new hand. The focus stays on the same card if it is still
 * there, otherwise on the card now at its place; if focus was inside the hand and its card
 * left, the new card takes the focus.
 */
export const syncHand = (s: HandState, layout: HandLayout): HandStep => {
  const ids = layout.cards.map((c) => c.id);
  const same = ids.length === s.ids.length && ids.every((id, k) => id === s.ids[k]);
  if (same) return { state: s, outs: [], focus: null };
  const was = s.ids[s.focus];
  const kept = was === undefined ? -1 : ids.indexOf(was);
  const index = kept >= 0 ? kept : clamp(s.focus, ids.length - 1);
  const target = ids[index] ?? null;
  const refocus = s.inside && kept < 0 && target !== null;
  return {
    state: { focus: index, ids, inside: s.inside && target !== null },
    outs: [],
    focus: refocus ? target : null,
  };
};

const activate = (layout: HandLayout, card: HandCard, via: 'enter' | 'space' | 'pointer'): HandOut[] => {
  if (layout.mode === 'choose') {
    if (via === 'enter') return [{ _tag: 'Commit' }];
    return card.playable ? [{ _tag: 'Toggle', id: card.id }] : [{ _tag: 'Refused', id: card.id }];
  }
  return card.playable ? [{ _tag: 'Play', id: card.id }] : [{ _tag: 'Refused', id: card.id }];
};

/** The hand's reducer, pure, so its behavior is tested without a DOM. */
export const handStep = (before: HandState, layout: HandLayout, m: HandMsg): HandStep => {
  const s = syncHand(before, layout).state;
  const cards = layout.cards;
  const last = cards.length - 1;
  switch (m._tag) {
    case 'Key': {
      const card = cards[s.focus];
      if (card === undefined) return { state: s, outs: [], focus: null };
      const moveTo = (index: number): HandStep => {
        const next = clamp(index, last);
        return { state: { ...s, focus: next, inside: true }, outs: [], focus: cards[next]!.id };
      };
      switch (m.key) {
        case 'ArrowLeft':
          return moveTo(s.focus - 1);
        case 'ArrowRight':
          return moveTo(s.focus + 1);
        case 'Home':
          return moveTo(0);
        case 'End':
          return moveTo(last);
        case 'Enter':
          return { state: s, outs: activate(layout, card, 'enter'), focus: null };
        case ' ':
          return { state: s, outs: activate(layout, card, 'space'), focus: null };
        default:
          return { state: s, outs: [], focus: null };
      }
    }
    case 'Press': {
      const index = cards.findIndex((c) => c.id === m.id);
      const card = cards[index];
      if (card === undefined) return { state: s, outs: [], focus: null };
      return { state: { ...s, focus: index, inside: true }, outs: activate(layout, card, 'pointer'), focus: null };
    }
    case 'Enter': {
      const index = cards.findIndex((c) => c.id === m.id);
      return { state: { ...s, focus: index >= 0 ? index : s.focus, inside: true }, outs: [], focus: null };
    }
    case 'Leave':
      return { state: { ...s, inside: false }, outs: [], focus: null };
  }
};

/** Keys the hand handles; their default actions (scrolling, a button's click) are suppressed. */
const HAND_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ']);

const emit = outputs<HandOut>();
const i = intentsOf<typeof CardHand>();

type CardView = {
  readonly focused: boolean;
  readonly mode: HandMode;
  readonly calm: boolean;
  readonly numbers: boolean;
  readonly draggable: boolean;
};

const CardButton = (card: HandCard, v: CardView) =>
  html`<button
    type="button"
    class="slot ${card.chosen === true ? 'chosen' : ''} ${card.playable ? '' : 'off'} ${card.note === undefined ? '' : 'noted'}"
    data-card=${card.id}
    draggable=${v.draggable ? 'true' : 'false'}
    tabindex=${v.focused ? 0 : -1}
    aria-label=${handCardLabel(card)}
    aria-disabled=${card.playable ? null : 'true'}
    aria-pressed=${v.mode === 'choose' ? String(card.chosen === true) : null}
    data-intent=${i.Press}
  >
    <span class="cface s-${card.suit ?? 'tile'}">${card.tile === undefined ? cardFace(card.rank, card.suit) : tileFace(card.tile, v.numbers)}</span>
  </button>`;

const run = (s: HandState, layout: HandLayout, m: HandMsg): HandState | readonly [HandState, Command<HandMsg>[]] => {
  const step = handStep(s, layout, m);
  const commands: Command<HandMsg>[] = step.outs.map((out) => emit(out));
  if (step.focus !== null) commands.push(focus(`[data-card="${step.focus}"]`));
  return commands.length === 0 ? step.state : [step.state, commands];
};

export const CardHand = define<
  HandState,
  HandMsg,
  { readonly layout: HandLayout; readonly options: HandOptions },
  HandOut
>()('jy-card-hand', {
  props: {
    layout: prop.value(isHandLayout, { default: EMPTY_HAND }),
    options: prop.value(isHandOptions, { default: DEFAULT_HAND_OPTIONS }),
  },
  init: (p) => initialHand(p.layout),
  intent: {
    Key: ({ key, event }) => {
      if (
        key === undefined ||
        !(event instanceof KeyboardEvent) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return undefined;
      if (!HAND_KEYS.has(key)) return undefined;
      event.preventDefault();
      return { _tag: 'Key', key };
    },
    Press: ({ event }) => {
      const id =
        event.target instanceof Element ? event.target.closest('[data-card]')?.getAttribute('data-card') : null;
      return typeof id === 'string' ? { _tag: 'Press', id } : undefined;
    },
    Enter: ({ event }) => {
      const id =
        event.target instanceof Element ? event.target.closest('[data-card]')?.getAttribute('data-card') : null;
      return typeof id === 'string' ? { _tag: 'Enter', id } : undefined;
    },
    Leave: ({ event, target }) => {
      const next = event instanceof FocusEvent ? event.relatedTarget : null;
      return next instanceof Node && target instanceof Node && target.contains(next) ? undefined : { _tag: 'Leave' };
    },
  },
  update: {
    Key: (s, m, { props: p }) => run(s, p.layout, m),
    Press: (s, m, { props: p }) => run(s, p.layout, m),
    Enter: (s, m, { props: p }) => run(s, p.layout, m),
    Leave: (s, m, { props: p }) => run(s, p.layout, m),
    PropsChanged: (s, { props: p }) => {
      const step = syncHand(s, p.layout);
      return step.focus === null ? step.state : [step.state, [focus(`[data-card="${step.focus}"]`)]];
    },
  },
  view: (s, _i, { props: p }): ChildValue => {
    const { layout, options } = p;
    const focusIndex = clamp(s.focus, layout.cards.length - 1);
    return html`${suitDefs()}
      <div class="h-enter" data-intent=${i.Enter} data-intent-on="focusin">
        <div class="h-leave" data-intent=${i.Leave} data-intent-on="focusout">
          <div
            class="hand ${layout.cards.some((c) => c.tile !== undefined) ? 'tiles' : ''} n-${Math.min(layout.cards.length, 32)} ${options.fourColor ? 'four' : ''} ${options.calm ? 'calm' : ''} mode-${layout.mode}"
            role="toolbar"
            aria-label=${layout.label}
            data-intent=${i.Key}
            data-intent-on="keydown"
          >
            ${each(
              layout.cards,
              (card) => card.id,
              CardButton,
              (card): CardView => ({
                focused: layout.cards[focusIndex]?.id === card.id,
                mode: layout.mode,
                calm: options.calm,
                numbers: options.numbers === true,
                draggable: options.draggable === true,
              }),
            )}
          </div>
        </div>
      </div>`;
  },
  styles: [faceStyles, handStyles],
});

declare global {
  interface HTMLElementTagNameMap {
    'jy-card-hand': InstanceType<typeof CardHand>;
  }
}
