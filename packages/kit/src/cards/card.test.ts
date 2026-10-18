import { describe, expect, it } from 'vitest';
import {
  JOKER,
  face,
  isDescendingAlternating,
  isDescendingSameSuit,
  isRank,
  isSuit,
  nextRank,
  previousRank,
  rankValue,
  sameColor,
  sortHand,
  suitColor,
  trailingRunLength,
  type Face,
} from './card.ts';
import { cardName, cardShort, rankName, suitName, suitPluralName } from './names.ts';
import { crazyEightsPenalty, deadwoodValue, heartsPoints } from './points.ts';

describe('ranks and suits', () => {
  it('validates ranks and suits', () => {
    expect([0, 1, 13, 14, 1.5, '1'].map(isRank)).toEqual([false, true, true, false, false, false]);
    expect(['S', 'H', 'D', 'C', 's', 'X'].map(isSuit)).toEqual([true, true, true, true, false, false]);
  });

  it('colors hearts and diamonds red', () => {
    expect(['S', 'H', 'D', 'C'].map((s) => suitColor(s as 'S'))).toEqual(['black', 'red', 'red', 'black']);
    expect(sameColor(face(3, 'H'), face(9, 'D'))).toBe(true);
    expect(sameColor(face(3, 'H'), face(9, 'C'))).toBe(false);
  });

  it('ranks the ace low by default and high on request', () => {
    expect(rankValue(1)).toBe(1);
    expect(rankValue(1, true)).toBe(14);
    expect(rankValue(13, true)).toBe(13);
  });

  it('steps between ranks, stopping at the ends', () => {
    expect(nextRank(12)).toBe(13);
    expect(nextRank(13)).toBe(null);
    expect(nextRank(13, true)).toBe(1);
    expect(nextRank(1, true)).toBe(null);
    expect(previousRank(1)).toBe(null);
    expect(previousRank(2)).toBe(1);
    expect(previousRank(2, true)).toBe(null);
    expect(previousRank(1, true)).toBe(13);
  });

  it('recognizes tableau runs', () => {
    expect(isDescendingAlternating([face(13, 'S'), face(12, 'H'), face(11, 'C')])).toBe(true);
    expect(isDescendingAlternating([face(13, 'S'), face(12, 'C')])).toBe(false);
    expect(isDescendingAlternating([face(13, 'S'), face(11, 'H')])).toBe(false);
    expect(isDescendingAlternating([])).toBe(true);
    expect(isDescendingSameSuit([face(5, 'S'), face(4, 'S'), face(3, 'S')])).toBe(true);
    expect(isDescendingSameSuit([face(5, 'S'), face(4, 'H')])).toBe(false);
  });

  it('measures the run at the end of a pile', () => {
    const pile = [face(9, 'H'), face(13, 'S'), face(12, 'H'), face(11, 'S'), face(10, 'S')];
    expect(trailingRunLength(pile, 'alternating')).toBe(1);
    expect(trailingRunLength(pile.slice(0, 4), 'alternating')).toBe(3);
    expect(trailingRunLength([face(8, 'S'), face(7, 'S'), face(6, 'S'), face(5, 'H')], 'same-suit')).toBe(1);
    expect(trailingRunLength([face(8, 'S'), face(7, 'S'), face(6, 'S')], 'same-suit')).toBe(3);
    expect(trailingRunLength([], 'same-suit')).toBe(0);
  });

  it('sorts a hand by suit order, then rank, jokers last', () => {
    const hand: Face[] = [face(1, 'H'), JOKER, face(10, 'C'), face(2, 'H'), face(13, 'S')];
    expect(sortHand(hand).map((c) => cardShort(c, { glyphs: false }))).toEqual(['KS', 'AH', '2H', '10C', 'JK']);
    expect(
      sortHand(hand, { suitOrder: ['C', 'D', 'S', 'H'], aceHigh: true }).map((c) => cardShort(c, { glyphs: false })),
    ).toEqual(['10C', 'KS', '2H', 'AH', 'JK']);
    expect(sortHand(hand, { descending: true }).map((c) => cardShort(c, { glyphs: false }))).toEqual([
      'KS',
      '2H',
      'AH',
      '10C',
      'JK',
    ]);
  });
});

describe('names', () => {
  it('speaks cards in full', () => {
    expect(cardName(face(12, 'S'))).toBe('Queen of spades');
    expect(cardName(face(7, 'H'))).toBe('7 of hearts');
    expect(cardName(face(1, 'D'))).toBe('Ace of diamonds');
    expect(cardName(JOKER)).toBe('Joker');
    expect([rankName(11), suitName('C'), suitPluralName('C')]).toEqual(['Jack', 'Club', 'clubs']);
  });

  it('labels cards compactly, with or without glyphs', () => {
    expect(cardShort(face(12, 'H'))).toBe('Q♥');
    expect(cardShort(face(10, 'S'), { glyphs: false })).toBe('10S');
    expect(cardShort(JOKER)).toBe('JK');
  });
});

describe('points', () => {
  it('scores Hearts, Gin Rummy deadwood and Crazy Eights penalties', () => {
    expect([heartsPoints(face(5, 'H')), heartsPoints(face(12, 'S')), heartsPoints(face(12, 'C'))]).toEqual([1, 13, 0]);
    expect([1, 7, 10, 11, 13].map((r) => deadwoodValue(face(r as 1, 'C')))).toEqual([1, 7, 10, 10, 10]);
    expect([1, 7, 8, 12].map((r) => crazyEightsPenalty(face(r as 1, 'C')))).toEqual([1, 7, 50, 10]);
  });
});
