// <jy-card-table> in real Chromium: names and Tab stops, the keyboard model, click-to-move,
// double-click, drag and drop, legal-destination markers, and reduced motion.
import { OUTPUT_EVENT, settled, type OutputEvent } from '@gyral/core';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@joystyk/ui/tokens.css';
import type { TableOut } from './controller.ts';
import { testLayout } from './fixtures.test-util.ts';
import { DEFAULT_OPTIONS, type TableLayout, type TableOptions } from './layout.ts';
import { CardTable } from './table.ts';

afterEach(() => {
  document.body.replaceChildren();
});

const mount = async (layout: TableLayout = testLayout(), options: TableOptions = DEFAULT_OPTIONS) => {
  const el = new CardTable();
  el.layout = layout;
  el.options = options;
  const outs: TableOut[] = [];
  el.addEventListener(OUTPUT_EVENT, (event) => {
    outs.push((event as OutputEvent<TableOut>).detail);
  });
  document.body.append(el);
  await settled();
  const root = el.shadowRoot;
  if (root === null) throw new Error('no shadow root');
  const pile = (id: string): HTMLElement => {
    const found = root.querySelector<HTMLElement>(`[data-pile="${id}"]`);
    if (found === null) throw new Error(`no pile ${id}`);
    return found;
  };
  const card = (id: string, depth: number): HTMLElement => {
    const found = pile(id).querySelector<HTMLElement>(`[data-depth="${depth}"]`);
    if (found === null) throw new Error(`no card at depth ${depth} in ${id}`);
    return found;
  };
  return { el, outs, root, pile, card };
};

const moves = (outs: readonly TableOut[]) => outs.filter((o) => o._tag !== 'Announce');

describe('structure', () => {
  it('shows each region as a toolbar of named piles with one Tab stop', async () => {
    const { root } = await mount();
    expect(root.querySelectorAll('[role="toolbar"]')).toHaveLength(3);
    await expect.element(page.getByRole('toolbar', { name: 'Tableau' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Column 2: 1 face-down card, then 9 of spades, 8 of hearts.' }))
      .toBeVisible();
    expect([...root.querySelectorAll('[data-pile]')].filter((p) => p.getAttribute('tabindex') === '0')).toHaveLength(3);
    // Card art is decoration; the pile's name carries the cards.
    expect(root.querySelectorAll('.card svg[aria-hidden="true"]').length).toBe(5);
    expect(root.querySelectorAll('.card.down').length).toBe(3);
  });

  it('exposes each pile and its empty outline as parts named by kind, for game themes', async () => {
    const { pile } = await mount();
    expect(pile('f0').getAttribute('part')).toBe('pile pile-foundation');
    expect(pile('f0').querySelector('.slot')?.getAttribute('part')).toBe('slot slot-foundation');
  });

  it('draws the four-color deck and the chosen back as classes', async () => {
    const { root } = await mount(testLayout(), { ...DEFAULT_OPTIONS, fourColor: true, back: 'web' });
    const table = root.querySelector('.table');
    expect(table?.classList.contains('four')).toBe(true);
    expect(table?.classList.contains('back-web')).toBe(true);
  });
});

describe('keyboard', () => {
  it('tabs region by region, picks up, moves and drops', async () => {
    const { el, outs, root } = await mount();
    document.body.insertAdjacentHTML('afterbegin', '<button type="button">before</button>');
    (document.body.firstElementChild as HTMLElement).focus();
    await userEvent.tab();
    expect(root.activeElement?.getAttribute('data-pile')).toBe('stock');
    await userEvent.tab();
    expect(root.activeElement?.getAttribute('data-pile')).toBe('f0');
    await userEvent.tab();
    expect(root.activeElement?.getAttribute('data-pile')).toBe('c1');
    await userEvent.keyboard('{ArrowRight}');
    await settled();
    expect(root.activeElement?.getAttribute('data-pile')).toBe('c2');
    await userEvent.keyboard('{ArrowUp}{Enter}');
    await settled();
    expect(root.querySelectorAll('.card.held')).toHaveLength(2);
    // The legal destination gets a dashed outline and a drop marker.
    expect(root.querySelector('[data-pile="c3"]')?.classList.contains('target')).toBe(true);
    await userEvent.keyboard('{ArrowRight}{Enter}');
    await settled();
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 2, via: 'keyboard' }]);
    expect(outs.find((o) => o._tag === 'Announce')).toEqual({
      _tag: 'Announce',
      message: '9 of spades and 1 more card',
    });
    expect(document.activeElement).toBe(el);
  });

  it('jumps with number keys and smart-moves with Enter on the same pile', async () => {
    const { outs, pile } = await mount();
    pile('stock').focus();
    await userEvent.keyboard('1');
    await settled();
    await userEvent.keyboard('{Enter}{Enter}');
    expect(moves(outs)).toEqual([{ _tag: 'Smart', from: 'c1', count: 1, via: 'keyboard' }]);
  });

  it('keeps number keys and shortcuts quiet when single-key shortcuts are off, and lets other keys bubble', async () => {
    const { outs, pile, el } = await mount(testLayout(), { ...DEFAULT_OPTIONS, singleKeys: false });
    const seen: { key: string; prevented: boolean }[] = [];
    el.addEventListener('keydown', (e) => seen.push({ key: e.key, prevented: e.defaultPrevented }));
    pile('c1').focus();
    await userEvent.keyboard('2fu');
    await settled();
    expect(outs).toEqual([]);
    expect(seen).toEqual([
      { key: '2', prevented: false },
      { key: 'f', prevented: false },
      { key: 'u', prevented: false },
    ]);
  });
});

