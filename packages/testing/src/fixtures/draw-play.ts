// Draw and Play: a hidden-hand card game for two to four players. Each player is dealt three
// cards from a shuffled 26-card deck (spades and hearts). On your turn, play a card face up
// (you score its rank) or draw one (up to five in hand). The game ends when every card has
// been played; the highest score wins. Other hands and the deck are hidden, so this fixture
// exercises the no-leak check, opaque card ids and redacted events.

import { defineEngine, err, gameError, ok, type SeatId } from '@joystyk/contracts';
import {
  assignIds,
  isOpaqueId,
  isRank,
  isSuit,
  perturbHidden,
  nextActiveSeat,
  standardDeck,
  type SuitedCard,
  type SuitedFace,
} from '@joystyk/kit';
import { guardSchema } from '../builders.ts';
import type { EngineConformanceOptions } from '../engine-conformance.ts';
import { isArrayOf, isInt, isRecord, isSeat, isSeatOrNull, rankPlaces } from './guards.ts';

export type DrawPlayCard = SuitedCard;
export type DrawPlayState = {
  readonly hands: readonly (readonly DrawPlayCard[])[];
  readonly deck: readonly DrawPlayCard[];
  readonly table: readonly { readonly seat: SeatId; readonly card: DrawPlayCard }[];
  readonly turn: SeatId;
  readonly scores: readonly number[];
  readonly resigned: SeatId | null;
  readonly over: boolean;
};
export type DrawPlayCommand = { readonly type: 'play'; readonly cardId: string } | { readonly type: 'draw' };
export type DrawPlayEvent =
  | { readonly type: 'drew'; readonly seat: SeatId; readonly card: DrawPlayCard | null }
  | { readonly type: 'played'; readonly seat: SeatId; readonly card: DrawPlayCard }
  | { readonly type: 'resigned'; readonly seat: SeatId };
export type DrawPlayView = {
  /** Your own cards; null for every other hand and for a spectator. */
  readonly hand: readonly DrawPlayCard[] | null;
  readonly handSizes: readonly number[];
  readonly deckSize: number;
  readonly table: DrawPlayState['table'];
  readonly turn: SeatId;
  readonly scores: readonly number[];
  readonly resigned: SeatId | null;
  readonly over: boolean;
};
export type DrawPlayConfig = { readonly handSize: number };

export const DRAW_PLAY_CARDS = 26;
const MAX_HAND = 5;

const isCard = (v: unknown): v is DrawPlayCard =>
  isRecord(v) && isRank(v['rank']) && isSuit(v['suit']) && isOpaqueId(v['id']);
const isTable = (v: unknown): v is DrawPlayState['table'] =>
  isArrayOf(v, (t): t is { seat: number; card: DrawPlayCard } => isRecord(t) && isSeat(t['seat']) && isCard(t['card']));
const isScores = (v: unknown): v is number[] => isArrayOf(v, (n): n is number => isInt(n, 0));
const isState = (v: unknown): v is DrawPlayState =>
  isRecord(v) &&
  isArrayOf(v['hands'], (h): h is DrawPlayCard[] => isArrayOf(h, isCard)) &&
  isArrayOf(v['deck'], isCard) &&
  isTable(v['table']) &&
  isSeat(v['turn']) &&
  isScores(v['scores']) &&
  isSeatOrNull(v['resigned']) &&
  typeof v['over'] === 'boolean';
const isView = (v: unknown): v is DrawPlayView =>
  isRecord(v) &&
  (v['hand'] === null || isArrayOf(v['hand'], isCard)) &&
  isArrayOf(v['handSizes'], (n): n is number => isInt(n, 0)) &&
  isInt(v['deckSize'], 0) &&
  isTable(v['table']) &&
  isSeat(v['turn']) &&
  isScores(v['scores']) &&
  isSeatOrNull(v['resigned']) &&
  typeof v['over'] === 'boolean';
const isCommand = (v: unknown): v is DrawPlayCommand =>
  isRecord(v) && ((v['type'] === 'play' && typeof v['cardId'] === 'string') || v['type'] === 'draw');
const isEvent = (v: unknown): v is DrawPlayEvent =>
  isRecord(v) &&
  isSeat(v['seat']) &&
  ((v['type'] === 'drew' && (v['card'] === null || isCard(v['card']))) ||
    (v['type'] === 'played' && isCard(v['card'])) ||
    v['type'] === 'resigned');
const isConfig = (v: unknown): v is DrawPlayConfig => isRecord(v) && isInt(v['handSize'], 1, 4);

const canMove = (state: DrawPlayState, seat: SeatId): boolean =>
  (state.hands[seat]?.length ?? 0) > 0 || state.deck.length > 0;

const finish = (state: DrawPlayState, seat: SeatId): DrawPlayState => {
  const turn = nextActiveSeat(seat, state.hands.length, (s) => canMove(state, s));
  return turn === null ? { ...state, over: true } : { ...state, turn };
};

