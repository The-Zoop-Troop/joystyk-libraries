// Card identity: opaque ids that reveal nothing, stable ids for solo games, hidden-card
// placeholders for views, and the perturbation the no-leak conformance test needs.

import type { Rng } from '@joystyk/contracts';
import type { Card, CardId, Face } from './card.ts';
import { cardShort } from './names.ts';

/** Crockford's base-32 digits, lowercased: no i, l, o or u, so ids are easy to read in logs. */
export const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Every opaque id has this many characters, so its length says nothing either. */
export const ID_LENGTH = 5;

/** 32^5 possible ids. */
const ID_SPACE = 33554432;

const encodeId = (n: number): CardId => {
  let id = '';
  let rest = n;
  for (let i = 0; i < ID_LENGTH; i += 1) {
    id = ID_ALPHABET[rest % ID_ALPHABET.length]! + id;
    rest = Math.floor(rest / ID_ALPHABET.length);
  }
  return id;
};

/** True when `value` has the shape of an opaque id: five Crockford base-32 digits. */
export const isOpaqueId = (value: unknown): value is CardId =>
  typeof value === 'string' && value.length === ID_LENGTH && [...value].every((ch) => ID_ALPHABET.includes(ch));

/**
 * A fresh opaque id drawn from `rng`, different from every id in `taken`. Use it for a card
 * created mid-game (Shift 23's Shift replaces cards with new ones).
 */
export const newCardId = (rng: Rng, taken: ReadonlySet<CardId> = new Set()): CardId => {
  if (taken.size >= ID_SPACE) throw new RangeError('No card ids left.');
  for (;;) {
    const id = encodeId(rng.int(0, ID_SPACE));
    if (!taken.has(id)) return id;
  }
};

/**
 * Gives each card a fresh opaque id from `rng`, unique within the list and distinct from
 * `taken`. An id a card had before is replaced.
 *
 * Every id is drawn uniformly from the same space, whatever the card is, so an id reveals
 * nothing about rank, suit or deck position. Call it after the shuffle, at every deal: a
 * card then carries no history from an earlier hand either. The card game specs require
 * this whenever hands are hidden (hearts.md, "Card ids reveal nothing").
 */
export const assignIds = <F extends object>(faces: readonly F[], rng: Rng, taken: Iterable<CardId> = []): Card<F>[] => {
  const used = new Set(taken);
  return faces.map((f) => {
    const id = newCardId(rng, used);
    used.add(id);
    return { ...f, id };
  });
};

/**
 * Stable, readable ids for games without hidden hands (Klondike, FreeCell, Spider,
 * Blackjack): "QH", "10S", "JK", and "QH#2", "QH#3" for later copies in a multi-deck
 * game. The same deal always gives the same ids, so they work as animation keys and in
 * golden fixtures. Never use them where a card can be face down to an opponent: unlike
 * `assignIds`, they say what the card is.
 */
export const withStableIds = <F extends Face>(faces: readonly F[]): Card<F>[] => {
  const seen = new Map<string, number>();
  return faces.map((f) => {
    const base = cardShort(f, { glyphs: false });
    const copy = (seen.get(base) ?? 0) + 1;
    seen.set(base, copy);
    return { ...f, id: copy === 1 ? base : `${base}#${copy}` };
  });
};

/** A card the viewer may not see: no id, no rank, no suit, no value. */
export type HiddenCard = { readonly hidden: true };

/** The one hidden-card value. */
export const HIDDEN_CARD: HiddenCard = { hidden: true };

export const isHiddenCard = (value: unknown): value is HiddenCard =>
  typeof value === 'object' && value !== null && (value as { hidden?: unknown }).hidden === true;

/**
 * A pile as one viewer sees it: each card they can see as itself, every other card as a
 * `HiddenCard` in its place. For a hand that is wholly hidden, send its length instead.
 */
export const redact = <C>(cards: readonly C[], canSee: (card: C, index: number) => boolean): (C | HiddenCard)[] =>
  cards.map((card, i) => (canSee(card, i) ? card : HIDDEN_CARD));

/** A face-down pile as placeholders: `n` hidden cards. */
export const hiddenCards = (count: number): HiddenCard[] => Array.from({ length: count }, () => HIDDEN_CARD);

/**
 * The building block for the conformance no-leak test (game-contract.md, "Conformance
 * tests", item 5). Given every card zone in a state and what `viewer` can see, it returns
 * new zones in which the hidden cards have been rearranged:
 *
 * - the faces of hidden cards (every field but `id`) are shuffled among the hidden slots;
 * - their ids are shuffled among the same slots, independently of the faces;
 * - visible cards, zone sizes and the zone keys don't change.
 *
 * A `viewFor` that leaks nothing gives the same view before and after, so a game's
 * `perturbHidden(state, viewer, rng)` is this function plus putting the zones back.
 * Shuffling ids separately is what lets the test catch a view that hides faces but keeps
 * ids (the flaw shift-23.md describes).
 */
export const perturbHidden = <C extends { readonly id: CardId }, K extends string>(
  zones: Readonly<Record<K, readonly C[]>>,
  canSee: (zone: K, card: C, index: number) => boolean,
  rng: Rng,
): Record<K, C[]> => {
  const keys = Object.keys(zones) as K[];
  const slots: { zone: K; index: number }[] = [];
  const hidden: C[] = [];
  for (const zone of keys) {
    zones[zone].forEach((card, index) => {
      if (!canSee(zone, card, index)) {
        slots.push({ zone, index });
        hidden.push(card);
      }
    });
  }
  const faces = rng.shuffle(hidden);
  const ids = rng.shuffle(hidden.map((card) => card.id));
  const out = {} as Record<K, C[]>;
  for (const zone of keys) out[zone] = zones[zone].slice();
  slots.forEach(({ zone, index }, i) => {
    out[zone][index] = { ...faces[i]!, id: ids[i]! };
  });
  return out;
};
