import { describe, expect, it } from 'vitest';
import { pageFor, pathOf, samePage } from './routes.ts';

describe('pageFor', () => {
  it.each([
    ['/', { _tag: 'Home' }],
    ['/games/greed', { _tag: 'Game', id: 'greed' }],
    ['/games/shift-23', { _tag: 'Game', id: 'shift-23' }],
    ['/categories/dice', { _tag: 'Category', id: 'dice' }],
    ['/games/Bad_Id', { _tag: 'NotFound', path: '/games/Bad_Id' }],
    ['/categories/Not_A_Slug', { _tag: 'NotFound', path: '/categories/Not_A_Slug' }],
    ['/games', { _tag: 'NotFound', path: '/games' }],
    ['/games/greed/rules', { _tag: 'NotFound', path: '/games/greed/rules' }],
    ['/licenses', { _tag: 'Licenses' }],
    ['/advertise', { _tag: 'Advertise' }],
    ['/advertise/policy', { _tag: 'AdvertisePolicy' }],
    ['/advertise/thanks', { _tag: 'AdvertiseSent' }],
    ['/advertise/other', { _tag: 'NotFound', path: '/advertise/other' }],
    ['/ads/click/42', { _tag: 'LeavingSite', id: '42' }],
    ['/ads/click/0', { _tag: 'NotFound', path: '/ads/click/0' }],
    ['/ads/click/https%3A%2F%2Fevil.example', { _tag: 'NotFound', path: '/ads/click/https%3A%2F%2Fevil.example' }],
  ])('%s', (path, page) => {
    expect(pageFor(path)).toEqual(page);
  });
});

describe('pathOf', () => {
  it('gives one canonical path, so the server can redirect trailing slashes', () => {
    expect(pathOf(pageFor('/games/greed/'))).toBe('/games/greed');
    expect(pathOf(pageFor('/categories/dice/'))).toBe('/categories/dice');
    expect(pathOf(pageFor('/'))).toBe('/');
    expect(pathOf(pageFor('/advertise/'))).toBe('/advertise');
    expect(pathOf(pageFor('/advertise/policy/'))).toBe('/advertise/policy');
    expect(pathOf(pageFor('/nope/'))).toBe('/nope/');
  });
});

describe('samePage', () => {
  it('compares tag and id', () => {
    expect(samePage(pageFor('/games/greed'), pageFor('/games/greed/'))).toBe(true);
    expect(samePage(pageFor('/games/greed'), pageFor('/games/containment'))).toBe(false);
    expect(samePage(pageFor('/categories/dice'), pageFor('/games/dice'))).toBe(false);
    expect(samePage(pageFor('/a'), pageFor('/b'))).toBe(false);
  });
});
