import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, type StandardSchemaV1 } from '@joystyk/contracts';
import * as z from 'zod';
import { afterEach, expect, it } from 'vitest';
import { withDailyBank } from './banks.ts';
import { defaultFilter } from './filter.ts';
import { runPackPipeline, type PackGenerator } from './packs.ts';
import { runPipeline, type DailyGenerator } from './pipeline.ts';
import { openStore } from './store.ts';

const schema = z.object({ puzzleId: z.string(), word: z.string() }) as StandardSchemaV1<
  unknown,
  { puzzleId: string; word: string }
>;
const generator: DailyGenerator = {
  gameId: 'demo',
  promptVersion: 'test',
  configSchema: schema,
  schedule: ({ puzzleId }) => ({ inputs: null, seed: puzzleId, answer: null }),
  generate: async () => err({ kind: 'rejected', issues: ['offline'] }),
  validate: () => [],
  texts: () => [],
  answerOf: (config) => (config as { word: string }).word,
  bank: { size: 2, config: (index, puzzleId) => ({ puzzleId, word: `${['apple', 'pear'][index]}-${puzzleId}` }) },
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('keeps original bank keys and date-dependent configurations after retirement', () => {
  const store = openStore(':memory:');
  try {
    store.changeBank({ gameId: 'demo', key: 'base:0', config: null, retired: true, actor: 'staff', now: 0 });
    const wrapped = withDailyBank(store, generator);
    expect(wrapped.bank.size).toBe(1);
    expect(wrapped.bank.config(0, 'demo:2026-10-11')).toEqual({
      puzzleId: 'demo:2026-10-11',
      word: 'pear-demo:2026-10-11',
    });
    expect(wrapped.bank.config(0, 'demo:2026-10-12')).toEqual({
      puzzleId: 'demo:2026-10-12',
      word: 'pear-demo:2026-10-12',
    });
  } finally {
    store.close();
  }
});

it('uses persistent staff banks in the next daily and pack pipeline runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'content-banks-'));
  dirs.push(dir);
  const path = join(dir, 'content.db');
  let store = openStore(path);
  for (const key of ['base:0', 'base:1'])
    store.changeBank({ gameId: 'demo', key, config: null, retired: true, actor: 'staff', now: 0 });
  store.changeBank({
    gameId: 'demo',
    key: 'staff:reviewed',
    config: { puzzleId: 'old', word: 'grape' },
    retired: false,
    actor: 'staff',
    now: 0,
  });
  const pack: PackGenerator = {
    gameId: 'packs',
    promptVersion: 'test',
    configSchema: schema,
    slots: () => [{ slug: 'fruit', inputs: null }],
    generate: async () => err({ kind: 'rejected', issues: ['offline'] }),
    validate: () => [],
    texts: () => [],
    bank: () => ({ puzzleId: 'packs:pack:fruit', word: 'apple' }),
  };
  store.changeBank({
    gameId: 'packs',
    key: 'pack:fruit',
    config: { puzzleId: 'packs:pack:fruit', word: 'pear' },
    retired: false,
    actor: 'staff',
    now: 0,
  });
  store.close();
  store = openStore(path);
  try {
    const common = {
      store,
      model: null,
      filter: defaultFilter(),
      publisher: null,
      now: () => Date.parse('2026-10-11T12:00:00Z'),
    };
    await runPipeline({ ...common, generators: [generator], dates: ['2026-10-11'] });
    expect(store.current('demo:2026-10-11')).toMatchObject({
      source: 'bank',
      config: { puzzleId: 'demo:2026-10-11', word: 'grape' },
    });
    await runPackPipeline({ ...common, generators: [pack] });
    expect(store.current('packs:pack:fruit')).toMatchObject({ source: 'bank', config: { word: 'pear' } });
    store.withdraw('packs:pack:fruit', 'other', 'staff', 1);
    store.changeBank({ gameId: 'packs', key: 'pack:fruit', config: null, retired: true, actor: 'staff', now: 2 });
    await runPackPipeline({ ...common, generators: [pack] });
    expect(store.current('packs:pack:fruit')?.status).not.toBe('validated');
    expect(store.current('packs:pack:fruit')?.source).not.toBe('bank');
  } finally {
    store.close();
  }
});
