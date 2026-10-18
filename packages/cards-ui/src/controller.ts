// The pile interaction controller: a pure state machine that turns pointer and keyboard
// input on a card table into moves (klondike.md, "Interaction and accessibility"). It knows
// no rules; the layout says how many cards each pile lets go of and where they may land. The
// engine still decides every move, so a move the controller sends may be refused.
//
// - Pointer: press a face-up card and move 6 CSS pixels to drag it with the cards on top of
//   it; drop anywhere over a pile. A click without dragging picks the cards up; a click on
//   another pile moves them there; a second click on the same card is a smart move (so a
//   double-click or double-tap is one); a click elsewhere puts them back.
// - Keyboard: one Tab stop per region (a roving tabindex), Left and Right between piles, Up
//   and Down for how many cards, Enter or Space to pick up and to drop (on the cards' own
//   pile: a smart move), Escape to put back, number keys for numbered piles, and the layout's
//   single-key shortcuts, all only while `singleKeys` is on (WCAG 2.1.4).
//
// Everything it says goes out as `Announce` outputs; the game passes them to the frame's
// live region.
import { cardName } from '@joystyk/kit/cards';
import {
  findPile,
  isFaceCard,
  topCards,
  type FaceCard,
  type PileSpec,
  type TableLayout,
  type TableOptions,
} from './layout.ts';

/** Pointer travel, in CSS pixels, that turns a press into a drag (spec: Pointer). */
export const DRAG_THRESHOLD = 6;

export type Via = 'drag' | 'click' | 'keyboard';

/** Cards the player has picked up: the top `count` of pile `from`. */
export type Held = { readonly from: string; readonly count: number; readonly via: Via };

/** A pointer pressed on a pile; `depth` counts cards from the top (0: the pile, not a card). */
export type Press = {
  readonly pile: string | null;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly dragging: boolean;
  readonly dx: number;
  readonly dy: number;
  readonly over: string | null;
};

export type Ctl = {
  /** The focused region. */
  readonly region: number;
  /** The remembered pile of each region: the one Tab reaches (roving tabindex). */
  readonly piles: readonly number[];
  /** Cards counted from the top of the focused pile: what Enter picks up. */
  readonly depth: number;
  readonly held: Held | null;
  readonly press: Press | null;
  /** The layout version last seen. */
  readonly version: number;
  /** A drag just dropped: the next layout lands without card flights. */
  readonly settle: boolean;
  /** The layout version that renders without card flights. */
  readonly quiet: number | null;
};

/** What the table tells the game. */
export type TableOut =
  | { readonly _tag: 'Move'; readonly from: string; readonly to: string; readonly count: number; readonly via: Via }
  | { readonly _tag: 'Smart'; readonly from: string; readonly count: number; readonly via: Via }
  | { readonly _tag: 'Activate'; readonly pile: string }
  | { readonly _tag: 'Key'; readonly key: string; readonly pile: string; readonly count: number }
  | { readonly _tag: 'Announce'; readonly message: string };

export type CtlMsg =
  | {
      readonly _tag: 'Key';
      readonly key: string;
      readonly ctrl: boolean;
      readonly alt: boolean;
      readonly meta: boolean;
      readonly shift: boolean;
    }
  | { readonly _tag: 'Focus'; readonly pile: string }
  | {
      readonly _tag: 'Down';
      readonly pile: string | null;
      readonly depth: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly _tag: 'Move'; readonly x: number; readonly y: number; readonly over: string | null }
  | { readonly _tag: 'Up'; readonly over: string | null }
  | { readonly _tag: 'Cancel' };

/** One step: the new controller state, outputs, and a pile to focus after rendering. */
export type Step = { readonly ctl: Ctl; readonly outs: readonly TableOut[]; readonly focus: string | null };

export const initialCtl = (layout: TableLayout): Ctl => {
  const first = layout.regions.findIndex((r) => r.piles.length > 0);
  return {
    region: Math.max(0, first),
    piles: layout.regions.map(() => 0),
    depth: 1,
    held: null,
    press: null,
    version: layout.version,
    settle: false,
    quiet: null,
  };
};

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * Brings the controller in line with a new layout: indexes stay in range, and a new version
 * (the cards changed) drops any pick-up or press.
 */
