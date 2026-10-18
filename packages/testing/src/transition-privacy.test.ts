import { defineEngine, err, gameError, ok, type Rng, type SeatId, type Validator } from '@joystyk/contracts';
import { expect, it } from 'vitest';
import { checkById, checkEngine, formatReport } from './index.ts';

type State = { cards: number[]; dealt: boolean };
type Command = { type: 'deal' };
type View = { dealt: boolean; card: number | null };
type Event = { card: number };
const any = <T>(): Validator<T> => ({
  '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value: value as T }) },
});

// Without transition knowledge every recipient changes. With it, change only cards that
// stay hidden from this recipient. The spectator must never receive a private event.
const perturb = (state: State, viewer: SeatId | null, _rng: Rng, context?: { states: readonly State[] }): State => {
  if ((!state.dealt && context === undefined) || viewer === null)
    return { ...state, cards: [state.cards[1]!, state.cards[2]!, state.cards[0]!] };
  const hidden = state.cards.filter((_, seat) => seat !== viewer).reverse();
  return { ...state, cards: state.cards.map((card, seat) => (seat === viewer ? card : hidden.shift()!)) };
};

it.each([false, true])('checks recipient privacy when every hand changes (leaky=%s)', async (leaky) => {
  const engine = defineEngine<State, Command, View, Event, Record<string, never>>({
    rulesVersion: 1,
    schemas: { config: any(), state: any(), command: any(), view: any(), event: any() },
    init: () => ok({ cards: [10, 20, 30], dealt: false }),
    apply: (state, input) =>
      state.dealt || input.kind !== 'command' || input.seat !== 0
        ? err(gameError('Illegal', 'No decision.'))
        : ok({ state: { ...state, dealt: true }, beats: [{ event: { card: state.cards[0]! } }] }),
    pending: (state) => (state.dealt ? [] : [0]),
    viewFor: (state, viewer) => ({
      dealt: state.dealt,
      card: state.dealt && viewer !== null ? state.cards[viewer]! : null,
    }),
    eventFor: (event, viewer) => (viewer === 0 || (leaky && viewer === 1) ? event : null),
    outcome: (state) =>
      state.dealt
        ? { result: 'draw', placements: state.cards.map((_, seat) => ({ seat, place: 1 })), summary: 'Dealt.' }
        : null,
  });
  const report = await checkEngine(engine, {
    configs: [{}],
    seatCounts: [3],
    games: 1,
    maxSteps: 2,
    commands: () => [{ type: 'deal' }],
    perturbHidden: (state, viewer, rng, ...extra: unknown[]) => {
      if (extra.length !== 0) throw Error('legacy helpers take only three arguments');
      return perturb(state, viewer, rng);
    },
    perturbTransition: perturb,
    platformInputs: { resign: false },
  });
  const privacy = checkById(report, 'no-leak');
  expect(privacy.status, formatReport(report)).toBe(leaky ? 'failed' : 'passed');
  if (leaky)
    expect(privacy.failures.some((failure) => failure.message.includes('eventFor(event, 1) differs'))).toBe(true);
});
