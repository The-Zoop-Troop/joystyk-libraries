import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type StandardSchemaV1 } from '@joystyk/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { defaultFilter } from './filter.ts';
import { contentHash } from './hash.ts';
import type { CallInfo, ModelClient, ModelErrorKind } from './model.ts';
import {
  createPackPublisher,
  packItemId,
  runPackPipeline,
  withdrawPack,
  type PackGenerator,
  type PackIndex,
  type PackPipelineOptions,
} from './packs.ts';
import { openStore, type ContentStore } from './store.ts';

// A toy game: a theme's pack of words, each with a clue the model writes.
type DemoPack = { theme: string; words: { word: string; clue: string }[] };
const demoSchema = z.object({
  theme: z.string(),
  words: z.array(z.object({ word: z.string(), clue: z.string().max(60) })).min(2),
});
const draftSchema = z.object({ words: z.array(z.object({ word: z.string(), clue: z.string() })) });

const demoGenerator = (bank = true): PackGenerator<DemoPack, { theme: string }> => ({
  gameId: 'demo-game',
  promptVersion: 'demo-v1',
  configSchema: demoSchema as unknown as StandardSchemaV1<unknown, DemoPack>,
  slots: () => [
    { slug: 'fruit', inputs: { theme: 'fruit' } },
    { slug: 'trees', inputs: { theme: 'trees' } },
  ],
  generate: async ({ inputs, model, feedback, signal }) => {
    const result = await model.complete({
      name: 'pack',
      schema: draftSchema,
      messages: [{ role: 'user', content: `${inputs.theme}|${feedback.join(';')}` }],
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) return err({ kind: 'model', error: result.error });
    return ok({ theme: inputs.theme, words: result.value.value.words });
  },
  validate: (config) =>
    config.words.flatMap((w) =>
      w.clue.toLowerCase().includes(w.word) ? [`The clue for ${w.word} gives it away.`] : [],
    ),
  texts: (config) => config.words.map((w, i) => ({ path: `words.${String(i)}.clue`, text: w.clue })),
  bank: (slot) =>
    bank
      ? {
          theme: slot.inputs.theme,
          words: [
            { word: 'apple', clue: 'A bank clue.' },
            { word: 'pear', clue: 'Another bank clue.' },
          ],
        }
      : null,
});

type Script = (request: {
  name: string;
  user: string;
}) => { words?: { word: string; clue: string }[]; safe?: boolean } | ModelErrorKind;

const fakeModel = (script: Script) => {
  const calls: { name: string; user: string }[] = [];
  const info = (name: string): CallInfo => ({
    name,
    latencyMs: 5,
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    requests: 1,
    mode: 'json_schema',
    finishReason: 'stop',
  });
  const model: ModelClient = {
    model: 'fake-model',
    complete: async (request) => {
      const user = request.messages.at(-1)?.content ?? '';
      calls.push({ name: request.name, user });
      const outcome = script({ name: request.name, user });
      if (typeof outcome === 'string')
        return err({ kind: outcome, message: `fake ${outcome}`, call: info(request.name) });
      const value =
        request.name === 'safety_screen'
          ? { safe: outcome.safe ?? true, reasons: outcome.safe === false ? ['Too gloomy.'] : [] }
          : {
              words: outcome.words ?? [
                { word: 'plum', clue: 'A purple fruit.' },
                { word: 'fig', clue: 'A sweet soft fruit.' },
              ],
            };
      const decoded = await request.schema['~standard'].validate(value);
      if (decoded.issues !== undefined)
        return err({
          kind: 'schema',
          message: 'bad',
          issues: decoded.issues.map((i) => i.message),
          call: info(request.name),
        });
      return ok({ value: decoded.value, call: info(request.name) });
    },
  };
  return { model, calls };
};

const NOW = Date.UTC(2026, 9, 8, 0, 5);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'packs-'));
  dirs.push(dir);
  return { dir, store: openStore(join(dir, 'content.db')), publisher: createPackPublisher(join(dir, 'published')) };
};

