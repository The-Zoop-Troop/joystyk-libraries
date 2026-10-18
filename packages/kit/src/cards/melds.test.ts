import type { Rng } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { forAll } from '../properties.test-util.ts';
import type { SuitedCard, SuitedFace } from './card.ts';
import { hand, show } from './cards.test-util.ts';
import { standardDeck } from './deck.ts';
import { withStableIds } from './ids.ts';
import {
  bestArrangement,
  bestArrangements,
  bestLayoffs,
  canLayOff,
  isRun,
  isSet,
  meldKind,
  takeGroups,
  type Arrangement,
  type Meld,
} from './melds.ts';
import { deadwoodValue } from './points.ts';

const summary = (a: Arrangement<SuitedFace>): { melds: string[]; deadwood: string; points: number } => ({
  melds: a.melds.map((m) => `${m.kind}: ${show(m.cards)}`),
  deadwood: show(a.deadwood),
  points: a.points,
});

const meld = (text: string): Meld<SuitedCard> => {
  const cards = hand(text);
  return { kind: meldKind(cards)!, cards };
};

// Independent oracle: list every subset of the hand that is a meld (by brute force over all
// subsets, checked with isSet and isRun), then try every packing of disjoint melds.
const oracleDeadwood = (cards: readonly SuitedFace[]): number => {
  const n = cards.length;
  const melds: number[] = [];
  for (let mask = 1; mask < 1 << n; mask += 1) {
    const subset = cards.filter((_, i) => mask & (1 << i));
    if (isSet(subset) || isRun(subset)) melds.push(mask);
  }
  const total = (mask: number): number =>
    cards.reduce((sum, c, i) => (mask & (1 << i) ? sum + deadwoodValue(c) : sum), 0);
  const search = (from: number, free: number): number => {
    let best = total(free);
    for (let j = from; j < melds.length; j += 1) {
      if ((melds[j]! & free) === melds[j]) best = Math.min(best, search(j + 1, free & ~melds[j]!));
    }
    return best;
  };
  return search(0, (1 << n) - 1);
};

/** A hand drawn from a low-rank deck, where melds are common. */
const meldyHand = (rng: Rng, size: number): SuitedCard[] =>
  withStableIds(rng.shuffle(standardDeck().filter((c) => c.rank !== 'joker' && c.rank <= 6))).slice(
    0,
    size,
  ) as SuitedCard[];

describe('isSet and isRun', () => {
  it('accepts sets of three or four of a rank', () => {
    expect(isSet(hand('7S 7H 7D'))).toBe(true);
    expect(isSet(hand('7S 7H 7D 7C'))).toBe(true);
    expect(isSet(hand('7S 7H'))).toBe(false);
    expect(isSet(hand('7S 7H 8D'))).toBe(false);
  });

  it('accepts runs of three or more in one suit, ace low, without wrapping', () => {
    expect(isRun(hand('AS 2S 3S'))).toBe(true);
    expect(isRun(hand('9H JH 10H QH'))).toBe(true);
    expect(isRun(hand('QS KS AS'))).toBe(false);
    expect(isRun(hand('KS AS 2S'))).toBe(false);
    expect(isRun(hand('4S 5S 6H'))).toBe(false);
    expect(isRun(hand('4S 6S 7S'))).toBe(false);
    expect(meldKind(hand('4S 5S 6S'))).toBe('run');
    expect(meldKind(hand('4S 4C 4H'))).toBe('set');
    expect(meldKind(hand('4S 5C'))).toBe(null);
  });
});

describe('takeGroups', () => {
  it('pairs cards for Old Maid: three of a rank leave one, four make two pairs', () => {
    const { groups, rest } = takeGroups(hand('5S 9H 5D 5C 9S KH KD KS KC 2D'), 2);
    expect(groups.map(show)).toEqual(['5S 5D', '9H 9S', 'KH KD', 'KS KC']);
    expect(show(rest)).toBe('5C 2D');
  });

  it('finds books of four for Go Fish', () => {
    const { groups, rest } = takeGroups(hand('5S 5D 5C 5H 9H'), 4);
    expect(groups.map(show)).toEqual(['5S 5D 5C 5H']);
    expect(show(rest)).toBe('9H');
  });
});

