import { describe, expect, it } from 'vitest';
import { nim, pinOf, policy, testRng } from '../__tests__/fixtures.ts';
import { createEngineRegistry, type RegisteredEngine } from './registry.ts';

describe('rules-pinned engine and worker registration', () => {
  it.each([false, true])('selects the newest engine independently of registration order (reversed: %s)', (reversed) => {
    const old = new URL('file:///jobs/nim-v1.mjs');
    const current = new URL('file:///jobs/nim-v2.mjs');
    const entries: readonly RegisteredEngine[] = [
      { pin: pinOf('nim', 1), engine: nim, policy: policy(), jobs: { ai: old, retired: old } },
      { pin: pinOf('nim', 2), engine: { ...nim, rulesVersion: 2 }, policy: policy(), jobs: { ai: current } },
    ];
    const registry = createEngineRegistry(reversed ? entries.toReversed() : entries, testRng);
    expect(registry.games()).toEqual(['nim']);
    expect(registry.current('nim')?.pin.rulesVersion).toBe(2);
    expect(registry.core('nim', 1)?.pin.rulesVersion).toBe(1);
    expect(registry.core('nim', 2)?.pin.rulesVersion).toBe(2);
    expect(registry.jobModule('nim', 'ai', 1)).toBe(old);
    expect(registry.jobModule('nim', 'ai', 2)).toBe(current);
    expect(registry.jobModule('nim', 'ai')).toBe(current);
    expect(registry.jobModule('nim', 'retired')).toBeNull();
    expect(registry.jobModule('nim', 'ai', 3)).toBeNull();
    expect(registry.jobModule('missing', 'ai')).toBeNull();
  });
});
