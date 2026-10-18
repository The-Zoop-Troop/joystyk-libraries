// PLACEHOLDER ENTRIES: games whose page should exist before their code does.
//
// Each entry uses the game's real id, name and category from its rules spec
// (docs/product-specs/games/), so URLs stay stable, but the versions are 0.0.0, the asset
// lists don't exist, and the copy is a short summary rather than the shipped rules. When a
// game lands in games/<id>/, its entry.ts exports the real manifest and the site registers
// that instead; delete the matching entry here in the same change. Shift 23, the last one,
// landed in games/shift-23.
import type { CatalogEntry } from './registry.ts';

/** Every placeholder, in the order the site registers them. */
export const PLACEHOLDER_ENTRIES: readonly CatalogEntry[] = [];
