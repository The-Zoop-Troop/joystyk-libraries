import { describe, expect, it } from 'vitest';
import type { SuitedCard, SuitedFace } from './card.ts';
import { hand, show } from './cards.test-util.ts';
import { heartsPoints } from './points.ts';
import { isLegalPlay, ledSuit, legalPlays, trickWinner, type Play } from './tricks.ts';

const isPoint = (card: SuitedFace): boolean => heartsPoints(card) > 0;
const isTwoOfClubs = (card: SuitedFace): boolean => card.rank === 2 && card.suit === 'C';

describe('legalPlays', () => {
  it('must follow suit when able', () => {
    expect(show(legalPlays(hand('2C 9C 5H QS'), { led: 'C' }))).toBe('2C 9C');
  });

  it('allows anything when void in the led suit', () => {
    expect(show(legalPlays(hand('5H QS 3D'), { led: 'C' }))).toBe('5H QS 3D');
  });

  it("won't lead an unbroken suit unless the hand holds nothing else", () => {
    expect(show(legalPlays(hand('5H 9H 3D'), { led: null, unbroken: 'H' }))).toBe('3D');
    expect(show(legalPlays(hand('5H 9H'), { led: null, unbroken: 'H' }))).toBe('5H 9H');
    expect(show(legalPlays(hand('5H 9H 3D'), { led: null, unbroken: null }))).toBe('5H 9H 3D');
  });

  it('lets a Hearts leader with only hearts and the Queen of Spades lead only the Queen', () => {
    expect(show(legalPlays(hand('5H QS 9H'), { led: null, unbroken: 'H' }))).toBe('QS');
  });

  it('makes the 2 of clubs lead the first trick', () => {
    expect(show(legalPlays(hand('2C 9C 5H AS'), { led: null, unbroken: 'H', required: isTwoOfClubs }))).toBe('2C');
  });

  it('bans point cards on the first trick unless the hand holds nothing else', () => {
    const firstTrick = { led: 'C' as const, banned: isPoint };
    expect(show(legalPlays(hand('5H QS 3D'), firstTrick))).toBe('3D');
    expect(show(legalPlays(hand('5H QS 9H'), firstTrick))).toBe('5H QS 9H');
    expect(show(legalPlays(hand('2C 5H'), firstTrick))).toBe('2C');
  });

  it('has no plays for an empty hand', () => {
    expect(legalPlays([], { led: 'S' })).toEqual([]);
  });

  it('checks one play by id', () => {
    const cards = hand('2C 9C 5H');
    expect(isLegalPlay(cards, cards[1]!, { led: 'C' })).toBe(true);
    expect(isLegalPlay(cards, cards[2]!, { led: 'C' })).toBe(false);
  });
});

describe('trickWinner', () => {
  const plays = (text: string, leader = 0): Play<SuitedCard>[] =>
    hand(text).map((card, i) => ({ seat: (leader + i) % 4, card }));

  it('gives the trick to the highest card of the led suit, aces high', () => {
    expect(trickWinner(plays('10C KC AC 2C'))).toBe(2);
    expect(trickWinner(plays('10C AH KD 2C', 1))).toBe(1);
  });

  it('gives the trick to the highest trump when one is played', () => {
    expect(trickWinner(plays('AC 2S KC 3S'), 'S')).toBe(3);
    expect(trickWinner(plays('AC KC 2H QC'), 'S')).toBe(0);
  });

  it('can rank aces low', () => {
    expect(trickWinner(plays('AC 2C'), null, false)).toBe(1);
  });

  it('reports the led suit and rejects an empty trick', () => {
    expect(ledSuit(plays('QD 3S'))).toBe('D');
    expect(ledSuit([])).toBe(null);
    expect(() => trickWinner([])).toThrow(RangeError);
  });
});
