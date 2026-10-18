import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import { CHI_SQUARE_999, chiSquareUniform, forAll } from '../properties.test-util.ts';
import { SUITS, type Suit, type SuitedCard } from './card.ts';
import { hand, show } from './cards.test-util.ts';
import { standardDeck } from './deck.ts';
import { withStableIds } from './ids.ts';
import { canSampleHands, inferVoids, sampleHands, type SampleSpec } from './sample.ts';
import type { Play } from './tricks.ts';

const deck = (): SuitedCard[] => withStableIds(standardDeck()) as SuitedCard[];

/** Every id once, each seat holding its count, no seat holding a suit it lacks, known cards in place. */
const expectConsistent = (spec: SampleSpec<SuitedCard>, hands: SuitedCard[][] | null): void => {
  expect(hands).not.toBeNull();
  const dealt = hands!.flat().map((c) => c.id);
  const expected = [...spec.cards, ...(spec.known ?? []).map((k) => k.card)].map((c) => c.id);
  expect([...dealt].sort()).toEqual([...expected].sort());
  hands!.forEach((cards, seat) => {
    expect(cards).toHaveLength(spec.counts[seat]!);
    for (const card of cards) expect(spec.voids?.[seat]?.includes(card.suit) ?? false).toBe(false);
  });
  for (const { seat, card } of spec.known ?? []) expect(hands![seat]!.map((c) => c.id)).toContain(card.id);
};