export const sync = (ctl: Ctl, layout: TableLayout): Ctl => {
  const piles = layout.regions.map((r, i) => clamp(ctl.piles[i] ?? 0, 0, Math.max(0, r.piles.length - 1)));
  let region = clamp(ctl.region, 0, Math.max(0, layout.regions.length - 1));
  if ((layout.regions[region]?.piles.length ?? 0) === 0)
    region = Math.max(
      0,
      layout.regions.findIndex((r) => r.piles.length > 0),
    );
  const moved = layout.version !== ctl.version;
  const same = piles.length === ctl.piles.length && piles.every((p, i) => p === ctl.piles[i]) && region === ctl.region;
  if (!moved && same) return ctl;
  if (!moved) return { ...ctl, piles, region };
  return {
    ...ctl,
    piles,
    region,
    depth: 1,
    held: null,
    press: null,
    version: layout.version,
    settle: false,
    quiet: ctl.settle ? layout.version : null,
  };
};

/** The focused pile, if the table has any. */
export const focusedPile = (ctl: Ctl, layout: TableLayout): PileSpec | null =>
  layout.regions[ctl.region]?.piles[ctl.piles[ctl.region] ?? 0] ?? null;

/** A card's name for the middle of a sentence: "queen of hearts", "7 of clubs". */
export const spoken = (card: FaceCard): string => cardName(card).toLowerCase();

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "9 of spades", or "9 of spades and 2 more cards": the cards a pick-up of `count` takes. */
export const describe = (pile: PileSpec, count: number): string => {
  const [first] = topCards(pile, count);
  if (first === undefined) return 'nothing';
  const more = count - 1;
  return more === 0 ? spoken(first) : `${spoken(first)} and ${more} more ${more === 1 ? 'card' : 'cards'}`;
};

const none = (ctl: Ctl): Step => ({ ctl, outs: [], focus: null });

const say = (message: string): TableOut => ({ _tag: 'Announce', message });

/** Picks up `count` cards from `pile` and says so. */
const pickUp = (ctl: Ctl, pile: PileSpec, count: number, via: Via): Step => {
  const note = pile.note === undefined ? '' : ` ${pile.note}`;
  const help = via === 'keyboard' ? ' Choose a pile, then press Enter.' : '';
  return {
    ctl: { ...ctl, held: { from: pile.id, count, via } },
    outs: [say(`Picked up ${describe(pile, count)}.${note}${help}`)],
    focus: null,
  };
};

/** Drops the held cards on `to`: a move, or a smart move on their own pile. */
const drop = (ctl: Ctl, held: Held, to: string, via: Via): Step => {
  const cleared = { ...ctl, held: null };
  const out: TableOut =
    to === held.from
      ? { _tag: 'Smart', from: held.from, count: held.count, via }
      : { _tag: 'Move', from: held.from, to, count: held.count, via };
  return { ctl: cleared, outs: [out], focus: null };
};

const putBack = (ctl: Ctl, layout: TableLayout): Step => {
  const held = ctl.held;
  if (held === null) return none(ctl);
  const pile = findPile(layout, held.from)?.pile;
  return {
    ctl: { ...ctl, held: null },
    outs: [say(pile === undefined ? 'Put back.' : `Put back ${describe(pile, held.count)}.`)],
    focus: null,
  };
};

/** Moves the focus to pile `index` of the focused region. */
const focusAt = (ctl: Ctl, layout: TableLayout, region: number, index: number): Step => {
  const pile = layout.regions[region]?.piles[index];
  if (pile === undefined) return none(ctl);
  const piles = ctl.piles.slice();
  piles[region] = index;
  const changed = region !== ctl.region || index !== ctl.piles[region];
  return { ctl: { ...ctl, region, piles, depth: changed ? 1 : ctl.depth }, outs: [], focus: pile.id };
};

/** Enter or Space on the focused pile. */
const activate = (ctl: Ctl, pile: PileSpec): Step => {
  if (ctl.held !== null) return drop(ctl, ctl.held, pile.id, 'keyboard');
  if (pile.action === true) return { ctl, outs: [{ _tag: 'Activate', pile: pile.id }], focus: null };
  if (pile.pickable >= 1) return pickUp(ctl, pile, clamp(ctl.depth, 1, pile.pickable), 'keyboard');
  return {
    ctl,
    outs: [say(pile.cards.length === 0 ? 'Nothing to pick up: the pile is empty.' : 'Nothing here can be picked up.')],
    focus: null,
  };
};

