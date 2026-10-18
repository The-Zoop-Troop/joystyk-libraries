// Sealed Bids: a simultaneous-move game for two to four players. Every round, all players
// secretly bid 1, 2 or 3 at the same time. When the last bid arrives, the bids are revealed
// and each unique bid scores its value. After the configured rounds the highest score wins.
// It exercises several pending seats at once, hidden choices, redacted events and a
// decisionKey that ignores who has already bid, so simultaneous bids are never stale.

import { defineEngine, err, gameError, ok, type SeatId } from '@joystyk/contracts';
import { guardSchema } from '../builders.ts';
import type { EngineConformanceOptions } from '../engine-conformance.ts';
import { isArrayOf, isInt, isRecord, isSeat, isSeatOrNull, rankPlaces } from './guards.ts';

export type SealedBidsState = {
  readonly round: number;
  readonly rounds: number;
  /** This round's bids; null until the seat bids. Hidden from everyone else. */
  readonly bids: readonly (number | null)[];
  readonly scores: readonly number[];
  /** Revealed bids of finished rounds. */
  readonly history: readonly (readonly number[])[];
  readonly resigned: SeatId | null;
};
export type SealedBidsCommand = { readonly type: 'bid'; readonly amount: number };
export type SealedBidsEvent =
  | { readonly type: 'bid'; readonly seat: SeatId; readonly amount: number | null }
  | { readonly type: 'revealed'; readonly bids: readonly number[] }
  | { readonly type: 'resigned'; readonly seat: SeatId };
export type SealedBidsView = {
  readonly round: number;
  readonly rounds: number;
  readonly myBid: number | null;
  readonly submitted: readonly boolean[];
  readonly scores: readonly number[];
  readonly history: readonly (readonly number[])[];
  readonly resigned: SeatId | null;
};
export type SealedBidsConfig = { readonly rounds: number };

const isBid = (v: unknown): v is number => isInt(v, 1, 3);
const isScores = (v: unknown): v is number[] => isArrayOf(v, (n): n is number => isInt(n, 0));
const isHistory = (v: unknown): v is number[][] => isArrayOf(v, (r): r is number[] => isArrayOf(r, isBid));
const isState = (v: unknown): v is SealedBidsState =>
  isRecord(v) &&
  isInt(v['round'], 1) &&
  isInt(v['rounds'], 1) &&
  isArrayOf(v['bids'], (b): b is number | null => b === null || isBid(b)) &&
  isScores(v['scores']) &&
  isHistory(v['history']) &&
  isSeatOrNull(v['resigned']);
const isView = (v: unknown): v is SealedBidsView =>
  isRecord(v) &&
  isInt(v['round'], 1) &&
  isInt(v['rounds'], 1) &&
  (v['myBid'] === null || isBid(v['myBid'])) &&
  isArrayOf(v['submitted'], (b): b is boolean => typeof b === 'boolean') &&
  isScores(v['scores']) &&
  isHistory(v['history']) &&
  isSeatOrNull(v['resigned']);
const isCommand = (v: unknown): v is SealedBidsCommand => isRecord(v) && v['type'] === 'bid' && isInt(v['amount']);
const isEvent = (v: unknown): v is SealedBidsEvent =>
  isRecord(v) &&
  ((v['type'] === 'bid' && isSeat(v['seat']) && (v['amount'] === null || isBid(v['amount']))) ||
    (v['type'] === 'revealed' && isArrayOf(v['bids'], isBid)) ||
    (v['type'] === 'resigned' && isSeat(v['seat'])));
const isConfig = (v: unknown): v is SealedBidsConfig => isRecord(v) && isInt(v['rounds'], 1, 20);

const over = (s: SealedBidsState): boolean => s.resigned !== null || s.round > s.rounds;

export const sealedBids = defineEngine<
  SealedBidsState,
  SealedBidsCommand,
  SealedBidsView,
  SealedBidsEvent,
  SealedBidsConfig
