// @joystyk/identity/browser: the identity's randomness from the Web Crypto API.
import type { Storage } from '@joystyk/storage';
import type { Random } from '../names/generator.ts';
import { createIdentity, type Identity } from '../identity.ts';

/** A uniform float in [0, 1) from `crypto.getRandomValues`. */
export const cryptoRandom: Random = () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32;

/** A new player id from `crypto.randomUUID`. */
export const cryptoRandomUUID = (): string => crypto.randomUUID();

/** The guest identity with the browser's randomness. */
export const createBrowserIdentity = (storage: Storage, now?: () => number): Identity =>
  createIdentity({
    storage,
    randomUUID: cryptoRandomUUID,
    random: cryptoRandom,
    ...(now === undefined ? {} : { now }),
  });