/** Up and Down: how many cards Enter picks up. */
const deepen = (ctl: Ctl, pile: PileSpec, by: 1 | -1): Step => {
  if (pile.inspect === true && ctl.held === null) {
    const depth = clamp(ctl.depth + by, 1, Math.max(1, pile.cards.length));
    const card = pile.cards[pile.cards.length - depth];
    return { ctl: { ...ctl, depth }, outs: isFaceCard(card) ? [say(capital(spoken(card)))] : [], focus: null };
  }
  if (ctl.held !== null || pile.pickable < 1) return none(ctl);
  const depth = clamp(ctl.depth, 1, pile.pickable);
  const next = depth + by;
  if (next < 1) return { ctl: { ...ctl, depth }, outs: [], focus: null };
  if (next > pile.pickable)
    return { ctl: { ...ctl, depth }, outs: pile.limit === undefined ? [] : [say(pile.limit)], focus: null };
  return { ctl: { ...ctl, depth: next }, outs: [say(capital(describe(pile, next)))], focus: null };
};

const isDigit = (key: string): boolean => key.length === 1 && key >= '0' && key <= '9';

/** Navigate a geometric layout without consulting the DOM or skipping covered cards. */
const geometricFocus = (ctl: Ctl, layout: TableLayout, key: string): Step | null => {
  const region = layout.regions[ctl.region];
  const here = focusedPile(ctl, layout)?.position;
  if (region?.placement !== 'free' || here === undefined) return null;
  const candidates = region.piles
    .map((pile, index) => ({ index, position: pile.position }))
    .filter((p) => p.position !== undefined);
  const row =
    key === 'ArrowUp'
      ? Math.max(-1, ...candidates.filter((p) => p.position!.row < here.row).map((p) => p.position!.row))
      : key === 'ArrowDown'
        ? Math.min(Infinity, ...candidates.filter((p) => p.position!.row > here.row).map((p) => p.position!.row))
        : here.row;
  let choices = candidates.filter((p) => p.position!.row === row);
  if (key === 'ArrowLeft') choices = choices.filter((p) => p.position!.column < here.column);
  if (key === 'ArrowRight') choices = choices.filter((p) => p.position!.column > here.column);
  choices.sort((a, b) =>
    key === 'Home'
      ? a.position!.column - b.position!.column
      : key === 'End'
        ? b.position!.column - a.position!.column
        : Math.abs(a.position!.column - here.column) - Math.abs(b.position!.column - here.column) ||
          a.position!.column - b.position!.column,
  );
  return choices[0] === undefined ? none(ctl) : focusAt(ctl, layout, ctl.region, choices[0].index);
};

const onKey = (ctl: Ctl, layout: TableLayout, options: TableOptions, m: Extract<CtlMsg, { _tag: 'Key' }>): Step => {
  const pile = focusedPile(ctl, layout);
  if (pile === null || m.alt || m.meta || m.ctrl) return none(ctl);
  const region = layout.regions[ctl.region];
  const count = region?.piles.length ?? 0;
  const index = ctl.piles[ctl.region] ?? 0;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(m.key)) {
    const spatial = geometricFocus(ctl, layout, m.key);
    if (spatial !== null) return spatial;
  }
  switch (m.key) {
    case 'ArrowLeft':
      return focusAt(ctl, layout, ctl.region, Math.max(0, index - 1));
    case 'ArrowRight':
      return focusAt(ctl, layout, ctl.region, Math.min(count - 1, index + 1));
    case 'Home':
      return focusAt(ctl, layout, ctl.region, 0);
    case 'End':
      return focusAt(ctl, layout, ctl.region, count - 1);
    case 'ArrowUp':
      return deepen(ctl, pile, 1);
    case 'ArrowDown':
      return deepen(ctl, pile, -1);
    case 'Enter':
    case ' ':
      return activate(ctl, pile);
    case 'Escape':
      return putBack(ctl, layout);
  }
  if (!options.singleKeys || m.shift) return none(ctl);
  const key = m.key.toLowerCase();
  if (isDigit(key)) {
    const target = layout.regions
      .flatMap((r, ri) => r.piles.map((p, pi) => ({ p, ri, pi })))
      .find(({ p }) => p.key === key);
    if (target === undefined) return none(ctl);
    const moved = focusAt(ctl, layout, target.ri, target.pi);
    if (ctl.held === null)
      return layout.activateNumbers === true ? { ...activate(moved.ctl, target.p), focus: moved.focus } : moved;
    const dropped = drop(moved.ctl, ctl.held, target.p.id, 'keyboard');
    return { ...dropped, focus: moved.focus };
  }
  if (layout.keys.includes(key)) {
    if (key === 'n' || key === 't' || key === 'w') {
      const piles = layout.regions.flatMap((r, ri) => r.piles.map((p, pi) => ({ p, ri, pi })));
      const available = piles
        .filter(({ p }) => p.pickable > 0)
        .sort(
          (a, b) =>
            (b.p.position?.row ?? -1) - (a.p.position?.row ?? -1) ||
            (a.p.position?.column ?? a.pi) - (b.p.position?.column ?? b.pi),
        );
      const current = available.findIndex(({ p }) => p.id === pile.id);
      const next =
        key === 'n'
          ? available[(current + 1) % Math.max(1, available.length)]
          : piles.find(({ p }) => p.id === (key === 't' ? 'turned' : 'waste'));
      if (next !== undefined) return focusAt(ctl, layout, next.ri, next.pi);
      return none(ctl);
    }
    const held = ctl.held;
    const out: TableOut =
      held === null
        ? { _tag: 'Key', key, pile: pile.id, count: clamp(ctl.depth, 1, Math.max(1, pile.pickable)) }
        : { _tag: 'Key', key, pile: held.from, count: held.count };
    return { ctl: { ...ctl, held: null }, outs: [out], focus: null };
  }
  return none(ctl);
};

