import { describe, expect, it } from 'vitest';
import { murmur3, utf8 } from './hash.ts';

describe('utf8', () => {
  it('encodes one-, two-, three- and four-byte code points', () => {
    expect([...utf8('A')]).toEqual([0x41]);
    expect([...utf8('é')]).toEqual([0xc3, 0xa9]);
    expect([...utf8('♠')]).toEqual([0xe2, 0x99, 0xa0]);
    expect([...utf8('😀')]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('replaces lone surrogates with U+FFFD, as TextEncoder does', () => {
    expect([...utf8('\ud800')]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...utf8('\udc00x')]).toEqual([0xef, 0xbf, 0xbd, 0x78]);
  });
});

describe('murmur3 (x86, 32-bit)', () => {
  // Published test vectors for MurmurHash3_x86_32, also reproduced with the smhasher C code.
  it.each([
    ['', 0, 0x00000000],
    ['', 1, 0x514e28b7],
    ['', 0xffffffff, 0x81f16f39],
    ['\0\0\0\0', 0, 0x2362f9de],
    ['a', 0x9747b28c, 0x7fa09ea6],
    ['aa', 0x9747b28c, 0x5d211726],
    ['aaa', 0x9747b28c, 0x283e0130],
    ['aaaa', 0x9747b28c, 0x5a97808a],
    ['abcd', 0x9747b28c, 0xf0478627],
    ['Hello, world!', 0x9747b28c, 0x24884cba],
    ['The quick brown fox jumps over the lazy dog', 0x9747b28c, 0x2fa826cd],
    ['ππππππππ', 0x9747b28c, 0xd58063c1],
  ])('hashes %j with seed %i', (text, seed, expected) => {
    expect(murmur3(text, seed)).toBe(expected);
  });

  it('returns an unsigned 32-bit integer', () => {
    for (const text of ['x', 'joystyk', 'sudoku:2026-10-08']) {
      const h = murmur3(text);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    }
  });
});
