import { describe, expect, it } from 'vitest';
import { SLOTS, SLOT_IDS, isSlotId, slot, slotBoxStyles } from './slots.ts';

describe('the slot registry', () => {
  it('lists the six v1 slots from monetization.md, once each', () => {
    expect(SLOTS.map((s) => s.id)).toEqual([
      'index-hero',
      'index-inline',
      'category-rail',
      'game-page',
      'results',
      'daily-presenting',
    ]);
    expect(SLOT_IDS).toEqual(SLOTS.map((s) => s.id));
  });

  it('recognises slot ids and nothing else', () => {
    expect(isSlotId('results')).toBe(true);
    expect(isSlotId('popup')).toBe(false);
    expect(isSlotId(3)).toBe(false);
  });

  it('labels every slot as advertising', () => {
    expect(SLOTS.every((s) => s.label === 'Advertisement' || s.label === 'Sponsored')).toBe(true);
  });

  it('hides the rail on narrow screens and gives every other slot a box at both widths', () => {
    expect(slot('category-rail').sizes.narrow).toBeNull();
    for (const s of SLOTS.filter((x) => x.id !== 'category-rail')) {
      expect(s.sizes.narrow, s.id).not.toBeNull();
      expect(s.sizes.wide, s.id).not.toBeNull();
    }
  });

  it('never targets a person: only page, game, category and date', () => {
    const keys = new Set(SLOTS.flatMap((s) => s.targeting));
    expect([...keys].sort()).toEqual(['category', 'date', 'game', 'page']);
  });

  it('throws for an unknown slot, naming the registry', () => {
    expect(() => slot('nope' as never)).toThrow(/slots\.ts/);
  });
});

describe('slotBoxStyles', () => {
  const css = slotBoxStyles();

  it('reserves each box with its exact aspect ratio, capped at its width', () => {
    expect(css).toContain(
      ".box[data-slot='game-page'] { display: grid; inline-size: min(100%, 300px); aspect-ratio: 300 / 250; }",
    );
    expect(css).toContain(".box[data-slot='category-rail'] { display: none; }");
  });

  it('switches to the wide box once the container fits it, inside the components layer', () => {
    expect(css.startsWith('@layer components {')).toBe(true);
    expect(css).toContain(
      "@container (inline-size >= 728px) {\n    .box[data-slot='index-hero'] { display: grid; inline-size: min(100%, 728px); aspect-ratio: 728 / 90; }",
    );
    expect(css).toContain("@container (inline-size >= 160px) {\n    .box[data-slot='category-rail']");
  });
});
