import { err, gameError, ok, type Json, type Migration, type Outcome, type SaveEnvelope } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import {
  createMemoryBackend,
  createMemoryChangeHub,
  DEFAULT_PREFERENCES,
  EMPTY_STATS,
  EMPTY_STREAK,
  openStorage,
  recordOutcome,
  resolvePreferences,
  StorageFailure,
  type PreferencesSource,
  type SaveDecoder,
  type StorageNotice,
  type StoredPreferences,
} from './index.ts';

const PLAYER = '0f8fad5b-d9cb-469f-a165-70867728950e';

const setup = () => {
  const backend = createMemoryBackend();
  const notices: StorageNotice[] = [];
  let clock = 10_000;
  const storage = openStorage({ backend, onNotice: (n) => notices.push(n), now: () => (clock += 1000) });
  return { backend, notices, storage, player: storage.player(PLAYER) };
};

const envelope = (state: Json, saveVersion = 2): SaveEnvelope => ({
  gameId: 'nim',
  build: '1.0.0',
  rulesVersion: 1,
  saveVersion,
  rng: { algorithm: 'sfc32', words: [1, 2, 3, 4] },
  seats: [
    { id: 0, name: 'Pixel Fox 42', controller: 'human' },
    { id: 1, name: 'Robot', controller: 'ai', aiLevel: 'easy' },
  ],
  state,
  elapsedMs: 4_200,
  replay: {
    layer: 2,
    gameId: 'nim',
    rulesVersion: 1,
    config: { heap: 7 },
    seats: [{ id: 0, name: 'Pixel Fox 42', controller: 'human' }],
    seed: { algorithm: 'sfc32', words: [1, 2, 3, 4] },
    inputs: [
      { kind: 'command', seat: 0, command: { take: 2 } },
      { kind: 'seat', seat: 1, change: { type: 'left' } },
      { kind: 'job', jobId: 'j1', outcome: { ok: false, reason: 'timeout' } },
    ],
  },
});

// Nim's save v1 was { left }, v2 is { heap }.
const nimMigrations: Migration[] = [{ from: 1, to: 2, migrate: (old) => ok({ heap: (old as { left: number }).left }) }];
const nim: SaveDecoder = {
  saveVersion: 2,
  migrations: nimMigrations,
  state: z.object({ heap: z.int().check(z.nonnegative()) }),
};

