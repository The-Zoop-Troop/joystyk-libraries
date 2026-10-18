// <ad-slot> as a model: the collapse rules, the lazy request, the fill and the impression
// beacon, as state and commands. No DOM.
import { initial, inputsFor, resolve, step, reject, subscriptionsFor } from '@gyral/testing';
import { describe, expect, it } from 'vitest';
import {
  adBeacon,
  AdSlot,
  adEntitlement,
  adServer,
  alwaysShowAds,
  connectivity,
  queryOf,
  slotPresentation,
  type AdSlotProps,
  type AdSlotState,
} from './ad-slot.ts';
import type { AdFill, CreativeFill } from './ad-wire.ts';

const { spec } = AdSlot;
const props: AdSlotProps = { slotId: 'results', page: undefined, gameId: 'nim', category: undefined };
const URL_NIM = '/api/ads/slot?slot=results&page=results&game=nim';

const creative: CreativeFill = {
  kind: 'creative',
  id: 7,
  image: { src: '/ads/creative/abc.png', width: 300, height: 200 },
  alt: 'A blue circle',
  headline: 'A sample sponsor',
  href: '/ads/click/7?slot=results',
  beacon: '/api/ads/impression?creative=7&slot=results',
};

const start = (): AdSlotState => initial(spec, props).state;
const near = (s = start()) => step(spec, s, { _tag: 'Near' }, props);
const loaded = (fill: AdFill) => step(spec, near().state, { _tag: 'Loaded', url: URL_NIM, fill }, props).state;

