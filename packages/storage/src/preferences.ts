import { ok, type Preferences, type Result } from '@joystyk/contracts';
import * as z from 'zod/mini';
import type { StorageError } from './backend.ts';
import { parseStorageChange, type ChangeFeed } from './changes.ts';
import { createRecordStore, defineRecordKind, type RecordContext } from './record.ts';

/**
 * What a player chose. `system` follows the operating system's setting; the frame resolves
 * the choices into the contracts' `Preferences` with `resolvePreferences`.
 */
export type StoredPreferences = {
  readonly reducedMotion: 'system' | 'reduce' | 'no-preference';
  readonly sound: boolean;
  /** 0 … 1. */
  readonly volume: number;
  /**
   * Whether shortcuts made of a single printable key are on. WCAG 2.1.4 requires a way to
   * turn them off, for speech-input and switch users.
   */
  readonly singleKeyShortcuts: boolean;
  readonly theme: 'system' | 'light' | 'dark';
  /** A BCP 47 tag, or null to follow the browser. */
  readonly locale: string | null;
  /**
   * True once the player accepted the AI-content notice (D-44); games with AI-made content
   * stay locked until then. Missing means not yet, so older records need no migration.
   */
  readonly aiContentAccepted?: boolean;
};

export const DEFAULT_PREFERENCES: StoredPreferences = {
  reducedMotion: 'system',
  sound: true,
  volume: 0.8,
  singleKeyShortcuts: true,
  theme: 'system',
  locale: null,
};

/** Version 1 of the preferences record. */
export const PREFERENCES_RECORD = defineRecordKind<StoredPreferences>({
  store: 'preferences',
  version: 1,
  schema: z.object({
    reducedMotion: z.enum(['system', 'reduce', 'no-preference']),
    sound: z.boolean(),
    volume: z.number().check(z.gte(0), z.lte(1)),
    singleKeyShortcuts: z.boolean(),
    theme: z.enum(['system', 'light', 'dark']),
    locale: z.nullable(z.string().check(z.regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/))),
    aiContentAccepted: z.optional(z.boolean()),
  }),
  label: 'set of preferences',
});

/** What the browser reports, read by the frame (`systemEnvironment` in the browser entry). */
export type SystemEnvironment = {
  readonly prefersReducedMotion: boolean;
  readonly prefersDark: boolean;
  readonly locale: string;
};

/** The contracts' `Preferences` plus the shortcut setting, which games with keyboard controls honor too. */
export type ResolvedPreferences = Preferences & { readonly singleKeyShortcuts: boolean };

/** Resolves a player's choices against the system's settings. Pure. */
export const resolvePreferences = (stored: StoredPreferences, system: SystemEnvironment): ResolvedPreferences => ({
  reducedMotion: stored.reducedMotion === 'system' ? system.prefersReducedMotion : stored.reducedMotion === 'reduce',
  sound: stored.sound,
  volume: stored.volume,
  colorScheme: stored.theme === 'system' ? (system.prefersDark ? 'dark' : 'light') : stored.theme,
  locale: stored.locale ?? system.locale,
  singleKeyShortcuts: stored.singleKeyShortcuts,
});

/** Where a change came from: an `update` in this tab, or one in another tab of the site. */
export type PreferencesSource = 'this-tab' | 'other-tab';

/** One player's preferences. */
export interface PreferencesStore {
  /** The stored choices, or `DEFAULT_PREFERENCES`. */
  get(): Promise<Result<StoredPreferences, StorageError>>;
  /**
   * Merges `changes` into the stored choices, writes them, notifies this tab's subscribers,
   * tells the other tabs, and returns them.
   */
  update(changes: Partial<StoredPreferences>): Promise<Result<StoredPreferences, StorageError>>;
  /**
   * Called after each successful `update` in this tab, and, when storage has a change feed,
   * after each one in another tab, with the choices read back from storage (gp-d4v).
   * Returns an idempotent unsubscribe.
   */
  subscribe(listener: (preferences: StoredPreferences, source: PreferencesSource) => void): () => void;
}

export const createPreferencesStore = (
  context: RecordContext,
  playerId: string,
  changes?: ChangeFeed,
): PreferencesStore => {
  const records = createRecordStore(context, PREFERENCES_RECORD);
  const listeners = new Set<(preferences: StoredPreferences, source: PreferencesSource) => void>();
  const get = async (): Promise<Result<StoredPreferences, StorageError>> => {
    const stored = await records.get(playerId);
    return stored.ok ? ok(stored.value ?? DEFAULT_PREFERENCES) : stored;
  };
  const tell = (preferences: StoredPreferences, source: PreferencesSource): void => {
    for (const listener of [...listeners]) listener(preferences, source);
  };
  // Another tab changed this player's choices: read them back, through the schema.
  changes?.subscribe((message) => {
    void parseStorageChange(message).then(async (change) => {
      if (change?.kind !== 'preferences' || change.playerId !== playerId || listeners.size === 0) return;
      const current = await get();
      if (current.ok) tell(current.value, 'other-tab');
    });
  });
  return {
    get,
    update: async (partial) => {
      const current = await get();
      if (!current.ok) return current;
      const next = { ...current.value, ...partial };
      const written = await records.set(playerId, next);
      if (!written.ok) return written;
      tell(next, 'this-tab');
      changes?.publish({ kind: 'preferences', playerId });
      return ok(next);
    },
    subscribe: (listener) => {
      // A wrapper, so subscribing the same function twice gives two independent subscriptions.
      const entry = (preferences: StoredPreferences, source: PreferencesSource): void => listener(preferences, source);
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };
};
