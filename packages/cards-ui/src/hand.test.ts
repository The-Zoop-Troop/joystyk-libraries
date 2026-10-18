// The hand widget's controller without a DOM: the roving focus, play and choose modes, and
// how the focus follows the hand when a card leaves it (hearts.md, "Keyboard and pointer controls").
import { describe, expect, it } from 'vitest';
import {
  handCardLabel,
  handStep,
  initialHand,
  syncHand,
  type HandCard,
  type HandLayout,
  type HandMsg,
  type HandOut,
  type HandState,
} from './hand.ts';

const card = (
  id: string,
  rank: NonNullable<HandCard['rank']>,
  suit: NonNullable<HandCard['suit']>,
  playable = true,
  extra: Partial<Pick<HandCard, 'chosen' | 'note' | 'playable'>> = {},
): HandCard => ({ id, rank, suit, playable, ...extra });

const cards: readonly HandCard[] = [card('a', 2, 'C'), card('b', 12, 'S', false), card('c', 9, 'H'), card('d', 1, 'D')];
const playing: HandLayout = { label: 'Your hand', cards, mode: 'play' };
const choosing: HandLayout = { label: 'Your hand', cards, mode: 'choose' };

const key = (k: string): HandMsg => ({ _tag: 'Key', key: k });

const run = (msgs: readonly HandMsg[], layout: HandLayout = playing, start: HandState = initialHand(layout)) => {
  let state = start;
  const outs: HandOut[] = [];
  const focus: string[] = [];
  for (const m of msgs) {
    const step = handStep(state, layout, m);
    state = step.state;
    outs.push(...step.outs);
    if (step.focus !== null) focus.push(step.focus);
  }
  return { state, outs, focus };
};

describe('the hand controller', () => {
  it('moves the roving focus with Left, Right, Home and End, stopping at the ends', () => {
    const { state, focus } = run([
      key('ArrowRight'),
      key('ArrowRight'),
      key('ArrowLeft'),
      key('End'),
      key('ArrowRight'),
      key('Home'),
      key('ArrowLeft'),
    ]);
    expect(focus).toEqual(['b', 'c', 'b', 'd', 'd', 'a', 'a']);
    expect(state.focus).toBe(0);
  });

  it('plays the focused card with Enter or Space, or a tap, and refuses one that is not playable', () => {
    expect(run([key('Enter')]).outs).toEqual([{ _tag: 'Play', id: 'a' }]);
    expect(run([key('End'), key(' ')]).outs).toEqual([{ _tag: 'Play', id: 'd' }]);
    expect(run([key('ArrowRight'), key('Enter')]).outs).toEqual([{ _tag: 'Refused', id: 'b' }]);
    const tapped = run([{ _tag: 'Press', id: 'c' }]);
    expect(tapped.outs).toEqual([{ _tag: 'Play', id: 'c' }]);
    expect(tapped.state.focus).toBe(2);
  });

  it('toggles with Space or a tap and commits with Enter when choosing', () => {
    expect(run([key(' '), key('End'), key(' '), key('Enter')], choosing).outs).toEqual([
      { _tag: 'Toggle', id: 'a' },
      { _tag: 'Toggle', id: 'd' },
      { _tag: 'Commit' },
    ]);
    expect(run([{ _tag: 'Press', id: 'c' }], choosing).outs).toEqual([{ _tag: 'Toggle', id: 'c' }]);
    expect(run([key('ArrowRight'), key(' ')], choosing).outs).toEqual([{ _tag: 'Refused', id: 'b' }]);
  });

  it('ignores other keys, which bubble to the game', () => {
    expect(run([key('h'), key('t'), key('Escape')])).toEqual({ state: initialHand(playing), outs: [], focus: [] });
  });

  it('keeps the focus on the same card when the hand changes around it', () => {
    const start: HandState = { ...initialHand(playing), focus: 2 };
    const fewer: HandLayout = { ...playing, cards: [cards[1]!, cards[2]!, cards[3]!] };
    expect(syncHand(start, fewer)).toEqual({
      state: { focus: 1, ids: ['b', 'c', 'd'], inside: false },
      outs: [],
      focus: null,
    });
  });

  it('hands the focus to the next card when the focused one is played', () => {
    const start: HandState = { ...initialHand(playing), focus: 2, inside: true };
    const played: HandLayout = { ...playing, cards: [cards[0]!, cards[1]!, cards[3]!] };
    expect(syncHand(start, played)).toEqual({
      state: { focus: 2, ids: ['a', 'b', 'd'], inside: true },
      outs: [],
      focus: 'd',
    });
    // The last card played: the new last card takes it.
    const end: HandState = { ...initialHand(playing), focus: 3, inside: true };
    expect(syncHand(end, { ...playing, cards: cards.slice(0, 3) }).focus).toBe('c');
    // An empty hand leaves nothing to focus.
    expect(syncHand(end, { ...playing, cards: [] })).toEqual({
      state: { focus: 0, ids: [], inside: false },
      outs: [],
      focus: null,
    });
    // Without focus inside, a change never steals it.
    expect(syncHand({ ...start, inside: false }, played).focus).toBeNull();
  });

  it('names each card in words, with its note', () => {
    expect(handCardLabel(card('x', 12, 'S'))).toBe('Queen of spades');
    expect(handCardLabel(card('x', 9, 'H', true, { note: 'just received' }))).toBe('9 of hearts, just received');
  });
});
