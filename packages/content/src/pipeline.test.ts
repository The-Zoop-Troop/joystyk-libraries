import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type StandardSchemaV1 } from '@joystyk/contracts';
import { dailyIndex, decode } from '@joystyk/daily';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { defaultFilter } from './filter.ts';
import { createLogger } from './log.ts';
import type { CallInfo, CompletionFailure, ModelClient, ModelErrorKind } from './model.ts';
import { rebuildIndex, runPipeline, withdrawItem, type DailyGenerator, type PipelineOptions } from './pipeline.ts';
import { createPublisher } from './publish.ts';
import { openStore, type ContentStore } from './store.ts';

// A toy game: one word and a clue per day. The model writes the clue.
type DemoConfig = { puzzleId: string; word: string; clue: string };
const demoSchema = z.object({ puzzleId: z.string(), word: z.string(), clue: z.string().max(60) });
const clueSchema = z.object({ clue: z.string() });
const WORDS = ['apple', 'river', 'cloud', 'maple', 'tiger'];

const demoGenerator: DailyGenerator<DemoConfig, { word: string }> = {
  gameId: 'demo-game',
  promptVersion: 'demo-v1',
  configSchema: demoSchema as unknown as StandardSchemaV1<unknown, DemoConfig>,
  schedule: ({ date, puzzleId, used }) => {
    const usedSet = new Set(used.map((u) => u.answer));
    const start = Number(date.slice(-2));
    const word =
      [...WORDS.slice(start % WORDS.length), ...WORDS.slice(0, start % WORDS.length)].find((w) => !usedSet.has(w)) ??
      'apple';
    return { inputs: { word }, seed: puzzleId, answer: word };
  },
  generate: async ({ inputs, puzzleId, model, feedback, signal }) => {
    const result = await model.complete({
      name: 'clue',
      schema: clueSchema,
      messages: [{ role: 'user', content: `${inputs.word}|${feedback.join(';')}` }],
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) return err({ kind: 'model', error: result.error });
    return ok({ puzzleId, word: inputs.word, clue: result.value.value.clue });
  },
  validate: (config) => (config.clue.toLowerCase().includes(config.word) ? ['The clue gives the answer away.'] : []),
  texts: (config) => [{ path: 'clue', text: config.clue }],
  answerOf: (config) => config.word,
  bank: {
    size: 2,
    config: (index, puzzleId) => ({ puzzleId, word: ['lemon', 'piano'][index] ?? 'lemon', clue: 'A bank clue.' }),
  },
};

type Script = (request: {
  name: string;
  user: string;
}) => { clue?: string; safe?: boolean; reasons?: string[] } | ModelErrorKind;

/** A fake model client. Each call runs the script; a string is an error of that kind. */
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
      if (request.signal?.aborted === true)
        return err({ kind: 'aborted', message: 'cancelled', call: info(request.name) } as CompletionFailure);
      const outcome = script({ name: request.name, user });
      if (typeof outcome === 'string')
        return err({ kind: outcome, message: `fake ${outcome}`, call: info(request.name) });
      const value =
        request.name === 'safety_screen'
          ? { safe: outcome.safe ?? true, reasons: outcome.reasons ?? [] }
          : { clue: outcome.clue ?? 'A sweet red fruit.' };
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

const NOW = Date.UTC(2026, 9, 8, 0, 5); // 2026-10-08 00:05 UTC
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
  dirs.push(dir);
  const store = openStore(join(dir, 'content.db'));
  const publisher = createPublisher(join(dir, 'daily'));
  return { dir, store, publisher };
};

const run = (store: ContentStore, model: ModelClient | null, extra: Partial<PipelineOptions> = {}) =>
  runPipeline({
    store,
    generators: [demoGenerator as unknown as DailyGenerator],
    model,
    filter: defaultFilter(),
    publisher: null,
    now: () => NOW,
    backoffMs: 0,
    ...extra,
  });

const readIndex = async (dir: string) => {
  const decoded = await decode(dailyIndex, JSON.parse(readFileSync(join(dir, 'daily/demo-game/index.json'), 'utf8')));
  if (!decoded.ok) throw new Error(decoded.error.join('; '));
  return decoded.value;
};