export const drawPlay = defineEngine<DrawPlayState, DrawPlayCommand, DrawPlayView, DrawPlayEvent, DrawPlayConfig>({
  rulesVersion: 1,
  schemas: {
    config: guardSchema(isConfig, 'Expected { handSize } from 1 to 4.'),
    command: guardSchema(isCommand, 'Not a Draw and Play command.'),
    state: guardSchema(isState, 'Not a Draw and Play state.'),
    view: guardSchema(isView, 'Not a Draw and Play view.'),
    event: guardSchema(isEvent, 'Not a Draw and Play event.'),
  },
  init: (config: DrawPlayConfig, seats, rng) => {
    if (seats.length < 2 || seats.length > 4)
      return err(gameError('Seats', 'Draw and Play needs two to four players.'));
    const faces = rng.shuffle(standardDeck({ suits: ['S', 'H'] })) as SuitedFace[];
    const cards = assignIds(faces, rng);
    const hands = seats.map((_, s) => cards.slice(s * config.handSize, (s + 1) * config.handSize));
    const state: DrawPlayState = {
      hands,
      deck: cards.slice(seats.length * config.handSize),
      table: [],
      turn: rng.int(0, seats.length),
      scores: seats.map(() => 0),
      resigned: null,
      over: false,
    };
    return ok(state);
  },
  apply: (state: DrawPlayState, input) => {
    if (state.over) return err(gameError('GameOver', 'The game is over.'));
    if (input.kind === 'resign') {
      if (state.hands[input.seat] === undefined) return err(gameError('NoSuchSeat', 'There is no such seat.'));
      return ok({
        state: { ...state, resigned: input.seat, over: true },
        beats: [{ event: { type: 'resigned', seat: input.seat } }],
      });
    }
    if (input.kind !== 'command')
      return err(gameError('Unsupported', 'Draw and Play has no clocks, seat changes or jobs.'));
    if (input.seat !== state.turn) return err(gameError('NotYourTurn', "It's not your turn."));
    const hand = state.hands[input.seat] ?? [];
    const command = input.command;
    if (command.type === 'draw') {
      const [card, ...deck] = state.deck;
      if (card === undefined) return err(gameError('DeckEmpty', 'The deck is empty.'));
      if (hand.length >= MAX_HAND) return err(gameError('HandFull', `You can hold at most ${MAX_HAND} cards.`));
      const hands = state.hands.map((h, s) => (s === input.seat ? [...h, card] : h));
      const next = finish({ ...state, hands, deck }, input.seat);
      return ok({ state: next, beats: [{ event: { type: 'drew', seat: input.seat, card } }] });
    }
    const card = hand.find((c) => c.id === command.cardId);
    if (card === undefined) return err(gameError('NotInHand', "That card isn't in your hand."));
    const hands = state.hands.map((h, s) => (s === input.seat ? h.filter((c) => c.id !== card.id) : h));
    const scores = state.scores.map((score, s) => (s === input.seat ? score + card.rank : score));
    const next = finish({ ...state, hands, scores, table: [...state.table, { seat: input.seat, card }] }, input.seat);
    return ok({ state: next, beats: [{ event: { type: 'played', seat: input.seat, card } }] });
  },
  pending: (state) => (state.over ? [] : [state.turn]),
  viewFor: (state, viewer): DrawPlayView => ({
    hand: viewer === null ? null : (state.hands[viewer] ?? null),
    handSizes: state.hands.map((h) => h.length),
    deckSize: state.deck.length,
    table: state.table,
    turn: state.turn,
    scores: state.scores,
    resigned: state.resigned,
    over: state.over,
  }),
  eventFor: (event, viewer) => (event.type === 'drew' && event.seat !== viewer ? { ...event, card: null } : event),
  outcome: (state) =>
    state.over
      ? {
          result: 'won',
          placements: rankPlaces(state.scores, state.resigned),
          summary: state.resigned === null ? 'Every card has been played.' : `Seat ${state.resigned + 1} resigned.`,
        }
      : null,
  ai: {
    levels: ['easy'],
    choose: (view) => {
      const best = [...(view.hand ?? [])].sort((a, b) => b.rank - a.rank)[0];
      return best === undefined ? { type: 'draw' } : { type: 'play', cardId: best.id };
    },
  },
});

/** Shuffles everything `viewer` can't see: the deck and every other hand. */
export const perturbDrawPlay = (
  state: DrawPlayState,
  viewer: SeatId | null,
  rng: Parameters<typeof perturbHidden>[2],
): DrawPlayState => {
  const zones: Record<string, readonly DrawPlayCard[]> = { deck: state.deck };
  state.hands.forEach((hand, s) => {
    zones[`hand${s}`] = hand;
  });
  const out = perturbHidden(zones, (zone) => zone === `hand${viewer}`, rng);
  return { ...state, deck: out['deck'] ?? [], hands: state.hands.map((_, s) => out[`hand${s}`] ?? []) };
};

const cardsOf = (s: DrawPlayState): DrawPlayCard[] => [...s.hands.flat(), ...s.deck, ...s.table.map((t) => t.card)];

/** Conformance options for the Draw and Play fixture. */
export const drawPlayConformance: EngineConformanceOptions<DrawPlayState, DrawPlayCommand, DrawPlayConfig> = {
  name: 'draw-play',
  configs: [{ handSize: 3 }],
  seatCounts: [2, 3, 4],
  games: 8,
  commands: (state, seat) => [
    { type: 'draw' },
    ...(state.hands[seat] ?? []).map((c): DrawPlayCommand => ({ type: 'play', cardId: c.id })),
  ],
  perturbHidden: perturbDrawPlay,
  invariants: (s) => {
    const cards = cardsOf(s);
    if (cards.length !== DRAW_PLAY_CARDS) return `${cards.length} cards in play, not ${DRAW_PLAY_CARDS}`;
    if (new Set(cards.map((c) => c.id)).size !== cards.length) return 'two cards share an id';
    const total = s.table.reduce((sum, t) => sum + t.card.rank, 0);
    if (s.scores.reduce((a, b) => a + b, 0) !== total) return 'the scores disagree with the table';
    return true;
  },
};
