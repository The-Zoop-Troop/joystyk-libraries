import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { extractJson, stripReasoning } from './extract-json.ts';
import { createLogger, redact } from './log.ts';
import { chatCompletionsUrl, createModelClient, responseSchema } from './model.ts';

const schema = z.object({ word: z.string().max(10), count: z.number().int() });
const KEY = 'sk-test-secret-key-0123456789';

type Reply = Response | Error | ((init: RequestInit) => Promise<Response>);
const reply = (content: string, extra: Record<string, unknown> = {}) =>
  Response.json({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    ...extra,
  });

/** A scripted fetch: each request takes the next reply. */
const scripted = (...replies: Reply[]) => {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = replies.shift();
    if (next === undefined) throw new Error('no more replies');
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(init ?? {});
    return next;
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
};

const client = (fake: ReturnType<typeof scripted>, settings: Partial<Parameters<typeof createModelClient>[0]> = {}) => {
  const sleeps: number[] = [];
  const model = createModelClient(
    { baseUrl: 'https://model.example.invalid/v1', key: KEY, model: 'test-model', backoffMs: 100, ...settings },
    { fetch: fake.fetch, sleep: async (ms) => void sleeps.push(ms) },
  );
  return { model, sleeps };
};

const ask = (model: ReturnType<typeof createModelClient>) =>
  model.complete({
    name: 'thing',
    schema,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
    ],
  });

describe('chatCompletionsUrl', () => {
  it('accepts a base URL with or without /v1, with or without a trailing slash', () => {
    expect(chatCompletionsUrl('https://h.invalid')).toBe('https://h.invalid/v1/chat/completions');
    expect(chatCompletionsUrl('https://h.invalid/')).toBe('https://h.invalid/v1/chat/completions');
    expect(chatCompletionsUrl('https://h.invalid/v1')).toBe('https://h.invalid/v1/chat/completions');
    expect(chatCompletionsUrl('https://h.invalid/api/v1/')).toBe('https://h.invalid/api/v1/chat/completions');
    expect(chatCompletionsUrl('https://h.invalid/v1/chat/completions')).toBe('https://h.invalid/v1/chat/completions');
  });
});

