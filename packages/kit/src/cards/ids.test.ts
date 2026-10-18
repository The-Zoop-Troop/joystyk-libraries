import { isJson } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { CHI_SQUARE_999, chiSquareUniform, forAll } from '../properties.test-util.ts';
import { createRng, restoreRng } from '../rng.ts';
import { face, sameFace, type Card, type Face } from './card.ts';
import { dealRoundRobin } from './deal.ts';
import { standardDeck } from './deck.ts';
import {
  HIDDEN_CARD,
  ID_ALPHABET,
  assignIds,
  hiddenCards,
  isHiddenCard,
  isOpaqueId,
  newCardId,
  perturbHidden,
  redact,
  withStableIds,
} from './ids.ts';

describe('assignIds', () => {
  it('gives every card a unique five-character id', () => {
    forAll(
      'ids-unique',
      50,
      (rng) => rng.int(0, 6),
      (jokers, rng) => {
        const cards = assignIds(rng.shuffle(standardDeck({ decks: 2, jokers })), rng);
        expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
        expect(cards.every((c) => isOpaqueId(c.id))).toBe(true);
        expect(isJson(cards)).toBe(true);
      },
    );
  });

  it('keeps the faces and replaces any earlier id', () => {
    const rng = createRng('reissue');
    const first = assignIds(standardDeck(), rng);
    const second = assignIds(first, rng);
    expect(second.map(({ rank, suit }) => ({ rank, suit }))).toEqual(standardDeck());
    expect(second.some((c, i) => c.id !== first[i]!.id)).toBe(true);
  });

  it('avoids ids already taken', () => {
    const rng = createRng('taken');
    const table = assignIds(standardDeck(), rng);
    const fresh = assignIds(
      [face(5, 'H'), face(6, 'H')],
      rng,
      table.map((c) => c.id),
    );
    for (const card of fresh) expect(table.some((c) => c.id === card.id)).toBe(false);
    const id = newCardId(rng, new Set(table.map((c) => c.id)));
    expect(isOpaqueId(id) && !table.some((c) => c.id === id)).toBe(true);
  });

  describe('opacity', () => {
    it('draws ids from the rng state and the card count alone, never from the faces', () => {
      // The strongest form of "ids reveal nothing": two different decks, in different
      // orders, dealt from the same rng state, get exactly the same sequence of ids.
      forAll(
        'ids-independent',
        50,
        (rng) => rng.save(),
        (state, rng) => {
          const a = assignIds(rng.shuffle(standardDeck()), restoreRng(state)).map((c) => c.id);
          const b = assignIds(standardDeck({ jokers: 3 }).slice(0, 52).reverse(), restoreRng(state)).map((c) => c.id);
          const c = assignIds(
            Array.from({ length: 52 }, (_, i) => ({ anything: i })),
            restoreRng(state),
          ).map((x) => x.id);
          expect(a).toEqual(b);
          expect(a).toEqual(c);
        },
      );
    });

    it("spreads one card's id uniformly over the alphabet across deals", () => {
      const rng = createRng('ids-uniform');
      const counts = Array.from({ length: ID_ALPHABET.length }, () => 0);
      for (let deal = 0; deal < ID_ALPHABET.length * 300; deal += 1) {
        const cards = assignIds(rng.shuffle(standardDeck()), rng);
        const queen = cards.find((c) => sameFace(c, face(12, 'S')))!;
        counts[ID_ALPHABET.indexOf(queen.id[0]!)]! += 1;
      }
      expect(chiSquareUniform(counts)).toBeLessThan(CHI_SQUARE_999[31]!);
    });
  });
});

describe('withStableIds', () => {
  it('names cards by face, numbering later copies', () => {
    const cards = withStableIds([face(12, 'H'), face(10, 'S'), face(12, 'H'), face(12, 'H')]);
    expect(cards.map((c) => c.id)).toEqual(['QH', '10S', 'QH#2', 'QH#3']);
    expect(new Set(withStableIds(standardDeck({ decks: 2, jokers: 2 })).map((c) => c.id)).size).toBe(106);
  });
});

