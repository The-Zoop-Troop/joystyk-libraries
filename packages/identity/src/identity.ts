import { err, ok, type Result } from '@joystyk/contracts';
import { defineRecordKind, type Storage, type StorageError } from '@joystyk/storage';
import * as z from 'zod/mini';
import { AVATAR_IDS, isAvatarId, randomAvatar, type AvatarId } from './avatars.ts';
import { generateName, type Random } from './names/generator.ts';
import { checkDisplayName, isDisplayName, type NameRejection } from './names/filter.ts';

/**
 * A guest player id: a random UUID made on the device the first time the site runs. It
 * identifies the player, not the device, and is never sent to an ad network or analytics
 * (there are none). Saves, stats, streaks and preferences all key on it, so v2 can attach it
 * to an account and carry the history across.
 */
export type PlayerId = string & { readonly __brand: 'PlayerId' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lowercase RFC 9562 UUID, the form `crypto.randomUUID` returns. */
export const isPlayerId = (value: unknown): value is PlayerId => typeof value === 'string' && UUID.test(value);

/** Everything the site knows about a player. No email, no age, nothing personal (D-26). */
export type Profile = {
  readonly id: PlayerId;
  /** Always passes `checkDisplayName`. */
  readonly displayName: string;
  /** `generated` until the player types a name of their own. */
  readonly nameSource: 'generated' | 'chosen';
  readonly avatar: AvatarId;
  /** Epoch milliseconds. */
  readonly createdAt: number;
};

const playerId = z.custom<PlayerId>(isPlayerId, { error: 'Expected a player id' });

/** Which player this device plays as. The only record not keyed on a player id. */
export const DEVICE_RECORD = defineRecordKind<{ readonly playerId: PlayerId }>({
  store: 'identity',
  version: 1,
  schema: z.object({ playerId }),
  label: 'player id',
});

/**
 * A player's profile, keyed `player/<id>`. The name is re-checked on every read, so a word
 * added to the blocklist later retires old names that contain it: the profile is discarded
 * and the player gets a fresh generated name under the same id.
 */
export const PROFILE_RECORD = defineRecordKind<Profile>({
  store: 'identity',
  version: 1,
  schema: z.object({
    id: playerId,
    displayName: z.custom<string>(isDisplayName, { error: 'Expected an allowed display name' }),
    nameSource: z.enum(['generated', 'chosen']),
    avatar: z.enum(AVATAR_IDS),
    createdAt: z.number().check(z.nonnegative()),
  }),
  label: 'player profile',
});

const DEVICE_KEY = 'device';
const profileKey = (id: PlayerId): string => `player/${id}`;

export type IdentityOptions = {
  readonly storage: Storage;
  /** Makes a new player id; `crypto.randomUUID` in the browser (see the browser entry). */
  readonly randomUUID: () => string;
  /** Picks generated names and avatars. */
  readonly random: Random;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
};

export type IdentityError = NameRejection | StorageError | { readonly code: 'UnknownAvatar'; readonly message: string };

/** The guest identity on this device. */
export interface Identity {
  /**
   * The current player, created on first use. Never fails: when storage can't keep the new
   * guest, the guest lives for this page only and storage has already told the player.
   */
  current(): Promise<Profile>;
  /** Sets a name the player typed, after `checkDisplayName`. */
  rename(name: string): Promise<Result<Profile, IdentityError>>;
  /** Replaces the name with a fresh generated one. */
  rollName(): Promise<Result<Profile, IdentityError>>;
  setAvatar(avatar: string): Promise<Result<Profile, IdentityError>>;
}

/** Creates the guest identity over the platform storage. */
export const createIdentity = (options: IdentityOptions): Identity => {
  const now = options.now ?? Date.now;
  const device = options.storage.records(DEVICE_RECORD);
  const profiles = options.storage.records(PROFILE_RECORD);

  const newId = (): PlayerId => {
    const id = options.randomUUID();
    if (!isPlayerId(id)) throw new TypeError(`randomUUID returned "${id}", which is not a lowercase UUID`);
    return id;
  };

  const newProfile = (id: PlayerId): Profile => ({
    id,
    displayName: generateName(options.random),
    nameSource: 'generated',
    avatar: randomAvatar(options.random),
    createdAt: now(),
  });

  /**
   * The player this device plays as. On a first visit two tabs may start at once (gp-d4v),
   * so the device record and the profile are each written only if absent, in one storage
   * transaction (`setIfAbsent`): a tab that loses the race plays as the guest the other
   * created. That needs no Web Locks, so no browser is left without the guard; storage that
   * fell back to memory isn't shared between tabs, so each tab is its own guest there.
   */
  const load = async (): Promise<Profile> => {
    const pointer = await device.get(DEVICE_KEY);
    let id = pointer.ok ? (pointer.value?.playerId ?? null) : null;
    if (id === null) {
      const fresh = newId();
      const claimed = await device.setIfAbsent(DEVICE_KEY, { playerId: fresh });
      id = claimed.ok ? claimed.value.playerId : fresh;
    }
    const key = profileKey(id);
    const stored = await profiles.get(key);
    if (stored.ok && stored.value !== null && stored.value.id === id) return stored.value;
    // A first visit, or a profile that was lost: keep the id.
    const profile = newProfile(id);
    if (stored.ok && stored.value !== null) {
      // A profile for another id sits under this key; replace it.
      await profiles.set(key, profile);
      return profile;
    }
    const created = await profiles.setIfAbsent(key, profile);
    return created.ok && created.value.id === id ? created.value : profile;
  };

  let cached: Promise<Profile> | null = null;
  const current = (): Promise<Profile> => (cached ??= load());

  const update = async (change: (profile: Profile) => Profile): Promise<Result<Profile, IdentityError>> => {
    const next = change(await current());
    const written = await profiles.set(profileKey(next.id), next);
    if (!written.ok) return written;
    cached = Promise.resolve(next);
    return ok(next);
  };

  return {
    current,
    rename: async (name) => {
      const checked = checkDisplayName(name);
      if (!checked.ok) return checked;
      return update((profile) => ({ ...profile, displayName: checked.value, nameSource: 'chosen' }));
    },
    rollName: () =>
      update((profile) => ({ ...profile, displayName: generateName(options.random), nameSource: 'generated' })),
    setAvatar: async (avatar) => {
      if (!isAvatarId(avatar)) return err({ code: 'UnknownAvatar', message: "That avatar isn't available." });
      return update((profile) => ({ ...profile, avatar }));
    },
  };
};
