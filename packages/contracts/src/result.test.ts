import { describe, expect, expectTypeOf, it } from 'vitest';
import { err, gameError, isGameError, ok, type GameError, type Result } from './index.ts';

type MoveError = { readonly _tag: 'NotYourTurn' } | { readonly _tag: 'IllegalMove'; readonly reason: string };

/** A stand-in for an engine step: doubles a score unless the move is illegal. */
const double = (score: number): Result<number, MoveError> =>
  score < 0 ? err({ _tag: 'IllegalMove', reason: 'negative score' }) : ok(score * 2);

describe('Result', () => {
  it('wraps a value as a success', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('wraps an error as a failure', () => {
    expect(err({ _tag: 'NotYourTurn' })).toEqual({ ok: false, error: { _tag: 'NotYourTurn' } });
  });

  it('narrows on `ok` to the value or the error', () => {
    const good = double(21);
    const bad = double(-1);

    expect(good.ok && good.value).toBe(42);
    expect(!bad.ok && bad.error).toEqual({ _tag: 'IllegalMove', reason: 'negative score' });

    if (good.ok) expectTypeOf(good.value).toEqualTypeOf<number>();
    if (!bad.ok) expectTypeOf(bad.error).toEqualTypeOf<MoveError>();
  });

  it('is plain data that survives a JSON round trip', () => {
    const result = double(5);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('defaults its error to GameError', () => {
    expectTypeOf<Result<number>>().toEqualTypeOf<Result<number, GameError>>();
  });
});

describe('gameError', () => {
  it('builds an error with a code and a player-facing message', () => {
    expect(gameError('NotYourTurn', "It's not your turn.")).toEqual({
      code: 'NotYourTurn',
      message: "It's not your turn.",
    });
  });

  it('leaves out an absent detail instead of storing undefined', () => {
    expect(Object.keys(gameError('X', 'x'))).toEqual(['code', 'message']);
    expect(gameError('IllegalMove', 'Take one to three.', { count: 4 })).toEqual({
      code: 'IllegalMove',
      message: 'Take one to three.',
      detail: { count: 4 },
    });
  });
});

describe('isGameError', () => {
  it('accepts anything with a string code and message', () => {
    expect(isGameError(gameError('X', 'x'))).toBe(true);
    expect(isGameError({ code: 'X', message: 'x', detail: [1] })).toBe(true);
  });

  it.each([null, undefined, 'X', { code: 'X' }, { message: 'x' }, { code: 1, message: 'x' }])('rejects %j', (value) => {
    expect(isGameError(value)).toBe(false);
  });
});
