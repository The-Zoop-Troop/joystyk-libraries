// The pile controller without a DOM: the keyboard model, click-to-move, smart moves, drags
// and what it says (klondike.md, "Interaction and accessibility").
import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD,
  focusedPile,
  initialCtl,
  step,
  sync,
  type Ctl,
  type CtlMsg,
  type TableOut,
} from './controller.ts';
import { DEFAULT_OPTIONS, type TableOptions } from './layout.ts';
import { testLayout } from './fixtures.test-util.ts';

const layout = testLayout();

const key = (
  k: string,
  mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {},
): CtlMsg => ({
  _tag: 'Key',
  key: k,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  meta: mods.meta ?? false,
  shift: mods.shift ?? false,
});

/** Runs messages in order and collects every output and focus request. */
const play = (
  msgs: readonly CtlMsg[],
  options: TableOptions = DEFAULT_OPTIONS,
  start: Ctl = initialCtl(layout),
  table = layout,
) => {
  let ctl = start;
  const outs: TableOut[] = [];
  const focus: string[] = [];
  for (const m of msgs) {
    const result = step(ctl, table, options, m);
    ctl = result.ctl;
    outs.push(...result.outs);
    if (result.focus !== null) focus.push(result.focus);
  }
  return { ctl, outs, focus };
};

const said = (outs: readonly TableOut[]) => outs.flatMap((o) => (o._tag === 'Announce' ? [o.message] : []));
const moves = (outs: readonly TableOut[]) => outs.filter((o) => o._tag !== 'Announce');

describe('keyboard', () => {
  it('starts on the first pile of the first region, one Tab stop per region', () => {
    const ctl = initialCtl(layout);
    expect(focusedPile(ctl, layout)?.id).toBe('stock');
    expect(ctl.piles).toEqual([0, 0, 0]);
  });

  it('moves between piles of a region with the arrows, Home and End, without wrapping', () => {
    const { ctl, focus } = play([key('ArrowRight'), key('ArrowRight'), key('ArrowLeft'), key('End'), key('Home')]);
    expect(focus).toEqual(['waste', 'waste', 'stock', 'waste', 'stock']);
    expect(focusedPile(ctl, layout)?.id).toBe('stock');
  });

  it('runs the action of an action pile on Enter', () => {
    expect(moves(play([key('Enter')]).outs)).toEqual([{ _tag: 'Activate', pile: 'stock' }]);
    expect(moves(play([key(' ')]).outs)).toEqual([{ _tag: 'Activate', pile: 'stock' }]);
  });

  it('picks up, chooses a destination with the arrows and drops with Enter', () => {
    const { outs, focus } = play([key('2'), key('Enter'), key('ArrowRight'), key('Enter')]);
    expect(focus).toEqual(['c2', 'c3']);
    expect(said(outs)).toEqual(['Picked up 8 of hearts. Choose a pile, then press Enter.']);
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 1, via: 'keyboard' }]);
  });

  it('drops straight onto a numbered pile while holding cards', () => {
    const { outs } = play([key('2'), key('Enter'), key('3')]);
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 1, via: 'keyboard' }]);
  });

  it('chooses how many cards with Up and Down, and says the limit', () => {
    const { outs, ctl } = play([
      key('2'),
      key('ArrowUp'),
      key('ArrowUp'),
      key('ArrowDown'),
      key('ArrowUp'),
      key('Enter'),
    ]);
    expect(said(outs)).toEqual([
      '9 of spades and 1 more card',
      'The face-down card stays.',
      '8 of hearts',
      '9 of spades and 1 more card',
      'Picked up 9 of spades and 1 more card. Choose a pile, then press Enter.',
    ]);
    expect(ctl.held).toEqual({ from: 'c2', count: 2, via: 'keyboard' });
  });

  it('makes a smart move on Enter over the cards’ own pile, and puts back on Escape', () => {
    expect(moves(play([key('1'), key('Enter'), key('Enter')]).outs)).toEqual([
      { _tag: 'Smart', from: 'c1', count: 1, via: 'keyboard' },
    ]);
    const back = play([key('1'), key('Enter'), key('Escape')]);
    expect(back.ctl.held).toBeNull();
    expect(said(back.outs).at(-1)).toBe('Put back ace of spades.');
  });

  it('keeps cards held while Tab moves focus to another region', () => {
    const { outs } = play([key('2'), key('Enter'), { _tag: 'Focus', pile: 'f1' }, key('Enter')]);
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'f1', count: 1, via: 'keyboard' }]);
  });

  it('remembers each region’s pile for its Tab stop', () => {
    const { ctl } = play([
      { _tag: 'Focus', pile: 'c3' },
      { _tag: 'Focus', pile: 'waste' },
    ]);
    expect(ctl.piles).toEqual([1, 0, 2]);
    expect(ctl.region).toBe(0);
  });

  it('reports the layout’s single-key shortcuts with the focused pile', () => {
    expect(moves(play([key('1'), key('f')]).outs)).toEqual([{ _tag: 'Key', key: 'f', pile: 'c1', count: 1 }]);
    expect(moves(play([key('2'), key('ArrowUp'), key('Enter'), key('F')]).outs)).toEqual([
      { _tag: 'Key', key: 'f', pile: 'c2', count: 2 },
    ]);
  });

  it('turns off number keys and shortcuts when single-key shortcuts are off', () => {
    const off = { ...DEFAULT_OPTIONS, singleKeys: false };
    const { outs, focus } = play([key('2'), key('f')], off);
    expect(outs).toEqual([]);
    expect(focus).toEqual([]);
    // Everything stays possible without them.
    expect(moves(play([key('Enter')], off).outs)).toEqual([{ _tag: 'Activate', pile: 'stock' }]);
  });

  it('leaves keys with modifiers to the game', () => {
    expect(play([key('z', { ctrl: true }), key('2', { alt: true })]).outs).toEqual([]);
  });

  it('says why an empty or face-down pile gives nothing', () => {
    const { outs } = play([{ _tag: 'Focus', pile: 'f0' }, key('Enter')]);
    expect(said(outs)).toEqual(['Nothing to pick up: the pile is empty.']);
  });
});