describe('runPipeline', () => {
  it('supplies a requested multi-year answer history while retaining the one-year default', async () => {
    const { store } = setup();
    const computed: DailyGenerator<DemoConfig, { word: string }> = {
      ...demoGenerator,
      modelFree: true,
      texts: () => [],
      generate: async ({ puzzleId, inputs }) => ok({ puzzleId, word: inputs.word, clue: 'Computed configuration.' }),
    };
    try {
      const old = await run(store, null, {
        generators: [computed as unknown as DailyGenerator],
        dates: ['2022-10-08'],
      });
      expect(old.status).toBe('ok');
      const oldAnswer = old.slots[0]?.answer;
      let longHistory: readonly { date: string; answer: string }[] = [];
      const long = {
        ...computed,
        historyDays: 1826,
        schedule: (context: Parameters<typeof computed.schedule>[0]) => {
          longHistory = context.used;
          return computed.schedule(context);
        },
      };
      const current = await run(store, null, {
        generators: [long as unknown as DailyGenerator],
        dates: ['2026-10-08'],
      });
      expect(current.status).toBe('ok');
      expect(longHistory.map((u) => u.answer)).toContain(oldAnswer);
      expect(current.slots[0]?.answer).not.toBe(oldAnswer);
      let defaultHistory: readonly { date: string; answer: string }[] = [];
      const normal = {
        ...computed,
        schedule: (context: Parameters<typeof computed.schedule>[0]) => {
          defaultHistory = context.used;
          return computed.schedule(context);
        },
      };
      expect(
        (await run(store, null, { generators: [normal as unknown as DailyGenerator], dates: ['2026-10-09'] })).status,
      ).toBe('ok');
      expect(defaultHistory.map((u) => u.answer)).not.toContain(oldAnswer);
      expect(defaultHistory.map((u) => u.answer)).toContain(current.slots[0]?.answer);
    } finally {
      store.close();
    }
  });
  it('refuses model-free declarations that expose text, including their bank fallback', async () => {
    const { store } = setup();
    try {
      const generator = {
        ...demoGenerator,
        modelFree: true,
        generate: async ({ puzzleId }: { puzzleId: string }) =>
          ok({ puzzleId, word: 'lemon', clue: 'Unscreened text.' }),
      };
      const report = await run(store, null, {
        dates: ['2026-10-08'],
        generators: [generator as unknown as DailyGenerator],
      });
      expect(report.status).not.toBe('ok');
      expect(store.current('demo-game:2026-10-08')?.status).not.toBe('published');
    } finally {
      store.close();
    }
  });
  it('publishes text-free deterministic configs with no model or model safety call', async () => {
    const { store, publisher } = setup();
    const generator: DailyGenerator<DemoConfig, { word: string }> = {
      ...demoGenerator,
      modelFree: true,
      generate: async ({ puzzleId, inputs }) =>
        ok({ puzzleId, word: inputs.word, clue: 'Fixed rules; no generated text.' }),
      texts: () => [],
    };
    const report = await run(store, null, { publisher, generators: [generator as unknown as DailyGenerator] });
    expect(report.status).toBe('ok');
    expect(report.slots.map((s) => s.action)).toEqual(['generated', 'generated']);
    expect(report.slots.flatMap((s) => s.attempts).every((a) => a.calls.length === 0 && a.screen === null)).toBe(true);
    store.close();
  });
  it('generates, screens and publishes today and tomorrow, and lists them in the index', async () => {
    const { dir, store, publisher } = setup();
    const { model, calls } = fakeModel(() => ({}));
    const report = await run(store, model, { publisher });
    expect(report.status).toBe('ok');
    expect(report.slots.map((s) => [s.date, s.action])).toEqual([
      ['2026-10-08', 'generated'],
      ['2026-10-09', 'generated'],
    ]);
    expect(calls.map((c) => c.name)).toEqual(['clue', 'safety_screen', 'clue', 'safety_screen']);
    expect((await readIndex(dir)).dates.map((d) => d.date)).toEqual(['2026-10-08', '2026-10-09']);
    const row = store.current('demo-game:2026-10-08');
    expect(row).toMatchObject({
      status: 'published',
      source: 'generated',
      model: 'fake-model',
      promptVersion: 'demo-v1',
    });
    expect(store.recentRuns(1)[0]?.status).toBe('ok');
  });

  it('is idempotent: a second run calls no model and changes nothing', async () => {
    const { dir, store, publisher } = setup();
    await run(store, fakeModel(() => ({})).model, { publisher });
    const before = await readIndex(dir);
    const again = fakeModel(() => ({}));
    const report = await run(store, again.model, { publisher });
    expect(again.calls).toEqual([]);
    expect(report.slots.map((s) => s.action)).toEqual(['existing', 'existing']);
    expect(await readIndex(dir)).toEqual(before);
  });

  it.each([
    ['malformed JSON', (): ReturnType<Script> => 'parse', 'reply'],
    ['a schema violation', (): ReturnType<Script> => 'schema', 'schema'],
    ['a timeout', (): ReturnType<Script> => 'timeout', 'endpoint'],
    ['unsafe text', (): ReturnType<Script> => ({ clue: 'A fruit you could steal.' }), 'filtered'],
    ['an answer leak', (): ReturnType<Script> => ({ clue: 'A maple leaf, of course.' }), 'invalid'],
  ] as const)(
    'ends %s in a bank item after three attempts, with the issue fed back',
    async (_name, script, outcome) => {
      const { store, publisher } = setup();
      const { model, calls } = fakeModel((request) => (request.name === 'safety_screen' ? {} : script()));
      const report = await run(store, model, { publisher, dates: ['2026-10-08'] });
      const [slot] = report.slots;
      expect(slot?.action).toBe('bank');
      expect(slot?.attempts.map((a) => a.outcome)).toEqual([outcome, outcome, outcome]);
      expect(store.current('demo-game:2026-10-08')).toMatchObject({
        status: 'published',
        source: 'bank',
        promptVersion: expect.stringMatching(/^bank:/),
      });
      if (outcome !== 'endpoint') expect(calls[1]?.user).toMatch(/\|.+/); // the second prompt carries feedback
    },
  );

  it("keeps a failed slot's scheduled answer reserved after a bank item replaces it", async () => {
    const { store } = setup();
    await run(store, fakeModel(() => 'parse').model, { dates: ['2026-10-08'] });
    const used = store.usedAnswers('demo-game', '2026-10-01', '2026-10-31').map((u) => u.answer);
    expect(store.current('demo-game:2026-10-08')?.source).toBe('bank');
    expect(used).toContain('maple'); // the schedule's word, so the next day doesn't retry it
    expect(used).toContain(store.current('demo-game:2026-10-08')?.answer);
  });

  it("keeps a game's own check results in each attempt's report, passed or not", async () => {
    const { store } = setup();
    let drafts = 0;
    const recordingGenerator: DailyGenerator<DemoConfig, { word: string }> = {
      ...demoGenerator,
      generate: async (context) => {
        drafts += 1;
        context.record?.('facts', { verdict: drafts === 1 ? 'false' : 'true' });
        if (drafts === 1) return err({ kind: 'rejected', issues: ['A fact-checker doubted the clue.'] });
        return demoGenerator.generate(context);
      },
    };
    const report = await run(store, fakeModel(() => ({})).model, {
      dates: ['2026-10-08'],
      generators: [recordingGenerator as unknown as DailyGenerator],
    });
    const attempts = report.slots[0]?.attempts ?? [];
    expect(attempts.map((a) => [a.outcome, a.checks])).toEqual([
      ['rejected', { facts: { verdict: 'false' } }],
      ['validated', { facts: { verdict: 'true' } }],
    ]);
    // The item's stored report, its provenance, keeps them too.
    expect(store.current('demo-game:2026-10-08')?.report).toMatchObject([
      { checks: { facts: { verdict: 'false' } } },
      { checks: { facts: { verdict: 'true' } } },
    ]);
    // A generator that records nothing adds no field.
    const plain = await run(store, fakeModel(() => ({})).model, { dates: ['2026-10-09'] });
    expect(plain.slots[0]?.attempts[0]).not.toHaveProperty('checks');
  });

  it('lets the model screen add a rejection, with its reasons fed back', async () => {
    const { store } = setup();
    let screens = 0;
    const { model, calls } = fakeModel((request) =>
      request.name === 'safety_screen' ? (++screens === 1 ? { safe: false, reasons: ['Too gloomy.'] } : {}) : {},
    );
    const report = await run(store, model, { dates: ['2026-10-08'] });
    expect(report.slots[0]?.attempts.map((a) => a.outcome)).toEqual(['screened', 'validated']);
    expect(calls[2]?.user).toMatch(/Too gloomy/);
  });

  it('opens the circuit breaker after five endpoint errors in a row and stops calling', async () => {
    const { store } = setup();
    const { model, calls } = fakeModel(() => 'network');
    const report = await run(store, model, { dates: ['2026-10-08', '2026-10-09', '2026-10-12'], breakerThreshold: 5 });
    expect(report.breakerOpen).toBe(true);
    expect(calls).toHaveLength(5);
    expect(report.slots.map((s) => s.action)).toEqual(['bank', 'bank', 'deferred']);
  });

  it('withholds the bank until the deadline: a slot more than two days out waits for the next run', async () => {
    const { store } = setup();
    const report = await run(store, fakeModel(() => 'parse').model, { dates: ['2026-10-12'] });
    expect(report.slots[0]).toMatchObject({ action: 'failed', status: 'failed' });
    const later = await run(store, fakeModel(() => ({})).model, { dates: ['2026-10-12'] });
    expect(later.slots[0]?.action).toBe('generated');
  });

  it('publishes only up to tomorrow by default, and later dates when the next run comes', async () => {
    const { dir, store, publisher } = setup();
    await run(store, fakeModel(() => ({})).model, { publisher, daysAhead: 3 });
    expect((await readIndex(dir)).dates.map((d) => d.date)).toEqual(['2026-10-08', '2026-10-09']);
    expect(store.current('demo-game:2026-10-11')?.status).toBe('validated');
    await run(store, null, { publisher, now: () => NOW + 2 * 86_400_000, daysAhead: 0 });
    expect((await readIndex(dir)).dates.map((d) => d.date)).toEqual([
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
  });

  it('stops between items on shutdown and resumes on the next run', async () => {
    const { store } = setup();
    const controller = new AbortController();
    let clues = 0;
    const { model } = fakeModel((request) => {
      if (request.name === 'clue' && ++clues === 2) {
        controller.abort(); // SIGTERM while the second item's call is in flight
        return 'aborted';
      }
      return {};
    });
    const report = await run(store, model, { signal: controller.signal });
    expect(report.status).toBe('aborted');
    expect(report.slots.map((s) => s.action)).toEqual(['generated', 'aborted']);
    expect(store.current('demo-game:2026-10-09')?.status).toBe('scheduled');
    const resumed = await run(store, fakeModel(() => ({})).model);
    expect(resumed.slots.map((s) => s.action)).toEqual(['existing', 'generated']);
  });

  it('takes an item down: the index drops it at once and the next run replaces it with another answer', async () => {
    const { dir, store, publisher } = setup();
    await run(store, fakeModel(() => ({})).model, { publisher });
    const first = store.current('demo-game:2026-10-08');
    const withdrawn = withdrawItem({
      store,
      publisher,
      gameId: 'demo-game',
      date: '2026-10-08',
      reason: 'inaccurate',
      actor: 'staff',
      now: NOW,
    });
    expect(withdrawn?.status).toBe('withdrawn');
    expect((await readIndex(dir)).dates.map((d) => d.date)).toEqual(['2026-10-09']);
    // The old file stays: a game already started on it keeps working (content-pipeline.md, Corrections).
    expect(existsSync(join(dir, `daily/demo-game/2026-10-08.${String(first?.contentHash)}.json`))).toBe(true);
    const report = await run(store, fakeModel(() => ({})).model, { publisher });
    expect(report.slots[0]?.action).toBe('generated');
    const replacement = store.current('demo-game:2026-10-08');
    expect(replacement?.answer).not.toBe(first?.answer);
    expect((await readIndex(dir)).dates.find((d) => d.date === '2026-10-08')?.hash).toBe(replacement?.contentHash);
  });

  it('runs without a model: late slots take bank items', async () => {
    const { store } = setup();
    const report = await run(store, null);
    expect(report.slots.map((s) => s.action)).toEqual(['bank', 'bank']);
    expect(new Set(report.slots.map((s) => s.answer)).size).toBe(2);
  });

  it('leaves a late slot failed, with no bank item, when the bank fallback is off', async () => {
    const { store } = setup();
    const report = await run(store, fakeModel(() => 'timeout').model, { bankFallback: false, breakerThreshold: 99 });
    expect(report.slots.map((s) => [s.action, s.source])).toEqual([
      ['failed', null],
      ['failed', null],
    ]);
    expect(report.slots.every((s) => s.attempts.length === 3)).toBe(true);
    expect((await run(store, null, { bankFallback: false })).slots.map((s) => s.action)).toEqual([
      'deferred',
      'deferred',
    ]);
  });

  it('writes nothing to the published folder on a dry run', async () => {
    const { dir, store } = setup();
    await run(store, fakeModel(() => ({})).model, { publisher: null });
    expect(existsSync(join(dir, 'daily'))).toBe(false);
    expect(store.current('demo-game:2026-10-08')?.status).toBe('validated');
  });

  it('logs no secrets and rebuilds an index on demand', async () => {
    const { dir, store, publisher } = setup();
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line), secrets: ['sk-very-secret'] });
    await run(store, fakeModel(() => ({ clue: 'A sweet red fruit, sk-very-secret.' })).model, { publisher, log });
    expect(lines.join('\n')).not.toContain('sk-very-secret');
    rebuildIndex(store, publisher, 'demo-game', '2026-10-20', { indexBackDays: 3 });
    expect((await readIndex(dir)).dates).toEqual([]);
  });
});