describe('the model client', () => {
  it('posts the model, a Bearer key and a strict JSON-schema response format, and decodes the reply', async () => {
    const fake = scripted(reply('{"word":"brisk","count":2}'));
    const { model } = client(fake);
    const result = await ask(model);
    expect(result.ok && result.value.value).toEqual({ word: 'brisk', count: 2 });
    expect(result.ok && result.value.call.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
    const [call] = fake.calls;
    expect(call?.url).toBe('https://model.example.invalid/v1/chat/completions');
    expect((call?.init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${KEY}`);
    expect(call?.body['model']).toBe('test-model');
    expect(call?.body['max_tokens']).toBe(4096);
    expect(call?.body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: { name: 'thing', strict: true, schema: responseSchema(schema) },
    });
    expect(responseSchema(schema)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['word', 'count'],
    });
  });

  it('finds JSON behind reasoning, prose and code fences', async () => {
    const fake = scripted(
      reply(
        '<think>Let me think {not json}</think>Sure! Here it is:\n```json\n{"word":"brisk","count":1}\n```\nEnjoy.',
      ),
    );
    const result = await ask(client(fake).model);
    expect(result.ok).toBe(true);
  });

  it('reports malformed JSON and schema violations without retrying the transport', async () => {
    const bad = await ask(client(scripted(reply('I cannot help with that.'))).model);
    expect(!bad.ok && bad.error.kind).toBe('parse');
    const wrong = await ask(client(scripted(reply('{"word":"far too long a word","count":1.5}'))).model);
    expect(!wrong.ok && wrong.error.kind).toBe('schema');
    expect(!wrong.ok && wrong.error.issues?.length).toBe(2);
  });

  it('reports a reply cut off by max_tokens as truncated', async () => {
    const fake = scripted(
      Response.json({ choices: [{ message: { content: '{"word":"br' }, finish_reason: 'length' }] }),
    );
    const result = await ask(client(fake).model);
    expect(!result.ok && result.error.kind).toBe('truncated');
  });

  it('retries 429 and 5xx with exponential backoff, honoring Retry-After', async () => {
    const fake = scripted(
      new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
      new Response('oops', { status: 502 }),
      reply('{"word":"a","count":1}'),
    );
    const { model, sleeps } = client(fake);
    const result = await ask(model);
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([3000, 200]);
    expect(result.ok && result.value.call.requests).toBe(3);
  });

  it('gives up after its transport retries and does not retry a 401', async () => {
    const down = await ask(
      client(
        scripted(
          new Response('', { status: 503 }),
          new Response('', { status: 503 }),
          new Response('', { status: 503 }),
        ),
      ).model,
    );
    expect(!down.ok && down.error).toMatchObject({ kind: 'http', status: 503 });
    const fake = scripted(new Response('bad key', { status: 401 }));
    const denied = await ask(client(fake).model);
    expect(!denied.ok && denied.error.kind).toBe('http');
    expect(fake.calls).toHaveLength(1);
  });

  it('times out a slow request and reports network failures', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    const slow = await ask(client(scripted(hang), { timeoutMs: 20, transportRetries: 0 }).model);
    expect(!slow.ok && slow.error.kind).toBe('timeout');
    const offline = await ask(client(scripted(new TypeError('fetch failed')), { transportRetries: 0 }).model);
    expect(!offline.ok && offline.error.kind).toBe('network');
  });

  it('stops at once when the caller aborts', async () => {
    const controller = new AbortController();
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    const { model } = client(scripted(hang));
    const pending = model.complete({
      name: 'thing',
      schema,
      messages: [{ role: 'user', content: 'go' }],
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(!result.ok && result.error.kind).toBe('aborted');
  });

  it('falls back to a schema in the prompt when the endpoint refuses response_format', async () => {
    const fake = scripted(
      new Response('{"error":"response_format json_schema is not supported"}', { status: 400 }),
      reply('{"word":"a","count":1}'),
      reply('{"word":"b","count":2}'),
    );
    const { model } = client(fake);
    expect((await ask(model)).ok).toBe(true);
    expect((await ask(model)).ok).toBe(true);
    expect(fake.calls[1]?.body['response_format']).toBeUndefined();
    expect(JSON.stringify(fake.calls[1]?.body['messages'])).toMatch(/JSON Schema/);
    expect(fake.calls[2]?.body['response_format']).toBeUndefined();
  });

  it('never puts the key, the endpoint or the reply body in an error', async () => {
    const fake = scripted(new Response(`invalid key ${KEY} for model.example.invalid`, { status: 401 }));
    const result = await ask(client(fake).model);
    const text = JSON.stringify(result);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('model.example.invalid');
  });
});

describe('extractJson', () => {
  it('handles bare JSON, fences, unclosed reasoning and braces inside strings', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('```\n{"a":2}\n```')).toEqual({ ok: true, value: { a: 2 } });
    expect(extractJson('thinking about {braces}... </think> {"a":"}{"}')).toEqual({ ok: true, value: { a: '}{' } });
    expect(extractJson('no json here').ok).toBe(false);
    expect(stripReasoning('<think>x</think> y')).toBe('y');
  });
});

describe('the logger', () => {
  it('redacts secrets wherever they appear', () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line), secrets: [KEY, 'model.example.invalid', ''] });
    log.error('failed', {
      error: new Error(`401 from https://model.example.invalid with ${KEY}`),
      nested: { key: KEY },
    });
    expect(lines.join('\n')).not.toContain(KEY);
    expect(lines.join('\n')).not.toContain('model.example.invalid');
    expect(lines.join('\n')).toContain('[redacted]');
    expect(redact('a "quoted" secret', ['"quoted" secret'])).toBe('a [redacted]');
  });
});
