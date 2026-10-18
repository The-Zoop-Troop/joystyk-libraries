import { restoreRng, seedState } from '@joystyk/kit';
import { describe, expect, it } from 'vitest';
import { seed, testRng } from './fakes.test-util.ts';
import { advanceAi, aiDecisionSeed, aiRestore, deriveAiSeed } from './rngs.ts';

const stream = seedState('ai');

describe('the AI stream', () => {
  it('derives an SFC32 seed from any game state without moving the game’s stream', () => {
    const game = seed(42);
    const derived = deriveAiSeed(game, testRng);
    expect(derived.algorithm).toBe('sfc32');
    expect(deriveAiSeed(game, testRng)).toEqual(derived);
    expect(game).toEqual(seed(42));
  });

  it('gives each seat a different child, and the same child again until a move is accepted', () => {
    const children = [0, 1, 2].map((seat) => aiDecisionSeed(stream, seat, restoreRng));
    expect(new Set(children.map((child) => JSON.stringify(child))).size).toBe(3);
    expect(aiDecisionSeed(stream, 1, restoreRng)).toEqual(children[1]);
  });

  it('moves past every child the old state handed out', () => {
    const before = [0, 1, 2].map((seat) => JSON.stringify(aiDecisionSeed(stream, seat, restoreRng)));
    const next = advanceAi(stream, 3, restoreRng);
    const after = [0, 1, 2].map((seat) => JSON.stringify(aiDecisionSeed(next, seat, restoreRng)));
    expect(after.some((child) => before.includes(child))).toBe(false);
  });

  it('restores SFC32 states with the kit and anything else with the game’s factory', () => {
    const restore = aiRestore(testRng);
    expect(restore(stream).save()).toEqual(stream);
    expect(restore(seed(5)).save()).toEqual(seed(5));
  });
});
