import type { Rng } from '@joystyk/contracts';
export { assignIds, isOpaqueId, perturbHidden } from '../cards/ids.ts';
export type TileFace = { readonly a: number; readonly b: number };
export type Tile = TileFace & { readonly id: string };
export type HiddenTile = { readonly hidden: true };
export const HIDDEN_TILE: HiddenTile = Object.freeze({ hidden: true });
/** Canonical low/high order; identity is assigned only after a deal is shuffled. */
export const doubleSet = (n = 6): readonly TileFace[] => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 12) throw new RangeError('A double set needs 0 to 12.');
  return Object.freeze(
    Array.from({ length: ((n + 1) * (n + 2)) / 2 }, (_, index) => {
      let a = 0,
        i = index;
      while (i > n - a) {
        i -= n - a + 1;
        a++;
      }
      return Object.freeze({ a, b: a + i });
    }),
  );
};
export const pips = (tile: TileFace): number => tile.a + tile.b;
export const isDouble = (tile: TileFace): boolean => tile.a === tile.b;
export const matches = (tile: TileFace, value: number): boolean => tile.a === value || tile.b === value;
export const orient = (tile: Tile, value: number, end: 'left' | 'right'): Tile | null => {
  if (!matches(tile, value)) return null;
  const other = tile.a === value ? tile.b : tile.a;
  return { id: tile.id, a: end === 'left' ? other : value, b: end === 'left' ? value : other };
};
const numbers = [
  'blank',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
export const tileName = (tile: TileFace): string =>
  isDouble(tile) ? `double ${tile.a}` : `the ${tile.a === 0 ? 'blank' : tile.a}–${tile.b}`;
export const spokenTile = (tile: TileFace): string =>
  isDouble(tile) ? `double ${numbers[tile.a]}` : `${numbers[tile.a]}–${numbers[tile.b]}`;
export const tileKey = (tile: TileFace): string => `${Math.min(tile.a, tile.b)}-${Math.max(tile.a, tile.b)}`;
export type Gap = { readonly seat: number; readonly time: number; readonly ends: readonly number[] };
export type TileDraw = { readonly seat: number; readonly time: number; readonly count: number };
export type KnownPlay = { readonly seat: number; readonly time: number; readonly tile: Tile };
export type TimedSample = { readonly hands: readonly (readonly Tile[])[]; readonly stock: readonly Tile[] };
/** Match acquisition slots, including known past plays, so a later draw never inherits an older gap. */
export const sampleTimedTiles = (
  spec: {
    readonly unknown: readonly Tile[];
    readonly viewer: number;
    readonly counts: readonly number[];
    readonly initial: number;
    readonly stock: number;
    readonly gaps: readonly Gap[];
    readonly draws: readonly TileDraw[];
    readonly plays: readonly KnownPlay[];
  },
  rng: Rng,
): TimedSample | null => {
  const slots: { seat: number; born: number }[] = [];
  for (let seat = 0; seat < spec.counts.length; seat++)
    if (seat !== spec.viewer) {
      for (let k = 0; k < spec.initial; k++) slots.push({ seat, born: -1 });
      for (const draw of spec.draws.filter((d) => d.seat === seat))
        for (let k = 0; k < draw.count; k++) slots.push({ seat, born: draw.time });
    }
  for (let k = 0; k < spec.stock; k++) slots.push({ seat: -1, born: -1 });
  const past = spec.plays.filter((p) => p.seat !== spec.viewer);
  const tokens = [
    ...spec.unknown.map((tile) => ({ tile, death: Infinity, seat: null as number | null })),
    ...past.map((p) => ({ tile: p.tile, death: p.time, seat: p.seat })),
  ];
  if (tokens.length !== slots.length) return null;
  const candidates = tokens.map((token) =>
    rng.shuffle(
      slots
        .map((_, i) => i)
        .filter((i) => {
          const slot = slots[i]!;
          if ((token.seat !== null && slot.seat !== token.seat) || slot.born > token.death) return false;
          if (slot.seat === -1) return token.seat === null;
          return !spec.gaps.some(
            (gap) =>
              gap.seat === slot.seat &&
              gap.time > slot.born &&
              gap.time <= token.death &&
              gap.ends.some((n) => matches(token.tile, n)),
          );
        }),
    ),
  );
  const occupants = slots.map(() => -1);
  const put = (index: number, seen: Set<number>): boolean => {
    for (const slot of candidates[index]!) {
      if (seen.has(slot)) continue;
      seen.add(slot);
      const old = occupants[slot]!;
      if (old === -1 || put(old, seen)) {
        occupants[slot] = index;
        return true;
      }
    }
    return false;
  };
  for (const index of rng
    .shuffle(tokens.map((_, i) => i))
    .sort((a, b) => candidates[a]!.length - candidates[b]!.length))
    if (!put(index, new Set())) return null;
  const hands: Tile[][] = spec.counts.map(() => []),
    stock: Tile[] = [];
  slots.forEach((slot, i) => {
    const token = tokens[occupants[i]!]!;
    if (token.death !== Infinity) return;
    if (slot.seat === -1) stock.push(token.tile);
    else hands[slot.seat]!.push(token.tile);
  });
  if (hands.some((hand, seat) => seat !== spec.viewer && hand.length !== spec.counts[seat])) return null;
  return { hands, stock: rng.shuffle(stock) };
};
