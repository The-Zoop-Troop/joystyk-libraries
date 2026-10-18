import type { ChildValue } from '@gyral/core';
// <jy-card-table>: the shared card table. A game passes its table as data (`layout`) and the
// player's preferences (`options`); the table draws the piles with the shared card art and
// runs the pile controller (controller.ts), so drag and drop, click-to-move, smart moves and
// the keyboard model behave the same in every card game. It reports what the player asks for
// as outputs: `Move`, `Smart`, `Activate`, `Key` and `Announce` (listen with `child()`).
//
// Each region is a toolbar: one Tab stop, Left and Right between its piles. Each pile is a
// focusable control named by the game ("Column 3: 2 face-down cards, then 9 of spades").
// Games theme it through inherited custom properties (styles.ts) and two parts per pile kind:
// `::part(pile-<kind>)` for the pile (custom properties set there reach its cards, so
// `--card-w` and `--card-h` make a pile's cards smaller) and `::part(slot-<kind>)` for the
// outline an empty pile shows.
import { defineHook, define, each, focus, html, intentsOf, nothing, outputs, prop, type Command } from '@gyral/core';
import {
  DEFAULT_OPTIONS,
  EMPTY_LAYOUT,
  isFaceCard,
  isTableLayout,
  isTableOptions,
  type PileCard,
  type PileSpec,
  type RegionSpec,
  type TableLayout,
  type TableOptions,
} from './layout.ts';
import { initialCtl, isQuiet, step, sync, type Ctl, type CtlMsg, type TableOut } from './controller.ts';
import { cardFace, suitDefs } from './faces.ts';
import { tableStyles } from './styles.ts';

const props = {
  layout: prop.value(isTableLayout, { default: EMPTY_LAYOUT }),
  options: prop.value(isTableOptions, { default: DEFAULT_OPTIONS }),
};

export type TableProps = { readonly layout: TableLayout; readonly options: TableOptions };

export type TableState = { readonly ctl: Ctl };

export type TableMsg = CtlMsg;

const emit = outputs<TableOut>();
const i = intentsOf<typeof CardTable>();

/** Card flight time when motion is on. */
export const FLIGHT_MS = 180;

type Spot = { readonly x: number; readonly y: number; readonly v: number };
type Memory = { current: number; previous: number; spots: Map<string, Spot> };
const memories = new WeakMap<Node, Memory>();

/**
 * Card motion, through the CSSOM (the site's CSP refuses style attributes): a dragged card
 * follows the pointer, and a card that moved between two layouts flies from where it was
 * (a FLIP animation with the Web Animations API). Flights are decoration, skipped with
 * reduced motion and after a drag drop.
 */
const motion = defineHook<[id: string, version: number, calm: boolean, dx: number, dy: number]>({
  client: (el, [id, version, calm, dx, dy]) => {
    if (!(el instanceof HTMLElement)) return;
    el.style.translate = dx === 0 && dy === 0 ? '' : `${dx}px ${dy}px`;
    const root = el.getRootNode();
    const host = root instanceof ShadowRoot ? root.host : null;
    if (host === null) return;
    let memory = memories.get(root);
    if (memory === undefined) {
      memory = { current: version, previous: version, spots: new Map() };
      memories.set(root, memory);
    }
    if (version !== memory.current) {
      memory.previous = memory.current;
      memory.current = version;
    }
    const origin = host.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const here: Spot = { x: rect.left - origin.left, y: rect.top - origin.top, v: version };
    const before = memory.spots.get(id);
    memory.spots.set(id, here);
    if (calm || before === undefined || before.v !== memory.previous || before.v === version) return;
    const fx = before.x - here.x;
    const fy = before.y - here.y;
    if (Math.abs(fx) < 1 && Math.abs(fy) < 1) return;
    el.animate([{ translate: `${fx}px ${fy}px` }, { translate: '0 0' }], {
      duration: FLIGHT_MS,
      easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)',
    });
  },
});

/** What one card row needs beyond the card: its depth and classes, and the motion inputs. */
type CardView = {
  readonly cls: string;
  readonly version: number;
  readonly calm: boolean;
  readonly dx: number;
  readonly dy: number;
};

type Shown = { readonly key: string; readonly card: PileCard; readonly depth: number };

const CardRow = (shown: Shown, view: CardView) => {
  const card = shown.card;
  if (!isFaceCard(card)) return html`<div class="card down ${view.cls}" data-depth=${shown.depth}></div>`;
  return html`<div class="card up s-${card.suit} ${view.cls}" data-depth=${shown.depth} ${motion(card.id, view.version, view.calm, view.dx, view.dy)}>
    ${cardFace(card.rank, card.suit)}
  </div>`;
};

/** The cards a pile draws: every card in a column; the top few of a stack or fan. */
export const shownCards = (pile: PileSpec): Shown[] => {
  const n = pile.cards.length;
  const show = pile.fan === 'down' ? n : Math.max(1, pile.show ?? (pile.fan === 'stack' ? 2 : 3));
  return pile.cards.slice(Math.max(0, n - show)).map((card, k, list) => {
    const depth = list.length - k;
    return { key: isFaceCard(card) ? card.id : `down-${n - depth}`, card, depth };
  });
};