const run = (
  store: ContentStore,
  model: ModelClient | null,
  extra: Partial<PackPipelineOptions> = {},
  generator = demoGenerator(),
) =>
  runPackPipeline({
    store,
    generators: [generator as unknown as PackGenerator],
    model,
    filter: defaultFilter(),
    publisher: null,
    now: () => NOW,
    backoffMs: 0,
    ...extra,
  });

const readIndex = (dir: string): PackIndex =>
  JSON.parse(readFileSync(join(dir, 'published/demo-game/packs/index.json'), 'utf8')) as PackIndex;

describe('runPackPipeline', () => {
  it('generates, checks and publishes a pack per slot, with an index the site serves', async () => {
    const { dir, store, publisher } = setup();
    const { model, calls } = fakeModel(() => ({}));
    const report = await run(store, model, { publisher });
    expect(report.status).toBe('ok');
    expect(report.slots.map((s) => [s.slug, s.action, s.source])).toEqual([
      ['fruit', 'generated', 'generated'],
      ['trees', 'generated', 'generated'],
    ]);
    expect(calls.map((c) => c.name)).toEqual(['pack', 'safety_screen', 'pack', 'safety_screen']);
    const index = readIndex(dir);
    expect(index).toMatchObject({ schemaVersion: 1, gameId: 'demo-game' });
    expect(index.packs.map((p) => p.slug)).toEqual(['fruit', 'trees']);
    for (const entry of index.packs) {
      const body = readFileSync(join(dir, `published/demo-game/packs/${entry.slug}.${entry.hash}.json`), 'utf8');
      expect(Buffer.byteLength(body)).toBe(entry.size);
      const file = JSON.parse(body) as { itemId: string; contentHash: string; config: DemoPack };
      expect(file.itemId).toBe(packItemId('demo-game', entry.slug));
      expect(contentHash(file.config)).toBe(entry.hash);
      expect(file.contentHash).toBe(entry.hash);
    }
    // A second run finds every slot filled and asks the model nothing.
    const again = await run(store, model, { publisher });
    expect(again.slots.map((s) => s.action)).toEqual(['existing', 'existing']);
    expect(calls).toHaveLength(4);
    store.close();
  });

  it("retries with the validators' feedback, then falls back to the bank pack", async () => {
    const { dir, store, publisher } = setup();
    const { model, calls } = fakeModel((request) =>
      request.name === 'pack'
        ? {
            words: [
              { word: 'plum', clue: 'A plum is purple.' },
              { word: 'fig', clue: 'Soft.' },
            ],
          }
        : {},
    );
    const report = await run(store, model, { publisher, slugs: ['fruit'] });
    expect(report.slots[0]).toMatchObject({ action: 'bank', source: 'bank', status: 'validated' });
    expect(report.slots[0]?.attempts.map((a) => a.outcome)).toEqual(['invalid', 'invalid', 'invalid']);
    expect(calls[1]?.user).toContain('The clue for plum gives it away.');
    expect(readIndex(dir).packs.map((p) => p.slug)).toEqual(['fruit']);
    store.close();
  });

  it('replaces a bank pack with a generated one once the model works again', async () => {
    const { dir, store, publisher } = setup();
    const down = fakeModel(() => 'http');
    const first = await run(store, down.model, { publisher });
    expect(first.slots.map((s) => s.action)).toEqual(['bank', 'bank']);
    const bankHash = readIndex(dir).packs[0]?.hash;
    const up = fakeModel(() => ({}));
    const second = await run(store, up.model, { publisher });
    expect(second.slots.map((s) => s.action)).toEqual(['replaced-bank', 'replaced-bank']);
    const index = readIndex(dir);
    expect(index.packs[0]?.hash).not.toBe(bankHash);
    // The bank pack's file stays for games already dealt from it.
    expect(existsSync(join(dir, `published/demo-game/packs/fruit.${bankHash ?? ''}.json`))).toBe(true);
    const history = store.history(packItemId('demo-game', 'fruit'));
    expect(history.map((row) => [row.source, row.status, row.withdrawnBy])).toEqual([
      ['bank', 'withdrawn', 'content'],
      ['generated', 'published', null],
    ]);
    // A third run keeps the generated pack.
    expect((await run(store, up.model, { publisher })).slots.map((s) => s.action)).toEqual(['existing', 'existing']);
    store.close();
  });

  it('keeps a bank pack when the model is still failing, and fails a slot with no bank', async () => {
    const { store, publisher } = setup();
    const down = fakeModel(() => 'timeout');
    await run(store, down.model, { publisher });
    const kept = await run(store, down.model, { publisher });
    expect(kept.slots.map((s) => [s.action, s.source])).toEqual([
      ['existing', 'bank'],
      ['existing', 'bank'],
    ]);
    const other = setup();
    const failed = await run(other.store, down.model, { publisher: other.publisher }, demoGenerator(false));
    expect(failed.status).toBe('failed');
    expect(failed.slots.map((s) => s.action)).toEqual(['failed', 'failed']);
    store.close();
    other.store.close();
  });

  it('fails a slot instead of publishing its bank pack when the bank fallback is off', async () => {
    const { store } = setup();
    const report = await run(store, fakeModel(() => 'timeout').model, { bankFallback: false, slugs: ['fruit'] });
    expect(report.slots.map((s) => [s.action, s.source, s.config])).toEqual([['failed', null, null]]);
    store.close();
  });

  it('refuses what the model screen calls unsafe, and what the word lists catch', async () => {
    const { store } = setup();
    const unsafe = fakeModel((request) => (request.name === 'safety_screen' ? { safe: false } : {}));
    const screened = await run(store, unsafe.model, { slugs: ['fruit'] }, demoGenerator(false));
    expect(screened.slots[0]?.attempts.map((a) => a.outcome)).toEqual(['screened', 'screened', 'screened']);
    const other = setup();
    const listed = fakeModel(() => ({
      words: [
        { word: 'plum', clue: 'Found near a graveyard.' },
        { word: 'fig', clue: 'Soft.' },
      ],
    }));
    const filtered = await run(other.store, listed.model, { slugs: ['fruit'] }, demoGenerator(false));
    expect(filtered.slots[0]?.attempts[0]?.outcome).toBe('filtered');
    store.close();
    other.store.close();
  });

  it('opens the circuit breaker after five endpoint errors in a row', async () => {
    const { store } = setup();
    const down = fakeModel(() => 'network');
    const report = await run(store, down.model, { breakerThreshold: 5 });
    expect(report.breakerOpen).toBe(true);
    expect(down.calls).toHaveLength(5);
    store.close();
  });

  it('takes a pack down: the index drops it and the next run fills the slot again', async () => {
    const { dir, store, publisher } = setup();
    const { model } = fakeModel(() => ({}));
    await run(store, model, { publisher });
    const row = withdrawPack({
      store,
      publisher,
      gameId: 'demo-game',
      slug: 'trees',
      reason: 'unfair',
      actor: 'staff@example.test',
      now: NOW,
    });
    expect(row?.status).toBe('withdrawn');
    expect(readIndex(dir).packs.map((p) => p.slug)).toEqual(['fruit']);
    const refill = await run(store, model, { publisher });
    expect(refill.slots.map((s) => s.action)).toEqual(['existing', 'generated']);
    expect(readIndex(dir).packs.map((p) => p.slug)).toEqual(['fruit', 'trees']);
    store.close();
  });

  it('writes nothing on a dry run, and publishes bank packs with no model', async () => {
    const { dir, store } = setup();
    const { model } = fakeModel(() => ({}));
    await run(store, model, { publisher: null });
    expect(existsSync(join(dir, 'published'))).toBe(false);
    const other = setup();
    const offline = await run(other.store, null, { publisher: other.publisher });
    expect(offline.slots.map((s) => s.action)).toEqual(['bank', 'bank']);
    expect(readIndex(other.dir).packs).toHaveLength(2);
    store.close();
    other.store.close();
  });
});