describe('pointer', () => {
  it('clicks to pick up and clicks a destination to move', async () => {
    const { outs, card, pile } = await mount();
    // The 9 of spades shows only its top strip: click there.
    await userEvent.click(card('c2', 2), { position: { x: 8, y: 4 } });
    await settled();
    await userEvent.click(pile('c3'));
    expect(moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 2, via: 'click' }]);
  });

  it('smart-moves on a double-click', async () => {
    const { outs, card } = await mount();
    await userEvent.dblClick(card('waste', 1));
    expect(moves(outs)).toEqual([{ _tag: 'Smart', from: 'waste', count: 1, via: 'click' }]);
  });

  it('runs the stock on a click', async () => {
    const { outs, pile } = await mount();
    await userEvent.click(pile('stock'));
    expect(moves(outs)).toEqual([{ _tag: 'Activate', pile: 'stock' }]);
  });

  it('drags a run and drops it anywhere over a pile', async () => {
    const { outs, card, pile } = await mount();
    await userEvent.dragAndDrop(card('c2', 2), pile('c3'), { sourcePosition: { x: 8, y: 4 } });
    await expect.poll(() => moves(outs)).toEqual([{ _tag: 'Move', from: 'c2', to: 'c3', count: 2, via: 'drag' }]);
  });
});

describe('motion', () => {
  /** Moves the waste's 7 of clubs onto column 3 in a new layout version. */
  const after = (version: number): TableLayout => {
    const base = testLayout(version);
    return {
      ...base,
      regions: base.regions.map((r) => ({
        ...r,
        piles: r.piles.map((p) =>
          p.id === 'waste'
            ? { ...p, cards: [] }
            : p.id === 'c3'
              ? { ...p, cards: [...p.cards, { id: '7C', rank: 7 as const, suit: 'C' as const }] }
              : p,
        ),
      })),
    };
  };

  it('flies a moved card from where it was', async () => {
    const { el, card } = await mount();
    el.layout = after(2);
    await settled();
    expect(card('c3', 1).getAnimations().length).toBeGreaterThan(0);
  });

  it('moves cards instantly with reduced motion', async () => {
    const { el, card } = await mount(testLayout(), { ...DEFAULT_OPTIONS, calm: true });
    el.layout = after(2);
    await settled();
    expect(card('c3', 1).getAnimations()).toHaveLength(0);
    expect(getComputedStyle(card('c2', 1)).transitionDuration).toBe('0s');
  });
});