/** How tightly a column overlaps, by length. */
export const density = (pile: PileSpec): number => {
  if (pile.fan !== 'down') return 0;
  const n = pile.cards.length;
  return n <= 12 ? 0 : n <= 16 ? 1 : n <= 21 ? 2 : 3;
};

/** The cards of `pile` that the current pick-up, drag or hint marks, by depth. */
const cardClasses = (s: TableState, layout: TableLayout, pile: PileSpec, focused: boolean, depth: number): string => {
  const { held, press } = s.ctl;
  const parts: string[] = [];
  if (held !== null && held.from === pile.id && depth <= held.count) {
    parts.push('held');
    if (press?.dragging === true) parts.push('dragging');
  }
  if (focused && held === null && depth === Math.max(1, Math.min(s.ctl.depth, pile.pickable))) parts.push('pointed');
  const hint = layout.hint;
  if (hint !== null && hint.from === pile.id && depth <= hint.count) parts.push('hinted');
  return parts.join(' ');
};

const pileClasses = (s: TableState, layout: TableLayout, pile: PileSpec): string => {
  const { held, press } = s.ctl;
  const source = held === null ? null : layout.regions.flatMap((r) => r.piles).find((p) => p.id === held.from);
  const target =
    held !== null &&
    source !== undefined &&
    source !== null &&
    held.from !== pile.id &&
    source.targets?.[held.count - 1]?.includes(pile.id) === true;
  const parts = [`pile fan-${pile.fan} k-${pile.kind} w-${pile.span ?? 1}`, `dense-${density(pile)}`];
  if (pile.position !== undefined)
    parts.push(`pos-r-${pile.position.row} pos-c-${Math.round(pile.position.column * 2)}`);
  if (target) parts.push('target');
  if (press?.dragging === true && press.over === pile.id && target) parts.push('over');
  if (layout.hint?.to === pile.id) parts.push('hint-to');
  if (pile.cards.length === 0) parts.push('empty');
  return parts.join(' ');
};

const Pile = (
  s: TableState,
  layout: TableLayout,
  options: TableOptions,
  region: RegionSpec,
  r: number,
  pile: PileSpec,
  index: number,
) => {
  const remembered = (s.ctl.piles[r] ?? 0) === index;
  const focused = remembered && s.ctl.region === r;
  const quiet = isQuiet(s.ctl, layout, options);
  const press = s.ctl.press;
  const dragging = press?.dragging === true && s.ctl.held?.from === pile.id;
  const held = s.ctl.held;
  const heldHere = held !== null && held.from === pile.id;
  const label = heldHere
    ? `${pile.label} Picked up: ${held.count === 1 ? 'top card' : `top ${held.count} cards`}.`
    : pile.label;
  return html`<div
    class=${pileClasses(s, layout, pile)}
    part="pile pile-${pile.kind}"
    role="button"
    tabindex=${remembered ? 0 : -1}
    data-pile=${pile.id}
    data-region=${region.id}
    aria-label=${label}
    aria-keyshortcuts=${options.singleKeys && pile.key !== undefined ? pile.key : null}
  >
    <span class="slot" part="slot slot-${pile.kind}" aria-hidden="true">${pile.cards.length === 0 ? (pile.mark ?? '') : ''}</span>
    ${each(
      shownCards(pile),
      (shown) => shown.key,
      CardRow,
      (shown): CardView => ({
        cls: cardClasses(s, layout, pile, focused, shown.depth),
        version: layout.version,
        calm: quiet,
        dx: dragging && held !== null && shown.depth <= held.count ? (press?.dx ?? 0) : 0,
        dy: dragging && held !== null && shown.depth <= held.count ? (press?.dy ?? 0) : 0,
      }),
    )}
    <span class="drop" aria-hidden="true"></span>
    ${pile.badge === undefined ? nothing : html`<span class="pile-badge" aria-hidden="true">${pile.badge}</span>`}
  </div>`;
};

const Region = (s: TableState, layout: TableLayout, options: TableOptions, region: RegionSpec, r: number) => {
  const span = region.piles.reduce((n, p) => n + (p.span ?? 1), 0);
  return html`<div class="region at-${region.place} n-${span} ${region.placement === 'free' ? 'free-placement' : ''}" role="toolbar" aria-label=${region.label} data-region=${region.id}>
    ${region.piles.map((pile, index) => Pile(s, layout, options, region, r, pile, index))}
  </div>`;
};

/** The pile and card depth under an event's target. */
const pileAt = (target: EventTarget | null): { readonly pile: string | null; readonly depth: number } => {
  const el = target instanceof Element ? target : null;
  const pile = el?.closest('[data-pile]')?.getAttribute('data-pile') ?? null;
  const depth = Number(el?.closest('[data-depth]')?.getAttribute('data-depth') ?? 0);
  return { pile, depth: Number.isInteger(depth) ? depth : 0 };
};

