// The persistent-storage helpers against fake storage managers; the browser test asks real Chromium.
import { describe, expect, it, vi } from 'vitest';
import { estimateStorage, isStoragePersisted, requestPersistentStorage, type StorageManagerLike } from './persist.ts';

describe('requestPersistentStorage', () => {
  it('asks when not yet persisted', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persist, persisted: async () => false })).toBe('persisted');
    expect(persist).toHaveBeenCalledOnce();
  });

  it("doesn't ask again when already persisted", async () => {
    const persist = vi.fn(async () => true);
    expect(await requestPersistentStorage({ persist, persisted: async () => true })).toBe('persisted');
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports a refusal', async () => {
    expect(await requestPersistentStorage({ persist: async () => false })).toBe('denied');
  });

  it('reports missing or throwing APIs as unsupported', async () => {
    expect(await requestPersistentStorage(undefined)).toBe('unsupported');
    expect(await requestPersistentStorage({})).toBe('unsupported');
    const throwing: StorageManagerLike = { persist: () => Promise.reject(new Error('nope')) };
    expect(await requestPersistentStorage(throwing)).toBe('unsupported');
  });
});

describe('isStoragePersisted and estimateStorage', () => {
  it('read without asking', async () => {
    expect(await isStoragePersisted({ persisted: async () => false })).toBe('denied');
    expect(await isStoragePersisted({})).toBe('unsupported');
    expect(await estimateStorage({ estimate: async () => ({ usage: 10, quota: 100 }) })).toEqual({
      usage: 10,
      quota: 100,
    });
    expect(await estimateStorage({ estimate: async () => ({}) })).toBeNull();
    expect(await estimateStorage(undefined)).toBeNull();
  });
});
