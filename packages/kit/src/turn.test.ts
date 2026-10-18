import { describe, expect, it } from 'vitest';
import { nextActiveSeat, seatAfter, seatsFrom } from './turn.ts';

describe('turn order', () => {
  it('steps around the table in both directions', () => {
    expect(seatAfter(3, 4)).toBe(0);
    expect(seatAfter(0, 4, -1)).toBe(3);
    expect(seatAfter(1, 4, 6)).toBe(3);
    expect(() => seatAfter(4, 4)).toThrow(RangeError);
  });

  it('lists every seat once from a start', () => {
    expect(seatsFrom(2, 4)).toEqual([2, 3, 0, 1]);
  });

  it('skips inactive seats and returns to a lone player', () => {
    const folded = new Set([1, 2]);
    expect(nextActiveSeat(0, 4, (s) => !folded.has(s))).toBe(3);
    expect(nextActiveSeat(3, 4, (s) => !folded.has(s))).toBe(0);
    expect(nextActiveSeat(0, 4, (s) => s === 0)).toBe(0);
    expect(nextActiveSeat(0, 4, () => false)).toBe(null);
  });
});