/** The pile under a point, ignoring dragged cards (they don't take pointer events). */
const pileUnder = (inside: EventTarget | null, x: number, y: number): string | null => {
  const root = inside instanceof Node ? inside.getRootNode() : null;
  if (!(root instanceof ShadowRoot)) return null;
  for (const el of root.elementsFromPoint(x, y)) {
    const pile = el.closest('[data-pile]');
    if (pile !== null) return pile.getAttribute('data-pile');
  }
  return null;
};

/** Keys the table always handles on a pile; their browser defaults (scrolling) are suppressed. */
const TABLE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ']);

const run = (
  s: TableState,
  m: TableMsg,
  layout: TableLayout,
  options: TableOptions,
): TableState | readonly [TableState, Command<TableMsg>[]] => {
  const result = step(s.ctl, layout, options, m);
  const commands: Command<TableMsg>[] = result.outs.map((out) => emit(out));
  if (result.focus !== null) commands.push(focus(`[data-pile="${result.focus}"]`));
  return commands.length === 0 ? { ctl: result.ctl } : [{ ctl: result.ctl }, commands];
};

export const CardTable = define<TableState, TableMsg, TableProps, TableOut>()('jy-card-table', {
  props,
  init: (p) => ({ ctl: initialCtl(p.layout) }),
  renderOnFrame: ['Move'],
  intent: {
    Key: ({ key, event }, { props: { layout, options } }) => {
      if (key === undefined || !(event instanceof KeyboardEvent)) return undefined;
      const onPile = event.target instanceof Element && event.target.hasAttribute('data-pile');
      if (!onPile) return undefined;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      const lower = key.toLowerCase();
      const single =
        plain &&
        !event.shiftKey &&
        options.singleKeys &&
        ((lower >= '0' && lower <= '9' && lower.length === 1) || layout.keys.includes(lower));
      if ((plain && TABLE_KEYS.has(key)) || single || (plain && key === 'Escape')) event.preventDefault();
      return { _tag: 'Key', key, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, shift: event.shiftKey };
    },
    Focus: ({ event }) => {
      const pile = pileAt(event.target).pile;
      return pile === null ? undefined : { _tag: 'Focus', pile };
    },
    Down: ({ event, target }) => {
      if (!(event instanceof PointerEvent) || !event.isPrimary || event.button !== 0) return undefined;
      const at = pileAt(event.target);
      // Capture on the event wrapper so a drag that leaves the table still ends here.
      if (at.pile !== null && target instanceof Element && target.isConnected) {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // A synthetic event has no active pointer to capture; the drag still works inside the table.
        }
      }
      return { _tag: 'Down', pile: at.pile, depth: at.depth, x: event.clientX, y: event.clientY };
    },
    Move: ({ event, target }) => {
      if (!(event instanceof PointerEvent) || !event.isPrimary || event.buttons === 0) return undefined;
      return {
        _tag: 'Move',
        x: event.clientX,
        y: event.clientY,
        over: pileUnder(target, event.clientX, event.clientY),
      };
    },
    Up: ({ event, target }) => {
      if (!(event instanceof PointerEvent) || !event.isPrimary) return undefined;
      return { _tag: 'Up', over: pileUnder(target, event.clientX, event.clientY) };
    },
    Cancel: () => ({ _tag: 'Cancel' }),
  },
  update: {
    Key: (s, m, { props: p }) => run(s, m, p.layout, p.options),
    Focus: (s, m, { props: p }) => run(s, m, p.layout, p.options),
    Down: (s, m, { props: p }) => run(s, m, p.layout, p.options),
    Move: (s, m, { props: p }) => run(s, m, p.layout, p.options),
    Up: (s, m, { props: p }) => run(s, m, p.layout, p.options),
    Cancel: (s, m, { props: p }) => run(s, m, p.layout, p.options),
    PropsChanged: (s, { props: p }) => {
      const ctl = sync(s.ctl, p.layout);
      return ctl === s.ctl ? s : { ctl };
    },
  },
  view: (s, _i, { props: p }): ChildValue => {
    const { layout, options } = p;
    const cls = `table cols-${layout.columns} back-${options.back}${options.fourColor ? ' four' : ''}${options.calm ? ' calm' : ''}`;
    return html`${suitDefs()}
      <div class="t-events" data-intent-keydown=${i.Key} data-intent-pointermove=${i.Move}
        data-intent-pointerup=${i.Up} data-intent-pointercancel=${i.Cancel}
        data-intent-focusin=${i.Focus} data-intent-pointerdown=${i.Down}>
        <div class=${cls} role="group" aria-label=${layout.label}>${layout.regions.map((region, r) => Region(s, layout, options, region, r))}</div>
      </div>`;
  },
  styles: tableStyles,
});

declare global {
  interface HTMLElementTagNameMap {
    'jy-card-table': InstanceType<typeof CardTable>;
  }
}
