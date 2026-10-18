import { isJson } from '@joystyk/contracts';
import { describe, expect, it } from 'vitest';
import { CATEGORIES } from './categories.ts';
import { PLACEHOLDER_ENTRIES } from './placeholders.ts';
import { TEST_ENTRIES, testDice } from './fixtures.test-util.ts';
import { RegistryError, createRegistry, type CatalogEntry } from './registry.ts';
import { GameDetailSchema, GameSummaryListSchema } from './wire.ts';

const registry = createRegistry(TEST_ENTRIES);

const withManifest = (overrides: Partial<CatalogEntry['manifest']>): CatalogEntry => ({
  ...testDice,
  manifest: { ...testDice.manifest, ...overrides },
});

describe('the placeholder entries', () => {
  it('are plain JSON, so the index can read them without game code', () => {
    expect([...PLACEHOLDER_ENTRIES, ...TEST_ENTRIES].every((e) => isJson(e.manifest))).toBe(true);
  });

  it('register as placeholders that are coming soon', () => {
    expect(registry.entries.map((e) => e.manifest.id)).toEqual(['test-cards', 'test-dice']);
    expect(registry.entries.every((e) => e.listing.placeholder && e.listing.status === 'coming-soon')).toBe(true);
  });
});

describe('createRegistry', () => {
  it('carries validated creator credits and rejects executable or credentialed links', () => {
    const attribution = { text: 'Original creator and license', href: 'https://example.org/source' };
    expect(createRegistry([withManifest({ attribution })]).detail('test-dice')?.attribution).toEqual(attribution);
    for (const href of ['javascript:alert(1)', 'http://example.org', 'https://secret@example.org']) {
      expect(() => createRegistry([withManifest({ attribution: { ...attribution, href } })])).toThrow(/attribution/);
    }
  });
  it('sorts by name and finds entries by id', () => {
    expect(registry.summaries().map((s) => s.name)).toEqual(['Test Cards', 'Test Dice']);
    expect(registry.find('test-dice')?.manifest.name).toBe('Test Dice');
    expect(registry.find('nope')).toBeUndefined();
  });

  it('builds summaries and details that pass the wire schemas the browser uses', () => {
    expect(GameSummaryListSchema.safeParse(registry.summaries()).success).toBe(true);
    for (const { manifest } of registry.entries) {
      expect(GameDetailSchema.safeParse(registry.detail(manifest.id)).success).toBe(true);
    }
    expect(registry.detail('test-cards')?.aiLevels).toEqual(['standard']);
    expect(registry.detail('test-dice')?.essentialMotion).toBe(false);
  });

  it('groups games by category, listing only categories that have games', () => {
    expect(registry.categories().map((c) => [c.id, c.games])).toEqual([
      ['cards', 1],
      ['dice', 1],
    ]);
    expect(registry.inCategory('dice').map((s) => s.id)).toEqual(['test-dice']);
    expect(registry.inCategory('board')).toEqual([]);
  });

  it('groups games by tag', () => {
    const tags = registry.tags();
    expect(tags.get('push-your-luck')).toEqual(['test-cards', 'test-dice']);
    expect([...tags.keys()]).toEqual([...tags.keys()].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('lists the featured games', () => {
    expect(registry.featured().map((s) => s.id)).toEqual(['test-dice']);
  });

  it('carries a page title to the game page, and only when the manifest has one', () => {
    expect(registry.detail('test-cards')?.pageTitle).toBe('Test Cards Showdown');
    expect(registry.detail('test-dice')).not.toHaveProperty('pageTitle');
    expect(registry.summary('test-cards')).not.toHaveProperty('pageTitle');
  });

  it('rejects a page title that leaves out the display name', () => {
    expect(() => createRegistry([withManifest({ pageTitle: 'Bones' })])).toThrow(
      /pageTitle "Bones" must contain the name "Test Dice"/,
    );
    expect(() => createRegistry([withManifest({ pageTitle: 'Test Dice Deluxe' })])).not.toThrow();
  });

  it('rejects duplicate ids', () => {
    expect(() => createRegistry([testDice, testDice])).toThrow(/two entries share this id/);
  });

  it('rejects every invalid field at once, naming the fix', () => {
    const bad = withManifest({ id: 'Bad_Id', category: 'sports', modes: [], players: { min: 3, max: 2 } });
    let error: unknown;
    try {
      createRegistry([bad]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RegistryError);
    const message = (error as Error).message;
    expect(message).toMatch(/must be kebab-case/);
    expect(message).toMatch(/category "sports" is not in CATEGORIES/);
    expect(message).toMatch(/modes is empty/);
    expect(message).toMatch(/1 <= min <= max/);
  });

  it('carries a default player count from min to max to the wire, and rejects one outside', () => {
    const five = createRegistry([withManifest({ players: { min: 2, max: 8, default: 5 } })]);
    expect(five.detail('test-dice')?.players).toEqual({ min: 2, max: 8, default: 5 });
    expect(GameDetailSchema.parse(five.detail('test-dice')).players.default).toBe(5);
    expect(registry.detail('test-dice')?.players).toEqual({ min: 2, max: 8 });
    expect(() => createRegistry([withManifest({ players: { min: 2, max: 8, default: 2 } })])).not.toThrow();
    expect(() => createRegistry([withManifest({ players: { min: 2, max: 8, default: 8 } })])).not.toThrow();
    for (const preset of [1, 9, 4.5]) {
      expect(() => createRegistry([withManifest({ players: { min: 2, max: 8, default: preset } })])).toThrow(
        `players.default ${String(preset)} must be a whole number from min (2) to max (8), or left out.`,
      );
    }
  });

  it('accepts a custom category list', () => {
    const only = createRegistry(
      [testDice],
      CATEGORIES.filter((c) => c.id === 'dice'),
    );
    expect(only.categories().map((c) => c.id)).toEqual(['dice']);
    expect(() => createRegistry([testDice], [])).toThrow(RegistryError);
  });
});