describe('bestArrangement', () => {
  it('finds gin', () => {
    expect(summary(bestArrangement(hand('3S 4S 5S 6S 7H 7D 7C 9C 9D 9H')))).toEqual({
      melds: ['run: 3S 4S 5S 6S', 'set: 7H 7D 7C', 'set: 9H 9D 9C'],
      deadwood: '',
      points: 0,
    });
  });

  it('gives a shared card to the meld that leaves less deadwood', () => {
    // 7H fits the set and the run. The set leaves 5H 6H K = 21; the run leaves 7D 7C K = 24.
    expect(summary(bestArrangement(hand('5H 6H 7H 7D 7C KS')))).toEqual({
      melds: ['set: 7H 7D 7C'],
      deadwood: 'KS 5H 6H',
      points: 21,
    });
  });

  it('splits four of a kind to free a card for a run', () => {
    expect(summary(bestArrangement(hand('7S 7H 7D 7C 8H 9H')))).toEqual({
      melds: ['set: 7S 7D 7C', 'run: 7H 8H 9H'],
      deadwood: '',
      points: 0,
    });
  });

  it('never wraps a run from king to ace', () => {
    expect(bestArrangement(hand('QS KS AS')).points).toBe(21);
    expect(bestArrangement(hand('AS 2S 3S')).points).toBe(0);
  });

  it('handles empty and meldless hands', () => {
    expect(summary(bestArrangement([]))).toEqual({ melds: [], deadwood: '', points: 0 });
    expect(bestArrangement(hand('AS 3H 5D 7C 9S JH KD')).points).toBe(1 + 3 + 5 + 7 + 9 + 10 + 10);
  });

  it('takes a custom value table', () => {
    expect(bestArrangement(hand('AS KH'), { value: () => 1 }).points).toBe(2);
  });

  it('matches the brute-force oracle on random hands', () => {
    let withMelds = 0;
    forAll(
      'melds-oracle',
      300,
      (rng) => meldyHand(rng, rng.int(3, 12)),
      (cards) => {
        const best = bestArrangement(cards);
        expect(best.points).toBe(oracleDeadwood(cards));
        if (best.melds.length > 1) withMelds += 1;
        // The arrangement is a partition of the hand into valid melds and deadwood.
        expect(best.melds.every((m) => (m.kind === 'set' ? isSet(m.cards) : isRun(m.cards)))).toBe(true);
        const used = [...best.melds.flatMap((m) => m.cards), ...best.deadwood].map((c) => c.id).sort();
        expect(used).toEqual(cards.map((c) => c.id).sort());
        expect(best.points).toBe(best.deadwood.reduce((sum, c) => sum + deadwoodValue(c), 0));
      },
    );
    expect(withMelds).toBeGreaterThan(30);
  });

  it('is fast enough for an AI search on eleven-card hands', () => {
    forAll(
      'melds-speed',
      1000,
      (rng) => meldyHand(rng, 11),
      (cards) => {
        expect(bestArrangement(cards).points).toBeGreaterThanOrEqual(0);
      },
    );
  });
});

describe('bestArrangements', () => {
  it('lists every arrangement with the least deadwood, the first one first', () => {
    // A set of jacks and a J-Q-K run both leave 20.
    const all = bestArrangements(hand('JS QS KS JH JD'));
    expect(all.map(summary)).toEqual([
      { melds: ['run: JS QS KS'], deadwood: 'JH JD', points: 20 },
      { melds: ['set: JS JH JD'], deadwood: 'QS KS', points: 20 },
    ]);
    expect(summary(bestArrangement(hand('JS QS KS JH JD')))).toEqual(summary(all[0]!));
  });

  it('agrees with bestArrangement on random hands', () => {
    forAll(
      'arrangements',
      100,
      (rng) => meldyHand(rng, rng.int(3, 11)),
      (cards) => {
        const all = bestArrangements(cards);
        const best = bestArrangement(cards);
        expect(all.length).toBeGreaterThan(0);
        expect(all.every((a) => a.points === best.points)).toBe(true);
        expect(summary(all[0]!)).toEqual(summary(best));
        expect(new Set(all.map((a) => JSON.stringify(summary(a)))).size).toBe(all.length);
      },
    );
  });
});