describe('save slots', () => {
  it('writes an envelope to a slot and reads it back', async () => {
    const { player } = setup();
    expect(await player.saves.write('nim', 'auto', envelope({ heap: 5 }))).toEqual(ok(undefined));
    expect(await player.saves.read('nim', 'auto')).toEqual(
      ok({ slot: 'auto', savedAt: 11_000, envelope: envelope({ heap: 5 }) }),
    );
  });

  it("keeps the runner's records: the clock, the AI stream, undos and assistance", async () => {
    const { player } = setup();
    const full: SaveEnvelope = {
      ...envelope({ heap: 5 }),
      clockStarted: true,
      aiRng: { algorithm: 'sfc32', words: [5, 6, 7, 8] },
      undosUsed: 2,
      assists: ['undo', 'hint'],
      assistCounts: { undo: 2, hint: 3, shuffle: 1 },
    };
    await player.saves.write('nim', 'auto', full);
    expect(await player.saves.read('nim', 'auto')).toEqual(ok({ slot: 'auto', savedAt: 11_000, envelope: full }));
    expect(await player.saves.load('nim', 'auto', nim)).toMatchObject({
      ok: true,
      value: {
        envelope: {
          clockStarted: true,
          undosUsed: 2,
          assists: ['undo', 'hint'],
          assistCounts: { undo: 2, hint: 3, shuffle: 1 },
        },
      },
    });
  });

  it('lists every slot of one game, and only that game', async () => {
    const { player } = setup();
    await player.saves.write('nim', 'slot-2', envelope({ heap: 2 }));
    await player.saves.write('nim', 'slot-1', envelope({ heap: 1 }));
    await player.saves.write('nim-plus', 'slot-1', { ...envelope({ heap: 9 }), gameId: 'nim-plus' });
    const list = await player.saves.list('nim');
    expect(list.ok && list.value.map((save) => [save.slot, save.envelope.state])).toEqual([
      ['slot-1', { heap: 1 }],
      ['slot-2', { heap: 2 }],
    ]);
  });

  it('keeps players apart', async () => {
    const { storage, player } = setup();
    await player.saves.write('nim', 'auto', envelope({ heap: 5 }));
    expect(await storage.player('another-player').saves.read('nim', 'auto')).toEqual(ok(null));
  });

  it('deletes a slot', async () => {
    const { player } = setup();
    await player.saves.write('nim', 'auto', envelope({ heap: 5 }));
    await player.saves.delete('nim', 'auto');
    expect(await player.saves.read('nim', 'auto')).toEqual(ok(null));
  });

  it('refuses bad slot names, bad game ids and mismatched envelopes', async () => {
    const { player } = setup();
    const codes = await Promise.all([
      player.saves.write('nim', 'a/b', envelope({ heap: 1 })),
      player.saves.write('Not A Game', 'auto', envelope({ heap: 1 })),
      player.saves.write('chess', 'auto', envelope({ heap: 1 })),
    ]);
    expect(codes.map((r) => r.ok || r.error.code)).toEqual(['InvalidKey', 'InvalidKey', 'InvalidValue']);
  });

  it('archives a save whose envelope is malformed, with a notice', async () => {
    const { backend, notices, player } = setup();
    backend.poke('saves', `${PLAYER}/nim/auto`, {
      version: 1,
      writtenAt: 1,
      value: { savedAt: 1, envelope: { ...envelope({ heap: 1 }), rng: 'not an rng' } },
    });
    expect(await player.saves.read('nim', 'auto')).toEqual(ok(null));
    expect(notices).toMatchObject([{ code: 'RecordArchived', store: 'saves' }]);
    expect(notices[0]?.message).toBe("A saved game couldn't be opened, so it was set aside.");
  });

  describe('load', () => {
    it('migrates old game state and validates it with the game schema', async () => {
      const { player } = setup();
      await player.saves.write('nim', 'auto', envelope({ left: 4 }, 1));
      const loaded = await player.saves.load('nim', 'auto', nim);
      expect(loaded.ok && loaded.value?.envelope).toMatchObject({ saveVersion: 2, state: { heap: 4 } });
    });

    it('archives a save the game schema rejects', async () => {
      const { backend, notices, player } = setup();
      await player.saves.write('nim', 'auto', envelope({ heap: -1 }));
      expect(await player.saves.load('nim', 'auto', nim)).toEqual(ok(null));
      expect(backend.peek('saves', `${PLAYER}/nim/auto`)).toBeUndefined();
      expect(notices).toMatchObject([{ code: 'RecordArchived', key: `${PLAYER}/nim/auto` }]);
    });

    it('archives a save whose migration fails', async () => {
      const { notices, player } = setup();
      const failing: SaveDecoder = {
        ...nim,
        migrations: [{ from: 1, to: 2, migrate: () => err(gameError('Corrupt', 'Bad save')) }],
      };
      await player.saves.write('nim', 'auto', envelope({ left: 4 }, 1));
      expect(await player.saves.load('nim', 'auto', failing)).toEqual(ok(null));
      expect(notices[0]).toMatchObject({ code: 'RecordArchived', issues: ['Corrupt: Bad save'] });
    });

    it('keeps a save from a newer game build', async () => {
      const { backend, notices, player } = setup();
      await player.saves.write('nim', 'auto', envelope({ heap: 1, extra: 1 }, 3));
      expect(await player.saves.load('nim', 'auto', nim)).toEqual(ok(null));
      expect(backend.peek('saves', `${PLAYER}/nim/auto`)).toBeDefined();
      expect(notices[0]?.code).toBe('RecordFromFuture');
    });
  });
});