>({
  rulesVersion: 1,
  schemas: {
    config: guardSchema(isConfig, 'Expected { rounds } from 1 to 20.'),
    command: guardSchema(isCommand, 'Expected { type: "bid", amount }.'),
    state: guardSchema(isState, 'Not a Sealed Bids state.'),
    view: guardSchema(isView, 'Not a Sealed Bids view.'),
    event: guardSchema(isEvent, 'Not a Sealed Bids event.'),
  },
  init: (config: SealedBidsConfig, seats) =>
    seats.length < 2 || seats.length > 4
      ? err(gameError('Seats', 'Sealed Bids needs two to four players.'))
      : ok({
          round: 1,
          rounds: config.rounds,
          bids: seats.map(() => null),
          scores: seats.map(() => 0),
          history: [],
          resigned: null,
        }),
  apply: (state: SealedBidsState, input) => {
    if (over(state)) return err(gameError('GameOver', 'The game is over.'));
    if (input.kind === 'resign') {
      if (state.bids[input.seat] === undefined) return err(gameError('NoSuchSeat', 'There is no such seat.'));
      return ok({
        state: { ...state, resigned: input.seat },
        beats: [{ event: { type: 'resigned', seat: input.seat } }],
      });
    }
    if (input.kind !== 'command')
      return err(gameError('Unsupported', 'Sealed Bids has no clocks, seat changes or jobs.'));
    if (state.bids[input.seat] !== null) return err(gameError('NotYourTurn', 'You have already bid this round.'));
    const { amount } = input.command;
    if (!isBid(amount)) return err(gameError('IllegalBid', 'Bid 1, 2 or 3.'));
    const bids = state.bids.map((b, s) => (s === input.seat ? amount : b));
    const placed = { event: { type: 'bid', seat: input.seat, amount } } as const;
    if (bids.some((b) => b === null)) return ok({ state: { ...state, bids }, beats: [placed] });
    const revealed = bids as number[];
    const scores = state.scores.map((score, s) => {
      const bid = revealed[s] ?? 0;
      return revealed.filter((b) => b === bid).length === 1 ? score + bid : score;
    });
    const next: SealedBidsState = {
      ...state,
      round: state.round + 1,
      bids: bids.map(() => null),
      scores,
      history: [...state.history, revealed],
    };
    return ok({ state: next, beats: [placed, { event: { type: 'revealed', bids: revealed } }] });
  },
  pending: (state) => (over(state) ? [] : state.bids.flatMap((b, s) => (b === null ? [s] : []))),
  viewFor: (state, viewer): SealedBidsView => ({
    round: state.round,
    rounds: state.rounds,
    myBid: viewer === null ? null : (state.bids[viewer] ?? null),
    submitted: state.bids.map((b) => b !== null),
    scores: state.scores,
    history: state.history,
    resigned: state.resigned,
  }),
  eventFor: (event, viewer) => (event.type === 'bid' && event.seat !== viewer ? { ...event, amount: null } : event),
  outcome: (state) =>
    over(state)
      ? {
          result: 'won',
          placements: rankPlaces(state.scores, state.resigned),
          summary: state.resigned === null ? `After ${state.rounds} rounds.` : `Seat ${state.resigned + 1} resigned.`,
        }
      : null,
  // Who has already bid doesn't change anyone else's decision.
  decisionKey: (state, seat) => ({
    round: state.round,
    myBid: state.bids[seat] ?? null,
    scores: state.scores,
    history: state.history,
    resigned: state.resigned,
  }),
});

/** Re-draws every bid `viewer` can't see. */
export const perturbSealedBids = (
  state: SealedBidsState,
  viewer: SeatId | null,
  rng: { int(min: number, max: number): number },
): SealedBidsState => ({
  ...state,
  bids: state.bids.map((b, s) => (b === null || s === viewer ? b : rng.int(1, 4))),
});

/** Conformance options for the Sealed Bids fixture. */
export const sealedBidsConformance: EngineConformanceOptions<SealedBidsState, SealedBidsCommand, SealedBidsConfig> = {
  name: 'sealed-bids',
  configs: [{ rounds: 4 }],
  seatCounts: [2, 3, 4],
  games: 8,
  commands: () => [0, 1, 2, 3, 4].map((amount) => ({ type: 'bid', amount })),
  perturbHidden: perturbSealedBids,
  invariants: (s) => (s.history.length === s.round - 1 ? true : 'history and round disagree'),
};