describe('additional daily text repeat rules', () => {
  const generator: DailyGenerator<DemoConfig, { word: string }> = {
    ...demoGenerator,
    repeatWindowDays: 90,
    repeatKeys: (config) => [
      config.clue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim(),
    ],
    answerOf: () => null,
    bank: {
      size: 2,
      config: (index, puzzleId) => ({
        puzzleId,
        word: 'lemon',
        clue: index === 0 ? 'A clue already used!' : 'A fresh different clue.',
      }),
    },
  };
  const prior = (store: ContentStore, date: string, clue = 'A clue already used.') => {
    const puzzleId = `demo-game:${date}`;
    const row = store.createItem({
      gameId: generator.gameId,
      puzzleId,
      date,
      inputs: { word: 'apple' },
      seed: puzzleId,
      answer: null,
      now: NOW,
    });
    store.updateItem(row.id, { config: { puzzleId, word: 'apple', clue }, status: 'published' }, NOW);
    return puzzleId;
  };
  it('rejects repeats in generated drafts and skips fallback repeats, even after withdrawal', async () => {
    const { store } = setup();
    const puzzleId = prior(store, '2026-10-07');
    store.withdraw(puzzleId, 'other', 'test', NOW);
    const fake = fakeModel(() => ({ clue: 'A CLUE ALREADY USED?!' }));
    const report = await run(store, fake.model, { generators: [generator], dates: ['2026-10-08'], screen: false });
    expect(report.slots[0]?.attempts.map((attempt) => attempt.outcome)).toEqual([
      'duplicate',
      'duplicate',
      'duplicate',
    ]);
    expect(report.slots[0]?.action).toBe('bank');
    expect(report.slots[0]?.config).toMatchObject({ clue: 'A fresh different clue.' });
    store.close();
  });
  it('reserves future validated clues in the same window and permits repeats after 90 days', async () => {
    const { store } = setup();
    prior(store, '2026-10-09');
    const fake = fakeModel(() => ({ clue: 'A clue already used!' }));
    const nearby = await run(store, fake.model, { generators: [generator], dates: ['2026-10-08'], screen: false });
    expect(nearby.slots[0]?.attempts[0]?.outcome).toBe('duplicate');
    const distant = await run(store, fake.model, { generators: [generator], dates: ['2027-01-09'], screen: false });
    expect(distant.slots[0]?.action).toBe('generated');
    store.close();
  });
  it('allows a same-date correction to retain clues and fails closed on malformed history', async () => {
    const { store } = setup();
    const puzzleId = prior(store, '2026-10-08');
    store.withdraw(puzzleId, 'other', 'test', NOW);
    const fake = fakeModel(() => ({ clue: 'A clue already used!' }));
    const corrected = await run(store, fake.model, { generators: [generator], dates: ['2026-10-08'], screen: false });
    expect(corrected.slots[0]?.action).toBe('generated');
    const row = store.createItem({
      gameId: generator.gameId,
      puzzleId: 'demo-game:2026-10-10',
      date: '2026-10-10',
      inputs: {},
      seed: 'x',
      answer: null,
      now: NOW,
    });
    store.updateItem(row.id, { config: { wrong: true }, status: 'published' }, NOW);
    await expect(
      run(store, fake.model, { generators: [generator], dates: ['2026-10-11'], screen: false }),
    ).rejects.toThrow('Cannot check repeat history');
    store.close();
  });
});

it('cannot republish an item withdrawn by staff while generation is in flight', async () => {
  const { store, dir } = setup();
  const publisher = createPublisher(join(dir, 'daily'));
  const model = fakeModel(() => ({ clue: 'A safe clue.' })).model;
  const generator: DailyGenerator<DemoConfig, { word: string }> = {
    ...demoGenerator,
    generate: async (context) => {
      store.withdraw(context.puzzleId, 'unsafe', 'staff', NOW);
      return ok({ puzzleId: context.puzzleId, word: context.inputs.word, clue: 'A safe clue.' });
    },
  };
  try {
    const result = await run(store, model, {
      generators: [generator as unknown as DailyGenerator],
      publisher,
      dates: ['2026-10-08'],
      screen: false,
    });
    const history = store.history('demo-game:2026-10-08');
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe('withdrawn');
    expect(store.events(history[0]!.id).map((event) => event.kind)).not.toContain('published');
    expect(result.published).toEqual([]);
    expect((await readIndex(dir)).dates).toEqual([]);
  } finally {
    store.close();
  }
});