describe('stats', () => {
  const won: Outcome = { result: 'won', placements: [{ seat: 0, place: 1 }], summary: 'Won', elapsedMs: 60_000 };

  it('starts empty and adds outcomes', async () => {
    const { player } = setup();
    expect(await player.stats.get('nim')).toEqual(ok(EMPTY_STATS));
    await player.stats.record('nim', won);
    const after = await player.stats.record('nim', { ...won, result: 'draw', elapsedMs: 1_000 });
    expect(after).toEqual(
      ok({ ...EMPTY_STATS, played: 2, won: 1, drawn: 1, totalElapsedMs: 61_000, lastPlayedAt: 13_000 }),
    );
    expect(await player.stats.get('nim')).toEqual(after);
  });

  it('recordOutcome counts each result in its own field', () => {
    const results = ['won', 'lost', 'draw', 'completed', 'abandoned'] as const;
    const stats = results.reduce((acc, result) => recordOutcome(acc, { ...won, result, elapsedMs: 1 }, 5), EMPTY_STATS);
    expect(stats).toEqual({
      played: 5,
      won: 1,
      lost: 1,
      drawn: 1,
      completed: 1,
      abandoned: 1,
      totalElapsedMs: 5,
      lastPlayedAt: 5,
    });
  });

  it('discards corrupt stats and starts again', async () => {
    const { backend, notices, player } = setup();
    backend.poke('stats', `${PLAYER}/nim`, { version: 1, writtenAt: 1, value: { ...EMPTY_STATS, won: -3 } });
    expect(await player.stats.get('nim')).toEqual(ok(EMPTY_STATS));
    expect(notices[0]?.code).toBe('RecordDiscarded');
  });
});

describe('streaks', () => {
  it('stores a streak per game', async () => {
    const { player } = setup();
    expect(await player.streaks.get('daily-word')).toEqual(ok(EMPTY_STREAK));
    await player.streaks.set('daily-word', { current: 3, best: 5, lastDay: '2026-10-08' });
    expect(await player.streaks.get('daily-word')).toEqual(ok({ current: 3, best: 5, lastDay: '2026-10-08' }));
  });

  it('refuses an impossible streak', async () => {
    const { player } = setup();
    const result = await player.streaks.set('daily-word', { current: 6, best: 5, lastDay: null });
    expect(result.ok || result.error.code).toBe('InvalidValue');
  });
});

