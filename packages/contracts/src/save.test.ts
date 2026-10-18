import { describe, expect, it } from 'vitest';
import { err, gameError, ok, runMigrations, type Json, type Migration } from './index.ts';

// Save v1 was { score }, v2 renamed it to { points }, v3 added { level: 1 }.
const v1to2: Migration = {
  from: 1,
  to: 2,
  migrate: (old) => {
    const { score } = old as { score: number };
    return ok({ points: score });
  },
};
const v2to3: Migration = {
  from: 2,
  to: 3,
  migrate: (old) => ok({ ...(old as { [key: string]: Json }), level: 1 }),
};

describe('runMigrations', () => {
  it('runs every step from the saved version to the current one, in order', () => {
    // Listed out of order on purpose: the chain is found by version, not position.
    expect(runMigrations([v2to3, v1to2], { score: 7 }, 1, 3)).toEqual(ok({ points: 7, level: 1 }));
  });

  it('returns current saves unchanged', () => {
    expect(runMigrations([v1to2, v2to3], { points: 7, level: 1 }, 3, 3)).toEqual(ok({ points: 7, level: 1 }));
  });

  it('refuses a save from a newer build', () => {
    const result = runMigrations([v1to2], { points: 1 }, 4, 3);
    expect(!result.ok && result.error.code).toBe('SaveFromFuture');
  });

  it('refuses when a step is missing', () => {
    const result = runMigrations([v2to3], { score: 7 }, 1, 3);
    expect(result).toEqual(
      err(gameError('MigrationMissing', 'This saved game can no longer be opened.', { from: 1, to: 2 })),
    );
  });

  it('ignores a step that skips a version', () => {
    const skip: Migration = { from: 1, to: 3, migrate: (old) => ok(old) };
    expect(runMigrations([skip], {}, 1, 3).ok).toBe(false);
  });

  it("stops at a failing step and returns that step's error", () => {
    const broken: Migration = { from: 2, to: 3, migrate: () => err(gameError('Corrupt', 'The save is damaged.')) };
    expect(runMigrations([v1to2, broken], { score: 1 }, 1, 3)).toEqual(
      err(gameError('Corrupt', 'The save is damaged.')),
    );
  });
});
