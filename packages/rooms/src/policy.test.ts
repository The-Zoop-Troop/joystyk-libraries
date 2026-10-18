// A room's policy from a manifest: seat counts come from `players`, and nothing else in it.
import { defineManifest } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { policyFromManifest, policyProblem } from './policy.ts';

const table = defineManifest({
  id: 'test-table',
  name: 'Test Table',
  summary: 'A card table for up to five.',
  category: 'cards',
  tags: [],
  modes: ['ai', 'server'],
  players: { min: 1, max: 5, default: 5 },
  ai: { levels: ['standard'] },
  layers: { engine: true, simulation: false },
  privateState: true,
  handoff: true,
  essentialMotion: false,
  access: 'free',
  versions: { build: '0.0.1', rules: 1, save: 1, minProtocol: 1 },
  undo: 'none',
  clock: null,
  assets: '/games/test-table/manifest.json',
});

describe('policyFromManifest', () => {
  it('ignores the default player count: the lobby’s filled seats are the table (D-58)', () => {
    const policy = policyFromManifest(table);
    expect(policy.seats).toEqual({ min: 1, max: 5 });
    expect(policyFromManifest({ ...table, players: { min: 1, max: 5 } })).toEqual(policy);
    expect(policyProblem(policy)).toBeNull();
  });
});