/** A click (a press released without dragging) on `pileId` at `depth`. */
const click = (ctl: Ctl, layout: TableLayout, pileId: string | null, depth: number): Step => {
  const found = pileId === null ? null : findPile(layout, pileId);
  if (found === null) return putBack(ctl, layout);
  const { pile } = found;
  const focused = {
    ...ctl,
    region: found.region,
    piles: ctl.piles.map((p, i) => (i === found.region ? found.index : p)),
  };
  const held = ctl.held;
  if (held !== null) {
    if (pile.id !== held.from) return drop(focused, held, pile.id, 'click');
    if (depth === held.count) return drop(focused, held, pile.id, 'click');
    if (depth >= 1 && depth <= pile.pickable) return pickUp({ ...focused, depth }, pile, depth, 'click');
    return putBack(focused, layout);
  }
  if (pile.action === true) return { ctl: focused, outs: [{ _tag: 'Activate', pile: pile.id }], focus: null };
  if (depth >= 1 && depth <= pile.pickable) return pickUp({ ...focused, depth }, pile, depth, 'click');
  return none(focused);
};

/** The controller's reducer. */
export const step = (before: Ctl, layout: TableLayout, options: TableOptions, m: CtlMsg): Step => {
  const ctl = sync(before, layout);
  switch (m._tag) {
    case 'Key':
      return onKey(ctl, layout, options, m);
    case 'Focus': {
      const found = findPile(layout, m.pile);
      if (found === null) return none(ctl);
      const same = found.region === ctl.region && found.index === ctl.piles[found.region];
      if (same) return none(ctl);
      const piles = ctl.piles.slice();
      piles[found.region] = found.index;
      return none({ ...ctl, region: found.region, piles, depth: 1 });
    }
    case 'Down': {
      // A drag whose release never arrived (the pointer left the window) is dropped back first.
      const stale = ctl.press?.dragging === true;
      return none({
        ...ctl,
        held: stale ? null : ctl.held,
        press: { pile: m.pile, depth: m.depth, x: m.x, y: m.y, dragging: false, dx: 0, dy: 0, over: null },
      });
    }
    case 'Move': {
      const press = ctl.press;
      if (press === null || press.pile === null) return none(ctl);
      const dx = m.x - press.x;
      const dy = m.y - press.y;
      if (press.dragging) return none({ ...ctl, press: { ...press, dx, dy, over: m.over } });
      if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return none(ctl);
      const pile = findPile(layout, press.pile)?.pile;
      const top = pile?.cards[pile.cards.length - press.depth];
      if (pile === undefined || press.depth < 1 || press.depth > pile.pickable || !isFaceCard(top))
        return none({ ...ctl, press: null });
      return none({
        ...ctl,
        held: { from: pile.id, count: press.depth, via: 'drag' },
        press: { ...press, dragging: true, dx, dy, over: m.over },
      });
    }
    case 'Up': {
      const press = ctl.press;
      if (press === null) return none(ctl);
      const released = { ...ctl, press: null };
      if (!press.dragging) return click(released, layout, press.pile, press.depth);
      const held = ctl.held;
      const to = m.over;
      if (held === null || to === null || to === held.from) return none({ ...released, held: null });
      return {
        ctl: { ...released, held: null, settle: true },
        outs: [{ _tag: 'Move', from: held.from, to, count: held.count, via: 'drag' }],
        focus: null,
      };
    }
    case 'Cancel': {
      const dragging = ctl.press?.dragging === true;
      return none({ ...ctl, press: null, held: dragging ? null : ctl.held });
    }
  }
};

/** True when the table should render this layout without card flights. */
export const isQuiet = (ctl: Ctl, layout: TableLayout, options: TableOptions): boolean =>
  options.calm || ctl.quiet === layout.version;