describe('pointer', () => {
  const down = (pile: string | null, depth: number, x = 100, y = 100): CtlMsg => ({ _tag: 'Down', pile, depth, x, y });
  const move = (x: number, y: number, over: string | null = null): CtlMsg => ({ _tag: 'Move', x, y, over });
  const up = (over: string | null = null): CtlMsg => ({ _tag: 'Up', over });

  it('clicks to pick up and clicks a destination to move', () => {
    const { outs } = play([down('c2', 2), up('c2'), down('c3', 1), up('c3')]);
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 2, via: 'click' }]);
  });

  it('makes a smart move on a second click of the same card: a double-click', () => {
    const { outs } = play([down('waste', 1), up(), down('waste', 1), up()]);
    expect(moves(outs)).toEqual([{ _tag: 'Smart', from: 'waste', count: 1, via: 'click' }]);
  });

  it('cancels a click selection with a click elsewhere', () => {
    const { ctl, outs } = play([down('c1', 1), up(), down(null, 0), up()]);
    expect(ctl.held).toBeNull();
    expect(said(outs).at(-1)).toBe('Put back ace of spades.');
  });

  it('runs the stock’s action on a click and ignores clicks on face-down cards', () => {
    expect(moves(play([down('stock', 1), up()]).outs)).toEqual([{ _tag: 'Activate', pile: 'stock' }]);
    expect(play([down('c2', 3), up()]).ctl.held).toBeNull();
  });

  it(`drags only after ${DRAG_THRESHOLD} pixels, then drops on the pile under the pointer`, () => {
    const still = play([down('c2', 1), move(103, 103)]);
    expect(still.ctl.press?.dragging).toBe(false);
    const { ctl, outs } = play([down('c2', 1), move(110, 100, 'c2'), move(300, 120, 'c3'), up('c3')]);
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 1, via: 'drag' }]);
    expect(ctl.settle).toBe(true);
  });

  it('returns dragged cards dropped on their own pile or off the table', () => {
    expect(moves(play([down('c2', 2), move(120, 100), up('c2')]).outs)).toEqual([]);
    const off = play([down('c2', 2), move(120, 100), up(null)]);
    expect(moves(off.outs)).toEqual([]);
    expect(off.ctl.held).toBeNull();
  });

  it('never drags a face-down card', () => {
    expect(play([down('c2', 3), move(140, 100)]).ctl.held).toBeNull();
  });

  it('puts back a drag whose release never arrived when the next press starts', () => {
    const { ctl } = play([down('c2', 1), move(140, 100), down('c3', 1)]);
    expect(ctl.held).toBeNull();
  });

  it('drops a drag when the pointer is cancelled', () => {
    expect(play([down('c2', 1), move(140, 100), { _tag: 'Cancel' }]).ctl.held).toBeNull();
  });
});

describe('new layouts', () => {
  it('drop any pick-up when the cards change, and land a drag drop without flights', () => {
    const dropped = play([
      { _tag: 'Down', pile: 'c2', depth: 1, x: 0, y: 0 },
      { _tag: 'Move', x: 40, y: 0, over: 'c3' },
      { _tag: 'Up', over: 'c3' },
    ]).ctl;
    const next = sync(dropped, testLayout(2));
    expect(next.quiet).toBe(2);
    expect(next.settle).toBe(false);
    const held = play([{ _tag: 'Focus', pile: 'c1' }, key('Enter')]).ctl;
    expect(sync(held, testLayout(3)).held).toBeNull();
  });

  it('keeps the focus in range when piles disappear', () => {
    const start = play([{ _tag: 'Focus', pile: 'c3' }]).ctl;
    const shorter = {
      ...layout,
      version: 2,
      regions: layout.regions.map((r) => (r.id === 'tableau' ? { ...r, piles: r.piles.slice(0, 1) } : r)),
    };
    expect(focusedPile(sync(start, shorter), shorter)?.id).toBe('c1');
  });
});
