import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import { JOKER, QUEEN, face, type Face } from './card.ts';
import { dealAll, dealRoundRobin, draw, turnUp } from './deal.ts';
import { repeatDeck, standardDeck } from './deck.ts';
import { cardShort } from './names.ts';

const labels = (cards: readonly Face[]): string[] => cards.map((c) => cardShort(c, { glyphs: false }));

describe('standardDeck', () => {
  it('builds 52 distinct cards in canonical order: S, H, D, C, ace to king', () => {
    const deck = standardDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(labels(deck)).size).toBe(52);
    expect(labels(deck.slice(0, 3))).toEqual(['AS', '2S', '3S']);
    expect(labels(deck.slice(12, 14))).toEqual(['KS', 'AH']);
    expect(labels(deck.slice(-1))).toEqual(['KC']);
  });

  it('combines decks one after another', () => {
    const deck = standardDeck({ decks: 2 });
    expect(deck).toHaveLength(104);
    expect(deck.slice(52)).toEqual(standardDeck());
  });

  it('adds jokers at the end', () => {
    const deck = standardDeck({ jokers: 2 });
    expect(deck).toHaveLength(54);
    expect(deck.slice(52)).toEqual([JOKER, JOKER]);
  });

  it('restricts suits, as Spider does', () => {
    const oneSuit = standardDeck({ decks: 8, suits: ['S'] });
    expect(oneSuit).toHaveLength(104);
    expect(oneSuit.every((c) => c.suit === 'S')).toBe(true);
    expect(standardDeck({ decks: 4, suits: ['S', 'H'] })).toHaveLength(104);
  });

  it('removes named cards, as Old Maid does', () => {
    const deck = standardDeck({ without: [face(QUEEN, 'C')] });
    expect(deck).toHaveLength(51);
    expect(labels(deck)).not.toContain('QC');
    expect(() => standardDeck({ without: [face(QUEEN, 'C'), face(QUEEN, 'C')] })).toThrow(RangeError);
  });

  it('rejects bad counts', () => {
    expect(() => standardDeck({ decks: -1 })).toThrow(RangeError);
    expect(() => standardDeck({ jokers: 1.5 })).toThrow(RangeError);
  });

  it('repeats a custom deck, such as a 76-card one', () => {
    type Custom =
      { readonly kind: 'number'; readonly value: number } | { readonly kind: 'storm'; readonly name: string };
    const faces: Custom[] = [
      ...Array.from({ length: 60 }, (_, i): Custom => ({ kind: 'number', value: (i % 15) + 1 })),
      ...Array.from({ length: 16 }, (_, i): Custom => ({ kind: 'storm', name: `storm-${i % 8}` })),
    ];
    expect(repeatDeck(faces, 1)).toHaveLength(76);
    expect(repeatDeck(faces, 2)).toHaveLength(152);
  });

  it('shuffles the same way from the same seed', () => {
    expect(createRng('deal').shuffle(standardDeck())).toEqual(createRng('deal').shuffle(standardDeck()));
  });
});

describe('deal', () => {
  const deck = Array.from({ length: 20 }, (_, i) => i);

  it('draws from the top (index 0)', () => {
    expect(draw(deck, 3)).toEqual({ drawn: [0, 1, 2], rest: deck.slice(3) });
    expect(turnUp(deck)).toEqual({ card: 0, rest: deck.slice(1) });
    expect(() => draw(deck, 21)).toThrow(RangeError);
    expect(() => turnUp([])).toThrow(RangeError);
  });

  it('deals round-robin from a given seat', () => {
    const { hands, rest } = dealRoundRobin(deck, 4, 3, 1);
    expect(hands).toEqual([
      [3, 7, 11],
      [0, 4, 8],
      [1, 5, 9],
      [2, 6, 10],
    ]);
    expect(rest).toEqual(deck.slice(12));
    expect(() => dealRoundRobin(deck, 4, 6)).toThrow(RangeError);
    expect(() => dealRoundRobin(deck, 4, 1, 4)).toThrow(RangeError);
  });

  it('deals everything as evenly as possible', () => {
    const hands = dealAll(deck.slice(0, 10), 3, 2);
    expect(hands.map((h) => h.length)).toEqual([3, 3, 4]);
    expect(hands[2]).toEqual([0, 3, 6, 9]);
    expect(hands.flat().sort((a, b) => a - b)).toEqual(deck.slice(0, 10));
  });
});