describe('preferences', () => {
  it('defaults until changed, then notifies subscribers', async () => {
    const { player } = setup();
    expect(await player.preferences.get()).toEqual(ok(DEFAULT_PREFERENCES));
    const seen: StoredPreferences[] = [];
    const unsubscribe = player.preferences.subscribe((p) => seen.push(p));
    await player.preferences.update({ sound: false, theme: 'dark' });
    unsubscribe();
    unsubscribe();
    await player.preferences.update({ singleKeyShortcuts: false });
    expect(seen).toEqual([{ ...DEFAULT_PREFERENCES, sound: false, theme: 'dark' }]);
    expect(await player.preferences.get()).toEqual(
      ok({ ...DEFAULT_PREFERENCES, sound: false, theme: 'dark', singleKeyShortcuts: false }),
    );
  });

  it('tells the other tabs, which read the change back from storage (gp-d4v)', async () => {
    // Two storages over one backend, each with its own feed on one hub, stand for two tabs.
    const backend = createMemoryBackend();
    const hub = createMemoryChangeHub();
    const tabA = openStorage({ backend, changes: hub.feed() }).player(PLAYER);
    const tabB = openStorage({ backend, changes: hub.feed() }).player(PLAYER);
    const heardA: [StoredPreferences, PreferencesSource][] = [];
    const heardB = new Promise<[StoredPreferences, PreferencesSource]>((resolve) => {
      tabB.preferences.subscribe((p, source) => resolve([p, source]));
    });
    tabA.preferences.subscribe((p, source) => heardA.push([p, source]));
    await tabA.preferences.update({ reducedMotion: 'reduce' });
    const changed = { ...DEFAULT_PREFERENCES, reducedMotion: 'reduce' };
    expect(await heardB).toEqual([changed, 'other-tab']);
    // The tab that made the change hears it once, as its own.
    expect(heardA).toEqual([[changed, 'this-tab']]);
  });

  it('ignores feed messages that aren’t changes for this player', async () => {
    const backend = createMemoryBackend();
    const hub = createMemoryChangeHub();
    const sender = hub.feed();
    const storage = openStorage({ backend, changes: hub.feed() });
    const seen: StoredPreferences[] = [];
    let heard: () => void = () => {};
    storage.player(PLAYER).preferences.subscribe((p) => {
      seen.push(p);
      heard();
    });
    const next = () => new Promise<void>((resolve) => (heard = resolve));
    for (const message of [
      { kind: 'preferences', playerId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
      { kind: 'saves', playerId: PLAYER },
      'hello',
      null,
    ]) {
      sender.publish(message as never);
    }
    // A real change takes longer to handle than a refused one, so after it the rest are done.
    const first = next();
    sender.publish({ kind: 'preferences', playerId: PLAYER });
    await first;
    expect(seen).toEqual([DEFAULT_PREFERENCES]);
    storage.close();
    storage.close();
  });

  it('remembers the AI-content notice once accepted, and reads records written before it existed', async () => {
    const { player } = setup();
    expect(await player.preferences.get()).toEqual(ok(DEFAULT_PREFERENCES));
    await player.preferences.update({ sound: false });
    expect(await player.preferences.get()).toEqual(ok({ ...DEFAULT_PREFERENCES, sound: false }));
    await player.preferences.update({ aiContentAccepted: true });
    expect(await player.preferences.get()).toEqual(
      ok({ ...DEFAULT_PREFERENCES, sound: false, aiContentAccepted: true }),
    );
  });

  it('refuses an out-of-range volume', async () => {
    const { player } = setup();
    const result = await player.preferences.update({ volume: 2 });
    expect(result.ok || result.error.code).toBe('InvalidValue');
  });

  it('resolves system choices against the environment', () => {
    const system = { prefersReducedMotion: true, prefersDark: true, locale: 'en-GB' };
    expect(resolvePreferences(DEFAULT_PREFERENCES, system)).toEqual({
      reducedMotion: true,
      sound: true,
      volume: 0.8,
      colorScheme: 'dark',
      locale: 'en-GB',
      singleKeyShortcuts: true,
    });
    const chosen: StoredPreferences = {
      ...DEFAULT_PREFERENCES,
      reducedMotion: 'no-preference',
      theme: 'light',
      locale: 'fr',
    };
    expect(resolvePreferences(chosen, system)).toMatchObject({
      reducedMotion: false,
      colorScheme: 'light',
      locale: 'fr',
    });
  });
});

describe('game storage (PlatformApi.storage)', () => {
  it('stores JSON per game under free-form keys', async () => {
    const { player } = setup();
    const nimData = player.gameStorage('nim');
    await nimData.set('settings/board', { size: 7, colors: ['red'] });
    expect(await nimData.get('settings/board')).toEqual({ size: 7, colors: ['red'] });
    expect(await player.gameStorage('chess').get('settings/board')).toBeNull();
    await nimData.delete('settings/board');
    expect(await nimData.get('settings/board')).toBeNull();
  });

  it('rejects a failed write with a StorageFailure', async () => {
    const { player } = setup();
    const write = player.gameStorage('nim').set('k', { bad: Number.POSITIVE_INFINITY });
    await expect(write).rejects.toBeInstanceOf(StorageFailure);
    await expect(player.gameStorage('nim').set('', 1)).rejects.toMatchObject({ error: { code: 'InvalidKey' } });
  });
});

describe('openStorage', () => {
  it('refuses a player id that cannot be a key', () => {
    const { storage } = setup();
    expect(() => storage.player('a/b')).toThrow(RangeError);
  });

  it('returns the same player storage for the same id, so subscribers are shared', () => {
    const { storage } = setup();
    expect(storage.player(PLAYER)).toBe(storage.player(PLAYER));
  });
});
