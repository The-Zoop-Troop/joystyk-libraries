import { describe, expect, expectTypeOf, it } from 'vitest';
import { isJson, type Json } from './index.ts';

describe('isJson', () => {
  it.each([
    ['null', null],
    ['a boolean', true],
    ['a string', 'shift-23'],
    ['an integer', 42],
    ['a fraction', 0.25],
    ['zero', 0],
    ['an empty object', {}],
    ['an empty array', []],
    [
      'nested data',
      {
        board: [
          [1, 2],
          [3, null],
        ],
        players: [{ name: 'Ana', score: 3 }],
        over: false,
      },
    ],
    ['a null-prototype object', Object.assign(Object.create(null) as object, { a: 1 })],
    [
      'a shared, non-cyclic reference',
      (() => {
        const leaf = { x: 1 };
        return { a: leaf, b: leaf };
      })(),
    ],
  ])('accepts %s', (_, value) => {
    expect(isJson(value)).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it.each([
    ['undefined', undefined],
    ['an undefined property', { a: undefined }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-0, which comes back as 0', -0],
    ['a bigint', 1n],
    ['a symbol', Symbol('x')],
    ['a function', () => 1],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Set', new Set()],
    [
      'a class instance',
      new (class Point {
        x = 1;
      })(),
    ],
    ['a sparse array', [1, , 3]],
    ['a symbol key', { [Symbol('k')]: 1 }],
    ['a nested bad value', { a: [{ b: Number.NaN }] }],
    [
      'a cycle',
      (() => {
        const o: Record<string, unknown> = {};
        o['self'] = o;
        return o;
      })(),
    ],
  ])('rejects %s', (_, value) => {
    expect(isJson(value)).toBe(false);
  });

  it('narrows unknown to Json', () => {
    const value: unknown = JSON.parse('{"a":[1]}');
    if (isJson(value)) expectTypeOf(value).toEqualTypeOf<Json>();
    expect(isJson(value)).toBe(true);
  });
});
