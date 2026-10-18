// Catalog entries for the catalog's own tests: a coming-soon dice game, featured, for two to
// eight players, and a coming-soon card game with an AI level. Real games register through the
// app (apps/site/src/games.ts); these exist only so the registry, SEO and page tests have two
// categories to work with.
import { defineManifest } from '@joystyk/contracts';
import { defineEntry, type CatalogEntry } from './registry.ts';

export const testDice = defineEntry({
  manifest: defineManifest({
    id: 'test-dice',
    name: 'Test Dice',
    summary: 'A test dice game for two to eight players.',
    category: 'dice',
    tags: ['push-your-luck', 'party'],
    modes: ['pass-and-play', 'server'],
    players: { min: 2, max: 8 },
    ai: null,
    layers: { engine: true, simulation: false },
    privateState: false,
    handoff: false,
    essentialMotion: false,
    access: 'free',
    versions: { build: '0.0.0', rules: 1, save: 1, minProtocol: 1 },
    undo: 'none',
    clock: { default: 60, presets: [30, 60, 120] },
    assets: '/games/test-dice/manifest.json',
  }),
  listing: {
    status: 'coming-soon',
    placeholder: true,
    featured: true,
    description: 'Test Dice exists only in the catalog tests.',
    rules: ['Throw the dice.', 'Bank or throw again.'],
  },
});

export const testCards = defineEntry({
  manifest: defineManifest({
    id: 'test-cards',
    name: 'Test Cards',
    pageTitle: 'Test Cards Showdown',
    summary: 'A test card game for up to five, with computer opponents.',
    category: 'cards',
    tags: ['betting', 'push-your-luck'],
    modes: ['ai', 'pass-and-play', 'server'],
    players: { min: 1, max: 5 },
    ai: { levels: ['standard'] },
    layers: { engine: true, simulation: false },
    privateState: true,
    handoff: true,
    essentialMotion: false,
    access: 'free',
    versions: { build: '0.0.0', rules: 1, save: 1, minProtocol: 1 },
    undo: 'none',
    clock: { default: 45, presets: [30, 45, 90] },
    assets: '/games/test-cards/manifest.json',
  }),
  listing: {
    status: 'coming-soon',
    placeholder: true,
    featured: false,
    description: 'Test Cards exists only in the catalog tests.',
    rules: ['Ante.', 'Draw or stand.', 'Bet.', 'Reveal.'],
  },
});

/** What the catalog tests register: the two test-only games. */
export const TEST_ENTRIES: readonly CatalogEntry[] = [testDice, testCards];