describe('sampleHands', () => {
  it('deals every unseen card once, honoring the counts, without constraints', () => {
    const cards = deck().slice(13);
    const spec = { cards, counts: [0, 13, 13, 13] };
    const hands = sampleHands(spec, createRng('free'));
    expectConsistent(spec, hands);
    expect(hands![0]).toEqual([]);
  });

  it('is deterministic: the same seed gives the same deal', () => {
    const spec = { cards: deck().slice(13), counts: [0, 13, 13, 13], voids: [[], ['H'], [], ['C', 'D']] as Suit[][] };
    expect(sampleHands(spec, createRng('same'))).toEqual(sampleHands(spec, createRng('same')));
    expect(sampleHands(spec, createRng('same'))).not.toEqual(sampleHands(spec, createRng('other')));
  });

  it('keeps known cards in their seats and voids out of the seats that lack them', () => {
    const all = deck();
    const known = all.slice(0, 3).map((card) => ({ seat: 2, card }));
    const spec: SampleSpec<SuitedCard> = {
      cards: all.slice(16),
      counts: [0, 12, 15, 12],
      voids: [[], ['S', 'H'], [], ['D']],
      known,
    };
    forAll(
      'known and voids',
      40,
      (rng) => rng.save(),
      (state) => expectConsistent(spec, sampleHands(spec, createRng(String(state.words[0])))),
    );
  });

  it('places constrained cards first, so a seat void in three suits always gets the fourth', () => {
    // Seat 1 can only hold hearts and must hold all 9 unseen hearts. A careless sampler that
    // handed a heart to seat 2 or 3 would strand seat 1.
    const cards = hand('2H 3H 4H 5H 6H 7H 8H 9H 10H 2C 3C 4C 5C 6C 7C 8C 9C 10C');
    const spec: SampleSpec<SuitedCard> = { cards, counts: [0, 9, 5, 4], voids: [[], ['S', 'D', 'C'], [], []] };
    forAll(
      'three voids',
      60,
      (rng) => rng.int(0, 1_000_000),
      (seed) => {
        const hands = sampleHands(spec, createRng(`v${seed}`));
        expectConsistent(spec, hands);
        expect(show(hands![1]!.slice().sort((a, b) => a.rank - b.rank))).toBe('2H 3H 4H 5H 6H 7H 8H 9H 10H');
      },
    );
  });

  it('solves chains of constraints that rejection sampling would rarely hit', () => {
    // Clubs fit only seat 1 or 2, diamonds only 2 or 3, spades only 3 or 1: every deal is a
    // tight cycle of room. Random play-outs across many suits keep the three counts exact.
    const cards = hand('2C 3C 4C 5C 2D 3D 4D 5D 2S 3S 4S 5S');
    const spec: SampleSpec<SuitedCard> = {
      cards,
      counts: [0, 4, 4, 4],
      voids: [[], ['D', 'H'], ['S', 'H'], ['C', 'H']],
    };
    expect(canSampleHands(spec)).toBe(true);
    forAll(
      'cycle',
      60,
      (rng) => rng.int(0, 1_000_000),
      (seed) => expectConsistent(spec, sampleHands(spec, createRng(`c${seed}`))),
    );
  });

  it('returns null, drawing nothing, when no deal fits', () => {
    const cards = hand('2H 3H 4H 5H 2C');
    // Two seats lack hearts and the third has room for three of the four.
    const tooMany: SampleSpec<SuitedCard> = { cards, counts: [0, 1, 1, 3], voids: [[], ['H'], ['H'], []] };
    expect(canSampleHands(tooMany)).toBe(false);
    const rng = createRng('none');
    const before = rng.save();
    expect(sampleHands(tooMany, rng)).toBeNull();
    expect(rng.save()).toEqual(before);
    // Counts that don't add up, or more known cards than a hand holds.
    expect(sampleHands({ cards, counts: [0, 2, 2] }, createRng('x'))).toBeNull();
    expect(
      sampleHands({ cards: [], counts: [0, 0], known: [{ seat: 1, card: cards[0]! }] }, createRng('x')),
    ).toBeNull();
    // A seat with cards but every suit ruled out.
    expect(canSampleHands({ cards: hand('2H'), counts: [0, 1], voids: [[], [...SUITS]] })).toBe(false);
  });

  it('applies a further rule through `allowed`', () => {
    const cards = hand('QS AS 2D 3D');
    const spec: SampleSpec<SuitedCard> = {
      cards,
      counts: [0, 2, 2],
      allowed: (card, seat) => !(card.rank === 12 && card.suit === 'S' && seat === 1),
    };
    forAll(
      'allowed',
      30,
      (rng) => rng.int(0, 1_000_000),
      (seed) => {
        const hands = sampleHands(spec, createRng(`a${seed}`));
        expectConsistent(spec, hands);
        expect(show(hands![2]!)).toContain('QS');
      },
    );
  });

  it('makes every deal equally likely without constraints (chi-square, fixed seed)', () => {
    // Four cards between two seats of two: six deals.
    const cards = hand('2C 3C 4C 5C');
    const rng = createRng('uniform deals');
    const counts = new Map<string, number>();
    for (let n = 0; n < 6000; n += 1) {
      const hands = sampleHands({ cards, counts: [0, 2, 2] }, rng)!;
      const key = show(hands[1]!.slice().sort((a, b) => a.rank - b.rank));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    expect(chiSquareUniform([...counts.values()])).toBeLessThan(CHI_SQUARE_999[5]!);
  });

  it('reaches every consistent deal of a small constrained case', () => {
    // Seat 1 lacks clubs: the clubs go to seat 2 or 3, and the hearts fill what is left.
    const cards = hand('2C 3C 2H 3H');
    const spec: SampleSpec<SuitedCard> = { cards, counts: [0, 1, 2, 1], voids: [[], ['C'], [], []] };
    const seen = new Set<string>();
    const rng = createRng('coverage');
    for (let n = 0; n < 400; n += 1)
      seen.add(
        sampleHands(spec, rng)!
          .map((h) => show(h.slice().sort((a, b) => a.id.localeCompare(b.id))))
          .join('|'),
      );
    // Brute force: seat 1 takes one heart (2 ways); the other three cards split 2 and 1 between
    // seats 2 and 3 (3 ways). Six deals in all.
    expect(seen.size).toBe(6);
  });

  it('refuses more seats than it can check', () => {
    expect(() => sampleHands({ cards: [], counts: new Array<number>(13).fill(0) }, createRng('x'))).toThrow(RangeError);
  });
});

describe('inferVoids', () => {
  const plays = (text: string, leader = 0): Play<SuitedCard>[] =>
    hand(text).map((card, i) => ({ seat: (leader + i) % 4, card }));

  it('marks a seat void in the led suit when it plays another suit', () => {
    const tricks = [plays('2C 9C 5H KC'), plays('AD 3S 4D', 2)];
    // Trick 1: seat 2 discarded on clubs. Trick 2 (led by seat 2): seat 3 trumped diamonds.
    expect(inferVoids(tricks, 4)).toEqual([[], [], ['C'], ['D']]);
  });

  it('lists each suit once and ignores empty tricks', () => {
    expect(inferVoids([plays('2C 5H'), plays('3C 6H'), []], 4)).toEqual([[], ['C'], [], []]);
  });
});
