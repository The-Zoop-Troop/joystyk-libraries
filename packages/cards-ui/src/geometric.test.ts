import { expect, test } from 'vitest';
import { initialCtl, step, type CtlMsg } from './controller.ts';
import { DEFAULT_OPTIONS, type TableLayout } from './layout.ts';
const layout: TableLayout = {
  label: 'Overlap test',
  columns: 3,
  version: 1,
  hint: null,
  keys: ['n', 't', 'w'],
  regions: [
    {
      id: 'cards',
      label: 'Cards',
      place: 'main',
      placement: 'free',
      piles: [
        {
          id: 'top',
          position: { row: 0, column: 1 },
          label: 'Covered top',
          kind: 'card',
          fan: 'stack',
          cards: [{ hidden: true }],
          pickable: 0,
        },
        {
          id: 'left',
          position: { row: 1, column: 0 },
          label: 'Left',
          kind: 'card',
          fan: 'stack',
          cards: [{ id: 'one', rank: 6, suit: 'S' }],
          pickable: 1,
        },
        {
          id: 'right',
          position: { row: 1, column: 2 },
          label: 'Right',
          kind: 'card',
          fan: 'stack',
          cards: [{ id: 'two', rank: 7, suit: 'H' }],
          pickable: 1,
        },
      ],
    },
  ],
};
const key = (key: string): CtlMsg => ({ _tag: 'Key', key, ctrl: false, alt: false, meta: false, shift: false });
test('grid arrows choose the closest row neighbor, use the reading-order tie and keep covered slots', () => {
  let ctl = initialCtl(layout);
  for (const [k, id] of [
    ['ArrowDown', 'left'],
    ['ArrowRight', 'right'],
    ['ArrowUp', 'top'],
    ['End', 'top'],
    ['ArrowDown', 'left'],
    ['End', 'right'],
    ['Home', 'left'],
  ]) {
    const result = step(ctl, layout, DEFAULT_OPTIONS, key(k!));
    expect(result.focus).toBe(id);
    ctl = result.ctl;
  }
});
test('N visits available cards bottom-first, wraps, and is disabled by the preference', () => {
  let ctl = initialCtl(layout);
  for (const id of ['left', 'right', 'left']) {
    const result = step(ctl, layout, DEFAULT_OPTIONS, key('n'));
    expect(result.focus).toBe(id);
    ctl = result.ctl;
  }
  expect(step(ctl, layout, { ...DEFAULT_OPTIONS, singleKeys: false }, key('n')).focus).toBeNull();
});