describe('<ad-slot> model', () => {
  it('starts with its box reserved, as the server renders it, asks for nothing and starts listening', () => {
    const first = initial(spec, props);
    expect(first.state).toEqual({ entitlement: 'show', online: null, near: false, ad: { _tag: 'Waiting' } });
    expect(slotPresentation(first.state)).toBe('reserved');
    const subscriptions = subscriptionsFor(spec, first.state, props);
    expect(inputsFor(subscriptions, adEntitlement)).toHaveLength(1);
    expect(inputsFor(subscriptions, connectivity)).toHaveLength(1);
    expect(inputsFor(first.commands, adServer)).toEqual([]);
    expect(first.commands).toEqual([]);
    const [ads, online] = subscriptions;
    if (ads === undefined || online === undefined) throw new Error('expected two commands');
    expect(resolve(ads, 'hide')).toEqual({ _tag: 'Entitled', entitlement: 'hide' });
    expect(resolve(online, false)).toEqual({ _tag: 'Connectivity', online: false });
  });

  it('asks once the box is near the viewport, with the page context only', () => {
    const asked = near();
    expect(inputsFor(asked.commands, adServer)).toEqual([URL_NIM]);
    expect(asked.state.ad).toEqual({ _tag: 'Loading', url: URL_NIM });
    // A second sighting asks nothing more.
    expect(inputsFor(near(asked.state).commands, adServer)).toEqual([]);
    const [command] = asked.commands;
    if (command === undefined) throw new Error('expected a request');
    expect(resolve(command, creative)).toEqual({ _tag: 'Loaded', url: URL_NIM, fill: creative });
    expect(reject(command, 'offline')).toEqual({ _tag: 'LoadFailed', url: URL_NIM });
  });

  it('builds the query from its attributes, defaulting the page to the slot’s surface', () => {
    expect(queryOf(props)).toEqual({ slot: 'results', page: 'results', game: 'nim', category: null });
    expect(queryOf({ slotId: 'category-rail', page: 'category', gameId: undefined, category: 'cards' })).toEqual({
      slot: 'category-rail',
      page: 'category',
      game: null,
      category: 'cards',
    });
  });

  it('waits while offline or ad-free, and asks when that changes', () => {
    const offline = step(spec, start(), { _tag: 'Connectivity', online: false }, props).state;
    const sighted = near(offline);
    expect(inputsFor(sighted.commands, adServer)).toEqual([]);
    expect(
      inputsFor(step(spec, sighted.state, { _tag: 'Connectivity', online: true }, props).commands, adServer),
    ).toEqual([URL_NIM]);
    const hidden = step(spec, start(), { _tag: 'Entitled', entitlement: 'hide' }, props).state;
    expect(inputsFor(near(hidden).commands, adServer)).toEqual([]);
  });

  it('fills the box with a creative or a house promotion, and collapses for nothing or a failure', () => {
    const filled = loaded(creative);
    expect(filled.ad).toEqual({ _tag: 'Filled', url: URL_NIM, fill: creative, seen: false });
    expect(slotPresentation(filled)).toBe('reserved');
    const house = loaded({
      kind: 'house',
      headline: 'Play Greed',
      text: 'Push your luck.',
      cta: 'Play now',
      href: '/games/greed',
    });
    expect(house.ad._tag).toBe('Filled');
    expect(slotPresentation(loaded({ kind: 'collapse' }))).toBe('collapsed');
    const failed = step(spec, near().state, { _tag: 'LoadFailed', url: URL_NIM }, props).state;
    expect(slotPresentation(failed)).toBe('collapsed');
  });

  it('ignores an answer for a context it no longer shows', () => {
    const asking = near().state;
    expect(
      step(
        spec,
        asking,
        { _tag: 'Loaded', url: '/api/ads/slot?slot=results&page=results&game=greed', fill: creative },
        props,
      ).state,
    ).toBe(asking);
  });

  it('sends one beacon once the creative is seen, and collapses if its image breaks', () => {
    const seen = step(spec, loaded(creative), { _tag: 'Image', status: 'seen' }, props);
    expect(inputsFor(seen.commands, adBeacon)).toEqual([creative.beacon]);
    expect(inputsFor(step(spec, seen.state, { _tag: 'Image', status: 'seen' }, props).commands, adBeacon)).toEqual([]);
    const broken = step(spec, loaded(creative), { _tag: 'Image', status: 'broken' }, props).state;
    expect(slotPresentation(broken)).toBe('collapsed');
  });

  it('asks again when client navigation gives it another game', () => {
    const filled = loaded(creative);
    const next: AdSlotProps = { ...props, gameId: 'greed' };
    const moved = step(spec, filled, { _tag: 'PropsChanged', props: next, prev: props }, next);
    expect(inputsFor(moved.commands, adServer)).toEqual(['/api/ads/slot?slot=results&page=results&game=greed']);
    expect(step(spec, filled, { _tag: 'PropsChanged', props, prev: props }, props).state).toBe(filled);
  });

  it('collapses for an ad-free entitlement and while offline, and comes back', () => {
    const hidden = step(spec, start(), { _tag: 'Entitled', entitlement: 'hide' }, props).state;
    expect(slotPresentation(hidden)).toBe('collapsed');
    const offline = step(spec, start(), { _tag: 'Connectivity', online: false }, props).state;
    expect(slotPresentation(offline)).toBe('collapsed');
    expect(slotPresentation(step(spec, offline, { _tag: 'Connectivity', online: true }, props).state)).toBe('reserved');
  });

  it('says it is online only once the browser has said so', () => {
    const states = (s: AdSlotState) => spec.states?.(s);
    // Before the first report the box stays reserved, as served, and may load.
    expect(states(start())).toEqual({ collapsed: false, online: false });
    expect(inputsFor(near().commands, adServer)).toEqual([URL_NIM]);
    const online = step(spec, start(), { _tag: 'Connectivity', online: true }, props).state;
    expect(states(online)).toEqual({ collapsed: false, online: true });
    const offline = step(spec, online, { _tag: 'Connectivity', online: false }, props).state;
    expect(states(offline)).toEqual({ collapsed: true, online: false });
  });

  it('has a v1 entitlement source that always shows ads', () => {
    expect(alwaysShowAds.get()).toBe('show');
    const stop = alwaysShowAds.subscribe(() => {
      throw new Error('never changes');
    });
    stop();
  });
});
