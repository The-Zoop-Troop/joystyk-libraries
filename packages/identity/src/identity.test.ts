import { createMemoryBackend, openStorage, type StorageNotice } from '@joystyk/storage';
import { describe, expect, it } from 'vitest';
import { AVATAR_IDS, createIdentity, isDisplayName, isPlayerId, type PlayerId } from './index.ts';

const IDS = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7'];

const setup = (backend = createMemoryBackend(), ids: readonly string[] = IDS) => {
  const notices: StorageNotice[] = [];
  const storage = openStorage({ backend, onNotice: (n) => notices.push(n), now: () => 1_000 });
  let next = 0;
  let seed = 0.1;
  const identity = createIdentity({
    storage,
    randomUUID: () => ids[next++] ?? 'out-of-ids',
    random: () => (seed = (seed * 9301 + 0.49297) % 1),
    now: () => 1_000,
  });
  return { backend, notices, storage, identity };
};

describe('guest identity', () => {
  it('creates a guest with a generated name and a preset avatar on first use', async () => {
    const { identity } = setup();
    const profile = await identity.current();
    expect(profile.id).toBe(IDS[0]);
    expect(profile.nameSource).toBe('generated');
    expect(isDisplayName(profile.displayName)).toBe(true);
    expect(AVATAR_IDS).toContain(profile.avatar);
    expect(profile.createdAt).toBe(1_000);
  });

  it('keeps the same player id across page loads', async () => {
    const backend = createMemoryBackend();
    const first = await setup(backend).identity.current();
    const again = await setup(backend).identity.current();
    expect(again).toEqual(first);
  });

  it('creates the guest once even when asked twice at the same time', async () => {
    const { identity } = setup();
    const [a, b] = await Promise.all([identity.current(), identity.current()]);
    expect(a).toBe(b);
  });

  it('gives two tabs that start together one guest (gp-d4v)', async () => {
    // Two storages over one backend stand for two tabs; each identity draws its own id.
    const backend = createMemoryBackend();
    const tabA = setup(backend, [IDS[0]!]);
    const tabB = setup(backend, [IDS[1]!]);
    const [a, b] = await Promise.all([tabA.identity.current(), tabB.identity.current()]);
    expect(b).toEqual(a);
    expect(await setup(backend).identity.current()).toEqual(a);
  });

  it('renames through the filter', async () => {
    const { backend, identity } = setup();
    const renamed = await identity.rename('  Ada   Byte ');
    expect(renamed.ok && renamed.value).toMatchObject({ displayName: 'Ada Byte', nameSource: 'chosen' });
    const refused = await identity.rename('Big Ass');
    expect(refused.ok || refused.error.code).toBe('NotAllowed');
    expect((await setup(backend).identity.current()).displayName).toBe('Ada Byte');
  });

  it('rolls a fresh generated name', async () => {
    const { identity } = setup();
    await identity.rename('Ada Byte');
    const rolled = await identity.rollName();
    expect(rolled.ok && rolled.value.nameSource).toBe('generated');
    expect(rolled.ok && isDisplayName(rolled.value.displayName)).toBe(true);
  });

  it('accepts only preset avatars', async () => {
    const { identity } = setup();
    const set = await identity.setAvatar('robot');
    expect(set.ok && set.value.avatar).toBe('robot');
    const refused = await identity.setAvatar('https://example.com/me.png');
    expect(refused.ok || refused.error.code).toBe('UnknownAvatar');
  });

  it('keys player data on the player id', async () => {
    const { identity, storage } = setup();
    const { id } = await identity.current();
    await storage.player(id).preferences.update({ sound: false });
    expect(await storage.player(id).preferences.get()).toMatchObject({ ok: true, value: { sound: false } });
  });

  it('gives a corrupt profile a fresh name but keeps the player id', async () => {
    const backend = createMemoryBackend();
    const { id } = await setup(backend).identity.current();
    backend.poke('identity', `player/${id}`, {
      version: 1,
      writtenAt: 1,
      value: { id, displayName: 'Big Ass', nameSource: 'chosen', avatar: 'fox', createdAt: 1 },
    });
    const { identity, notices } = setup(backend);
    const profile = await identity.current();
    expect(profile.id).toBe(id);
    expect(profile.nameSource).toBe('generated');
    expect(notices).toMatchObject([{ code: 'RecordDiscarded', key: `player/${id}` }]);
  });

  it('starts a new guest when the device record is corrupt', async () => {
    const backend = createMemoryBackend();
    backend.poke('identity', 'device', { version: 1, writtenAt: 1, value: { playerId: 'not-a-uuid' } });
    const { identity, notices } = setup(backend);
    expect((await identity.current()).id).toBe(IDS[0]);
    expect(notices[0]?.code).toBe('RecordDiscarded');
  });

  it('refuses a randomUUID that does not return a UUID', async () => {
    const storage = openStorage({ backend: createMemoryBackend() });
    const identity = createIdentity({ storage, randomUUID: () => 'device-123', random: () => 0 });
    await expect(identity.current()).rejects.toThrow(TypeError);
  });
});

describe('isPlayerId', () => {
  it('accepts lowercase UUIDs only', () => {
    expect(isPlayerId(IDS[0])).toBe(true);
    expect(isPlayerId(IDS[0]?.toUpperCase())).toBe(false);
    expect(isPlayerId('device-123')).toBe(false);
    const id: PlayerId | null = isPlayerId(IDS[1]) ? IDS[1] : null;
    expect(id).not.toBeNull();
  });
});
