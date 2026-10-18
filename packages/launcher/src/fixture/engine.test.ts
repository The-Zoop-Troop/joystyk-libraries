// The Tally fixture's rules, so launcher tests can trust what it reports.
import type { SeatInfo } from '@joystyk/contracts';
import { createRng } from '@joystyk/kit/rng';
import { describe, expect, it } from 'vitest';
import { tallyEngine, type TallyState } from './engine.ts';

const seats: SeatInfo[] = [
  { id: 0, name: 'Ada', controller: 'human' },
  { id: 1, name: 'Computer', controller: 'ai', aiLevel: 'hard' },
];

const start = (config = {}, who = seats): TallyState => {
  const state = tallyEngine.init(config, who, createRng('tally'));
  if (!state.ok) throw new Error(state.error.message);
  return state.value;
};

const play = (state: TallyState, seat: number, amount: 1 | 2): TallyState => {
  const next = tallyEngine.apply(state, { kind: 'command', seat, command: { type: 'add', amount } }, createRng('x'));
  if (!next.ok) throw new Error(next.error.message);
  return next.value.state;
};

describe('Tally', () => {
  it('races to the target; the outcome speaks for the human seat in vs-AI play', () => {
    let state = start();
    for (const [seat, amount] of [
      [0, 1],
      [1, 2],
      [0, 1],
      [1, 2],
      [0, 1],
      [1, 2],
    ] as const)
      state = play(state, seat, amount);
    expect(tallyEngine.outcome(state)).toMatchObject({ result: 'lost', summary: 'Computer reached 5 first.' });
    expect(tallyEngine.pending(state)).toEqual([]);
  });

  it("completes a solo game and hides other seats' secrets", () => {
    let state = start({}, [seats[0] as SeatInfo]);
    for (const amount of [2, 2, 1] as const) state = play(state, 0, amount);
    expect(tallyEngine.outcome(state)).toMatchObject({ result: 'completed', summary: 'Reached 5 in 3 moves.' });
    const two = start();
    expect(tallyEngine.viewFor(two, null).secret).toBeNull();
    expect(tallyEngine.viewFor(two, 1).secret).toBe(two.secrets[1]);
  });

  it('refuses moves out of turn, flags hints as assistance and swaps the first mover in a rematch', () => {
    const state = start();
    expect(
      tallyEngine.apply(state, { kind: 'command', seat: 1, command: { type: 'add', amount: 1 } }, createRng('x')).ok,
    ).toBe(false);
    const hint = tallyEngine.apply(state, { kind: 'command', seat: 0, command: { type: 'hint' } }, createRng('x'));
    expect(hint.ok && hint.value.assist).toBe('hint');
    expect(tallyEngine.rematch?.({}, state)).toEqual({ firstSeat: 1 });
    expect(start({ firstSeat: 1 }).turn).toBe(1);
    expect(tallyEngine.rematch?.({ firstSeat: 1 }, start({ firstSeat: 1 }))).toEqual({ firstSeat: 0 });
    expect(tallyEngine.ai?.choose(tallyEngine.viewFor(state, 1), 1, 'easy', createRng('x'))).toEqual({
      type: 'add',
      amount: 1,
    });
  });
});
