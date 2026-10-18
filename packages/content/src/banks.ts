import type { Json } from '@joystyk/contracts';
import type { DailyGenerator } from './pipeline.ts';
import type { PackGenerator } from './packs.ts';
import type { BankChange, ContentStore } from './store.ts';

export interface BankEntry {
  readonly key: string;
  readonly config: Json;
  readonly retired: boolean;
  readonly custom: boolean;
}
const dated = (config: Json, puzzleId: string): Json =>
  typeof config === 'object' && config !== null && !Array.isArray(config) && 'puzzleId' in config
    ? { ...config, puzzleId }
    : config;

/** Stable keys keep retirement and edits attached to the original item, never its array rank. */
export function dailyBankEntries(
  generator: DailyGenerator,
  changes: readonly BankChange[],
  puzzleId: string,
): BankEntry[] {
  const byKey = new Map(changes.map((change) => [change.key, change]));
  return [
    ...Array.from({ length: generator.bank.size }, (_, index) => {
      const key = `base:${index}`;
      const change = byKey.get(key);
      return {
        key,
        config: dated(change?.config ?? generator.bank.config(index, puzzleId), puzzleId),
        retired: change?.retired ?? false,
        custom: false,
      };
    }),
    ...changes
      .filter((change) => change.key.startsWith('staff:') && change.config !== null)
      .map((change) => ({
        key: change.key,
        config: dated(change.config!, puzzleId),
        retired: change.retired,
        custom: true,
      })),
  ];
}

export function withDailyBank(store: ContentStore, generator: DailyGenerator): DailyGenerator {
  const changes = store.bankChanges(generator.gameId);
  if (changes.length === 0) return generator;
  const byKey = new Map(changes.map((change) => [change.key, change]));
  const keys = [
    ...Array.from({ length: generator.bank.size }, (_, index) => `base:${index}`).filter(
      (key) => byKey.get(key)?.retired !== true,
    ),
    ...changes
      .filter((change) => change.key.startsWith('staff:') && !change.retired && change.config !== null)
      .map((change) => change.key),
  ];
  return {
    ...generator,
    bank: {
      size: keys.length,
      config: (index, puzzleId) => {
        const key = keys[index]!;
        const replacement = byKey.get(key)?.config;
        return replacement === undefined || replacement === null
          ? generator.bank.config(Number(key.slice(5)), puzzleId)
          : dated(replacement, puzzleId);
      },
    },
  };
}

export function withPackBank(store: ContentStore, generator: PackGenerator): PackGenerator {
  const changes = new Map(store.bankChanges(generator.gameId).map((change) => [change.key, change]));
  return {
    ...generator,
    bank: (slot, itemId) => {
      const change = changes.get(`pack:${slot.slug}`);
      return change?.retired === true ? null : (change?.config ?? generator.bank(slot, itemId));
    },
  };
}