describe('layoffs', () => {
  it('knows which cards fit a meld', () => {
    expect(canLayOff(hand('7C')[0]!, meld('7S 7H 7D'))).toBe(true);
    expect(canLayOff(hand('7C')[0]!, meld('7S 7H 7D 7C'))).toBe(false);
    expect(canLayOff(hand('4H')[0]!, meld('5H 6H 7H'))).toBe(true);
    expect(canLayOff(hand('8H')[0]!, meld('5H 6H 7H'))).toBe(true);
    expect(canLayOff(hand('9H')[0]!, meld('5H 6H 7H'))).toBe(false);
    expect(canLayOff(hand('8S')[0]!, meld('5H 6H 7H'))).toBe(false);
  });

  it('chains layoffs along a run', () => {
    const defense = bestLayoffs(hand('9H 8H KC 4H 3H'), [meld('5H 6H 7H')]);
    expect(defense.layoffs.map((l) => `${show([l.card])}>${l.meld}`)).toEqual(['4H>0', '3H>0', '8H>0', '9H>0']);
    expect(show(defense.deadwood)).toBe('KC');
    expect(defense.points).toBe(10);
  });

  it('lays a fourth card on a set', () => {
    const defense = bestLayoffs(hand('7C 2D'), [meld('5H 6H 7H'), meld('7S 7H 7D')]);
    expect(defense.layoffs.map((l) => `${show([l.card])}>${l.meld}`)).toEqual(['7C>1']);
    expect(defense.points).toBe(2);
  });

  it('keeps a card for its own meld when that leaves less deadwood', () => {
    const defense = bestLayoffs(hand('8H 8S 8D 2C'), [meld('5H 6H 7H')]);
    expect(defense.layoffs).toEqual([]);
    expect(defense.melds.map((m) => show(m.cards))).toEqual(['8S 8H 8D']);
    expect(defense.points).toBe(2);
  });

  it('rejects a target that is not a meld', () => {
    expect(() => bestLayoffs(hand('2C'), [{ kind: 'run', cards: hand('5H 6H 8H') }])).toThrow(RangeError);
  });

  // Oracle: try every subset of the hand as the laid-off cards, and every assignment of
  // those cards to targets; keep the assignments that leave every target a meld.
  const oracleDefense = (cards: readonly SuitedCard[], targets: readonly Meld<SuitedCard>[]): number => {
    let best = Infinity;
    for (let laid = 0; laid < 1 << cards.length; laid += 1) {
      const chosen = cards.filter((_, i) => laid & (1 << i));
      const assignments = targets.length ** chosen.length;
      let valid = chosen.length === 0;
      for (let a = 0; a < assignments && !valid; a += 1) {
        const extended = targets.map((t) => [...t.cards]);
        let code = a;
        for (const card of chosen) {
          extended[code % targets.length]!.push(card);
          code = Math.floor(code / targets.length);
        }
        valid = extended.every((cs, t) => (targets[t]!.kind === 'set' ? isSet(cs) : isRun(cs)));
      }
      if (valid) best = Math.min(best, oracleDeadwood(cards.filter((_, i) => !(laid & (1 << i)))));
    }
    return best;
  };

  it('matches the brute-force oracle on random hands and targets', () => {
    let withLayoffs = 0;
    forAll(
      'layoffs-oracle',
      150,
      (rng) => {
        const deck = withStableIds(
          rng.shuffle(standardDeck().filter((c) => c.rank !== 'joker' && c.rank <= 8)),
        ) as SuitedCard[];
        // Targets: up to two disjoint melds found among the first dozen cards.
        const pool = deck.slice(0, 12);
        const targets: Meld<SuitedCard>[] = [];
        for (const m of bestArrangement(pool).melds.slice(0, 2)) {
          targets.push({ kind: m.kind, cards: m.cards.slice(0, Math.max(3, m.cards.length - rng.int(0, 2))) });
        }
        return { cards: deck.slice(12, 12 + rng.int(1, 8)), targets };
      },
      ({ cards, targets }) => {
        const defense = bestLayoffs(cards, targets);
        expect(defense.points).toBe(oracleDefense(cards, targets));
        if (defense.layoffs.length > 0) withLayoffs += 1;
        // Everything is accounted for, and every extended target is still a meld.
        const ids = [
          ...defense.melds.flatMap((m) => m.cards),
          ...defense.deadwood,
          ...defense.layoffs.map((l) => l.card),
        ];
        expect(ids.map((c) => c.id).sort()).toEqual(cards.map((c) => c.id).sort());
        targets.forEach((t, i) => {
          const extended = [...t.cards, ...defense.layoffs.filter((l) => l.meld === i).map((l) => l.card)];
          expect(t.kind === 'set' ? isSet(extended) : isRun(extended)).toBe(true);
        });
      },
    );
    // The generator must actually exercise layoffs, not just empty answers.
    expect(withLayoffs).toBeGreaterThan(30);
  });
});