describe('hidden cards', () => {
  it('redacts what the viewer may not see', () => {
    const cards = withStableIds([face(1, 'S'), face(2, 'S'), face(3, 'S')]);
    const view = redact(cards, (_, i) => i === 2);
    expect(view).toEqual([HIDDEN_CARD, HIDDEN_CARD, cards[2]]);
    expect(view.filter(isHiddenCard)).toHaveLength(2);
    expect(hiddenCards(3)).toEqual([{ hidden: true }, { hidden: true }, { hidden: true }]);
    expect(isJson(view)).toBe(true);
  });
});

describe('perturbHidden', () => {
  type Zones = {
    deck: Card<Face>[];
    discard: Card<Face>[];
    hand0: Card<Face>[];
    hand1: Card<Face>[];
    hand2: Card<Face>[];
  };

  const table = (seed: string): Zones => {
    const rng = createRng(seed);
    const cards = assignIds(rng.shuffle(standardDeck()), rng);
    const { hands, rest } = dealRoundRobin(cards, 3, 5);
    return { deck: rest.slice(2), discard: rest.slice(0, 2), hand0: hands[0]!, hand1: hands[1]!, hand2: hands[2]! };
  };

  /** Seat 0 sees its own hand and the discard pile. */
  const seat0Sees = (zone: keyof Zones): boolean => zone === 'hand0' || zone === 'discard';

  const sortedJson = (values: readonly unknown[]): string[] => values.map((v) => JSON.stringify(v)).sort();

  it('keeps visible cards and every count, and only rearranges hidden faces and ids', () => {
    forAll(
      'perturb',
      100,
      (rng) => String(rng.int(0, 1e9)),
      (seed, rng) => {
        const zones = table(seed);
        const out = perturbHidden(zones, seat0Sees, rng);
        expect(Object.keys(out)).toEqual(Object.keys(zones));
        for (const zone of Object.keys(zones) as (keyof Zones)[]) {
          expect(out[zone]).toHaveLength(zones[zone].length);
          if (seat0Sees(zone)) expect(out[zone]).toEqual(zones[zone]);
        }
        const hiddenBefore = [...zones.deck, ...zones.hand1, ...zones.hand2];
        const hiddenAfter = [...out.deck, ...out.hand1, ...out.hand2];
        expect(sortedJson(hiddenAfter.map((c) => c.id))).toEqual(sortedJson(hiddenBefore.map((c) => c.id)));
        expect(sortedJson(hiddenAfter.map(({ rank, suit }) => ({ rank, suit })))).toEqual(
          sortedJson(hiddenBefore.map(({ rank, suit }) => ({ rank, suit }))),
        );
        expect(hiddenAfter).not.toEqual(hiddenBefore);
      },
    );
  });

  it('lets a no-leak test pass a view that hides cards and catch one that leaks ids', () => {
    const goodView = (z: Zones) => ({ hand: z.hand0, discard: z.discard, others: [z.hand1.length, z.hand2.length] });
    // Hides faces but keeps ids: the flaw shift-23.md describes in the source game.
    const leakyView = (z: Zones) => ({ ...goodView(z), others: [z.hand1.map((c) => c.id), z.hand2.map((c) => c.id)] });
    const rng = createRng('leak-test');
    let caught = false;
    for (let i = 0; i < 20; i += 1) {
      const zones = table(`leak-${i}`);
      const perturbed = perturbHidden(zones, seat0Sees, rng);
      expect(goodView(perturbed)).toEqual(goodView(zones));
      if (JSON.stringify(leakyView(perturbed)) !== JSON.stringify(leakyView(zones))) caught = true;
    }
    expect(caught).toBe(true);
  });
});
