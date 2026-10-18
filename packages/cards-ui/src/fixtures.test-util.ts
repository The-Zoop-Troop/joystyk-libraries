// A small table for the controller and element tests: a stock, a waste, two foundations and
// three columns, in the shape a Klondike table has.
import type { FaceCard, PileSpec, TableLayout } from './layout.ts';

const up = (id: string, rank: FaceCard['rank'], suit: FaceCard['suit']): FaceCard => ({ id, rank, suit });
const down = { hidden: true } as const;

export const testLayout = (version = 1, overrides: Partial<Record<string, Partial<PileSpec>>> = {}): TableLayout => {
  const pile = (spec: PileSpec): PileSpec => ({ ...spec, ...overrides[spec.id] });
  return {
    label: 'Test table',
    columns: 5,
    keys: ['f'],
    version,
    hint: null,
    regions: [
      {
        id: 'top',
        label: 'Stock and waste',
        place: 'top-start',
        piles: [
          pile({
            id: 'stock',
            label: 'Stock: 10 cards.',
            kind: 'stock',
            fan: 'stack',
            cards: [down, down],
            pickable: 0,
            action: true,
          }),
          pile({
            id: 'waste',
            label: 'Waste: 7 of clubs on top.',
            kind: 'waste',
            fan: 'right',
            cards: [up('7C', 7, 'C')],
            pickable: 1,
            targets: [['c2']],
          }),
        ],
      },
      {
        id: 'home',
        label: 'Foundations',
        place: 'top-end',
        piles: [
          pile({
            id: 'f0',
            label: 'Foundation 1: empty.',
            kind: 'foundation',
            fan: 'stack',
            cards: [],
            pickable: 0,
            mark: 'A',
          }),
          pile({
            id: 'f1',
            label: 'Foundation 2: empty.',
            kind: 'foundation',
            fan: 'stack',
            cards: [],
            pickable: 0,
            mark: 'A',
          }),
        ],
      },
      {
        id: 'tableau',
        label: 'Tableau',
        place: 'main',
        piles: [
          pile({
            id: 'c1',
            key: '1',
            label: 'Column 1: ace of spades.',
            kind: 'column',
            fan: 'down',
            cards: [up('AS', 1, 'S')],
            pickable: 1,
            targets: [['f0', 'f1']],
          }),
          pile({
            id: 'c2',
            key: '2',
            label: 'Column 2: 1 face-down card, then 9 of spades, 8 of hearts.',
            kind: 'column',
            fan: 'down',
            cards: [down, up('9S', 9, 'S'), up('8H', 8, 'H')],
            pickable: 2,
            limit: 'The face-down card stays.',
            targets: [['c3'], ['c3']],
          }),
          pile({
            id: 'c3',
            key: '3',
            label: 'Column 3: 10 of hearts.',
            kind: 'column',
            fan: 'down',
            cards: [up('TH', 10, 'H')],
            pickable: 1,
            targets: [[]],
          }),
        ],
      },
    ],
  };
};
