// <jy-card-hand> in real Chromium: one Tab stop with named card buttons, the roving focus,
// play and choose modes from the keyboard and the pointer, disabled cards, and the focus
// following the hand when a played card leaves it.
import { OUTPUT_EVENT, settled, type OutputEvent } from '@gyral/core';
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '@joystyk/ui/tokens.css';
import { CardHand, type HandCard, type HandLayout, type HandOut } from './hand.ts';

afterEach(() => {
  document.body.replaceChildren();
});

const cards: HandCard[] = [
  { id: 'c1', rank: 2, suit: 'C', playable: true },
  { id: 'c2', rank: 12, suit: 'S', playable: false },
  { id: 'c3', rank: 9, suit: 'H', playable: true, note: 'just received' },
  { id: 'c4', rank: 1, suit: 'D', playable: true },
];

const mount = async (layout: HandLayout, width: string | null = null) => {
  const before = document.createElement('button');
  before.textContent = 'Before';
  document.body.append(before);
  const box = document.createElement('div');
  if (width !== null) box.style.inlineSize = width;
  const el = new CardHand();
  el.layout = layout;
  const outs: HandOut[] = [];
  el.addEventListener(OUTPUT_EVENT, (event) => outs.push((event as OutputEvent<HandOut>).detail));
  box.append(el);
  document.body.append(box);
  await settled();
  const root = el.shadowRoot;
  if (root === null) throw new Error('no shadow root');
  return { el, outs, root, before };
};

describe('the hand widget', () => {
  it('is one toolbar Tab stop of card buttons named in words', async () => {
    const { root, before } = await mount({ label: 'Your hand, 4 cards', cards, mode: 'play' });
    await expect.element(page.getByRole('toolbar', { name: 'Your hand, 4 cards' })).toBeVisible();
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      '2 of clubs',
      'Queen of spades',
      '9 of hearts, just received',
      'Ace of diamonds',
    ]);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(buttons[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(buttons[0]?.getAttribute('aria-pressed')).toBeNull();
    // Card art is decoration; the suit's letter is printed on the face too.
    expect(root.querySelectorAll('svg.face[aria-hidden="true"]')).toHaveLength(4);
    expect(root.querySelector('.s-H .letter')?.textContent).toBe('H');
    before.focus();
    await userEvent.keyboard('{Tab}');
    expect(root.activeElement?.getAttribute('data-card')).toBe('c1');
  });

  it('moves with the arrows and plays with Enter; a disabled card is refused', async () => {
    const { root, outs, before } = await mount({ label: 'Your hand', cards, mode: 'play' });
    before.focus();
    await userEvent.keyboard('{Tab}{ArrowRight}');
    await settled();
    expect(root.activeElement?.getAttribute('data-card')).toBe('c2');
    await userEvent.keyboard('{Enter}{End}{Enter}');
    await settled();
    expect(outs).toEqual([
      { _tag: 'Refused', id: 'c2' },
      { _tag: 'Play', id: 'c4' },
    ]);
    // Space plays too, and a key on a button never also clicks it: one output per key.
    await userEvent.keyboard(' ');
    await settled();
    expect(outs).toHaveLength(3);
  });

  it('plays a card with a tap', async () => {
    const { outs } = await mount({ label: 'Your hand', cards, mode: 'play' });
    await page.getByRole('button', { name: 'Ace of diamonds' }).click();
    await settled();
    expect(outs).toEqual([{ _tag: 'Play', id: 'c4' }]);
  });

  it('toggles with Space and commits with Enter when choosing', async () => {
    const chosen = cards.map((c, k) => ({ ...c, playable: true, chosen: k === 0 }));
    const { root, outs, before } = await mount({ label: 'Choose three cards to pass', cards: chosen, mode: 'choose' });
    expect(root.querySelector('[data-card="c1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-card="c2"]')?.getAttribute('aria-pressed')).toBe('false');
    before.focus();
    await userEvent.keyboard('{Tab}{ArrowRight} {Enter}');
    await settled();
    expect(outs).toEqual([{ _tag: 'Toggle', id: 'c2' }, { _tag: 'Commit' }]);
  });

  it('keeps the keyboard in the hand when the played card leaves it', async () => {
    const { el, root, before } = await mount({ label: 'Your hand', cards, mode: 'play' });
    before.focus();
    await userEvent.keyboard('{Tab}{ArrowRight}{ArrowRight}');
    await settled();
    expect(root.activeElement?.getAttribute('data-card')).toBe('c3');
    el.layout = { label: 'Your hand', cards: cards.filter((c) => c.id !== 'c3'), mode: 'play' };
    await settled();
    await settled();
    expect(root.activeElement?.getAttribute('data-card')).toBe('c4');
  });

  it('keeps every card strip at least 44 pixels wide and tall on a phone-width screen', async () => {
    const full: HandCard[] = Array.from({ length: 13 }, (_, k) => ({
      id: `k${k}`,
      rank: (k + 1) as NonNullable<HandCard['rank']>,
      suit: 'S',
      playable: true,
    }));
    const { root } = await mount({ label: 'Your hand', cards: full, mode: 'play' }, '360px');
    const boxes = [...root.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    expect(Math.min(...boxes.map((b) => b.width))).toBeGreaterThanOrEqual(44);
    expect(Math.min(...boxes.map((b) => b.height))).toBeGreaterThanOrEqual(44);
    // Nothing spills past the container.
    expect(Math.max(...boxes.map((b) => b.right))).toBeLessThanOrEqual(boxes[0]!.left + 360);
  });
});
