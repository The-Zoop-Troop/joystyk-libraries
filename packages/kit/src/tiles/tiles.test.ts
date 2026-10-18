import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.ts';
import {
  assignIds,
  doubleSet,
  isDouble,
  matches,
  orient,
  pips,
  sampleTimedTiles,
  spokenTile,
  tileKey,
  tileName,
} from './index.ts';
const tile = (a: number, b: number, id = `${a}-${b}`) => ({ a, b, id });
describe('shared tiles', () => {
  it('freezes each canonical double-n set and assigns opaque IDs after shuffling', () => {
    for (let n = 0; n <= 12; n++) {
      const set = doubleSet(n);
      expect(set).toHaveLength(((n + 1) * (n + 2)) / 2);
      expect(new Set(set.map(tileKey)).size).toBe(set.length);
      expect(Object.isFrozen(set)).toBe(true);
      expect(set.every(Object.isFrozen)).toBe(true);
    }
    const rng = createRng('tiles'),
      a = assignIds(rng.shuffle(doubleSet()), rng),
      b = assignIds(rng.shuffle(doubleSet()), rng);
    expect(new Set(a.map((t) => t.id)).size).toBe(28);
    expect(a.every((t) => /^[0-9a-hjkmnp-tv-z]{5}$/.test(t.id))).toBe(true);
    expect(a.map((t) => t.id)).not.toEqual(b.map((t) => t.id));
  });
  it('names, counts and orients either half without mutating faces', () => {
    const t = tile(3, 6);
    expect(pips(t)).toBe(9);
    expect(matches(t, 6)).toBe(true);
    expect(orient(t, 6, 'left')).toEqual(tile(3, 6));
    expect(orient(t, 6, 'right')).toEqual(tile(6, 3, '3-6'));
    expect(orient(t, 4, 'left')).toBeNull();
    expect(isDouble(tile(5, 5))).toBe(true);
    expect(tileName(tile(0, 3))).toBe('the blank–3');
    expect(spokenTile(tile(4, 6))).toBe('four–six');
  });
  it('applies gaps only to tiles held then, allowing later draws to fill them', () => {
    for (let n = 0; n < 100; n++) {
      const sampled = sampleTimedTiles(
        {
          unknown: [tile(1, 1), tile(2, 2)],
          viewer: 0,
          counts: [0, 2],
          initial: 1,
          stock: 0,
          gaps: [{ seat: 1, time: 1, ends: [1] }],
          draws: [{ seat: 1, time: 2, count: 1 }],
          plays: [],
        },
        createRng(`gap-${n}`),
      );
      expect(sampled?.hands[1]?.map(tileKey).sort()).toEqual(['1-1', '2-2']);
    }
    expect(
      sampleTimedTiles(
        {
          unknown: [tile(1, 1)],
          viewer: 0,
          counts: [0, 1],
          initial: 1,
          stock: 0,
          gaps: [{ seat: 1, time: 1, ends: [1] }],
          draws: [],
          plays: [],
        },
        createRng('impossible'),
      ),
    ).toBeNull();
  });
  it('fits historical public plays to acquisition slots before placing current tiles', () => {
    const spec = {
      unknown: [tile(1, 2)],
      viewer: 0,
      counts: [0, 1],
      initial: 1,
      stock: 0,
      gaps: [{ seat: 1, time: 1, ends: [1] }],
      draws: [{ seat: 1, time: 2, count: 1 }],
      plays: [{ seat: 1, time: 3, tile: tile(2, 3) }],
    };
    expect(sampleTimedTiles(spec, createRng('past'))?.hands[1]).toEqual([tile(1, 2)]);
    expect(
      sampleTimedTiles({ ...spec, plays: [{ seat: 1, time: 0, tile: tile(2, 3) }] }, createRng('past-early'))?.hands[1],
    ).toEqual([tile(1, 2)]);
  });
});
