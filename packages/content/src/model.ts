// The model client (D-45): an OpenAI-compatible chat completions endpoint, called from the
// server with plain `fetch` and a Bearer key, as the owner's other sites do. One small module, no SDK.
//
// Each `complete` call:
//   1. converts the item's Zod schema to JSON Schema (`z.toJSONSchema`) and sends it as the
//      `json_schema` response format, so the model is constrained to the right shape;
//   2. retries transport failures (timeouts, network errors, 408, 429 and 5xx) with
//      exponential backoff, honoring Retry-After;
//   3. finds the JSON in the reply (reasoning blocks, prose and code fences are tolerated) and
//      decodes it through the same schema with the Standard Schema interface. Endpoints honor
//      only part of JSON Schema, so this decode is the real check.
// If the endpoint refuses `response_format` (HTTP 400 or 422), the client falls back to
// describing the schema in the prompt for the rest of its life.
//
// Errors never carry the key, the endpoint's address or a raw reply; a response body is
// reduced to its length and status.
import { err, ok, type Result } from '@joystyk/contracts';
import * as z from 'zod';
import { extractJson } from './extract-json.ts';

export interface ModelSettings {
  /** The endpoint's base URL, with or without `/v1`: `<base>/chat/completions` is called. */
  readonly baseUrl: string;
  readonly key: string;
  readonly model: string;
  /** Per HTTP request. Default 120 s. */
  readonly timeoutMs?: number;
  /** `max_tokens` for every request; room for a reasoning model to think. Default 4096. */
  readonly maxTokens?: number;
  /** Default 0.7: varied wording across days; the validators keep it honest. */
  readonly temperature?: number;
  /** Extra tries after a transport failure. Default 2. */
  readonly transportRetries?: number;
  /** First backoff; doubles each time. Default 1000 ms. */
  readonly backoffMs?: number;
}

export interface ModelDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

export type ModelErrorKind =
  | 'http' // a non-retryable status, or a retryable one after every retry
  | 'timeout'
  | 'network'
  | 'aborted' // the caller's signal (shutdown)
  | 'empty' // no content in the reply
  | 'truncated' // finish_reason "length": max_tokens ran out
  | 'parse' // no JSON object in the reply
  | 'schema'; // JSON that the schema refuses

/** Endpoint problems, as opposed to a reply that was merely wrong. They feed the circuit breaker. */
export const ENDPOINT_ERRORS: ReadonlySet<ModelErrorKind> = new Set(['http', 'timeout', 'network']);

export interface Usage {
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
}

/** What one `complete` call cost, for logs and the item's provenance. */
export interface CallInfo {
  readonly name: string;
  readonly latencyMs: number;
  readonly usage: Usage | null;
  /** HTTP requests made, including transport retries. */
  readonly requests: number;
  readonly mode: 'json_schema' | 'prompt';
  readonly finishReason: string | null;
}

export interface ModelError {
  readonly kind: ModelErrorKind;
  /** Safe to log: no key, no address, no reply text. */
  readonly message: string;
  readonly status?: number;
  readonly issues?: readonly string[];
}

export type Completion<T> = { readonly value: T; readonly call: CallInfo };
export type CompletionFailure = ModelError & { readonly call: CallInfo };

export interface Message {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompleteRequest<T> {
  /** Names the schema in the request, e.g. "word_entry". */
  readonly name: string;
  readonly schema: z.ZodType<T>;
  readonly messages: readonly Message[];
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ModelClient {
  /** The model name sent with every request, for provenance. */
  readonly model: string;
  complete<T>(request: CompleteRequest<T>): Promise<Result<Completion<T>, CompletionFailure>>;
}

/** `<base>/chat/completions` for a base URL given with or without `/v1` (or the full path). */
export const chatCompletionsUrl = (baseUrl: string): string => {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
};

/** The JSON Schema sent as the response format: draft 7, output types, no `$schema` key. */
export const responseSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'output',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  return rest;
};

const describeIssues = (issues: readonly { message: string; path?: readonly unknown[] | undefined }[]): string[] =>
  issues.map((issue) => {
    const path = (issue.path ?? [])
      .map((segment) =>
        typeof segment === 'object' && segment !== null && 'key' in segment ? String(segment.key) : String(segment),
      )
      .join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const readUsage = (value: unknown): Usage | null => {
  if (typeof value !== 'object' || value === null) return null;
  const usage = value as Record<string, unknown>;
  return {
    promptTokens: numberOrNull(usage['prompt_tokens']),
    completionTokens: numberOrNull(usage['completion_tokens']),
    totalTokens: numberOrNull(usage['total_tokens']),
  };
};

const schemaInstruction = (schema: z.ZodType): string =>
  `Reply with one JSON object only, no prose and no code fence. It must match this JSON Schema:\n${JSON.stringify(responseSchema(schema))}`;

export function createModelClient(settings: ModelSettings, deps: ModelDeps = {}): ModelClient {
  const url = chatCompletionsUrl(settings.baseUrl);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const timeoutMs = settings.timeoutMs ?? 120_000;
  const maxTokens = settings.maxTokens ?? 4096;
  const retries = settings.transportRetries ?? 2;
  const backoffMs = settings.backoffMs ?? 1000;
  let mode: 'json_schema' | 'prompt' = 'json_schema';

  type Attempt =
    | { readonly kind: 'reply'; readonly body: unknown }
    | {
        readonly kind: 'error';
        readonly error: ModelError;
        readonly retryable: boolean;
        readonly retryAfterMs: number | null;
        readonly formatRefused: boolean;
      };

  const post = async (body: unknown, signal: AbortSignal | undefined): Promise<Attempt> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${settings.key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch {
      if (signal?.aborted === true)
        return {
          kind: 'error',
          error: { kind: 'aborted', message: 'The request was cancelled.' },
          retryable: false,
          retryAfterMs: null,
          formatRefused: false,
        };
      if (timeout.aborted)
        return {
          kind: 'error',
          error: { kind: 'timeout', message: `No reply within ${String(timeoutMs)} ms.` },
          retryable: true,
          retryAfterMs: null,
          formatRefused: false,
        };
      return {
        kind: 'error',
        error: { kind: 'network', message: 'The endpoint could not be reached.' },
        retryable: true,
        retryAfterMs: null,
        formatRefused: false,
      };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      const kind = signal?.aborted === true ? 'aborted' : timeout.aborted ? 'timeout' : 'network';
      return {
        kind: 'error',
        error: { kind, message: 'The reply was cut off.' },
        retryable: kind !== 'aborted',
        retryAfterMs: null,
        formatRefused: false,
      };
    }
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after'));
      return {
        kind: 'error',
        error: {
          kind: 'http',
          status: response.status,
          message: `The endpoint answered HTTP ${String(response.status)} (${String(text.length)} bytes).`,
        },
        retryable: RETRYABLE_STATUS.has(response.status),
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : null,
        formatRefused:
          (response.status === 400 || response.status === 422) && /response_format|json_schema|schema/i.test(text),
      };
    }
    try {
      return { kind: 'reply', body: JSON.parse(text) as unknown };
    } catch {
      return {
        kind: 'error',
        error: {
          kind: 'http',
          status: response.status,
          message: `The endpoint's reply was not JSON (${String(text.length)} bytes).`,
        },
        retryable: true,
        retryAfterMs: null,
        formatRefused: false,
      };
    }
  };

  return {
    model: settings.model,
    complete: async <T>(request: CompleteRequest<T>): Promise<Result<Completion<T>, CompletionFailure>> => {
      const started = now();
      let requests = 0;
      let usage: Usage | null = null;
      let finishReason: string | null = null;
      const info = (): CallInfo => ({
        name: request.name,
        latencyMs: now() - started,
        usage,
        requests,
        mode,
        finishReason,
      });
      const fail = (error: ModelError): Result<never, CompletionFailure> => err({ ...error, call: info() });

      const bodyFor = () => {
        const messages =
          mode === 'json_schema'
            ? request.messages
            : [
                ...request.messages.slice(0, -1),
                { role: 'system', content: schemaInstruction(request.schema) },
                ...request.messages.slice(-1),
              ];
        return {
          model: settings.model,
          messages,
          temperature: request.temperature ?? settings.temperature ?? 0.7,
          max_tokens: maxTokens,
          ...(mode === 'json_schema'
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: request.name, strict: true, schema: responseSchema(request.schema) },
                },
              }
            : {}),
        };
      };

      let reply: unknown;
      for (let attempt = 0; ; attempt++) {
        requests++;
        const result = await post(bodyFor(), request.signal);
        if (result.kind === 'reply') {
          reply = result.body;
          break;
        }
        if (result.formatRefused && mode === 'json_schema') {
          mode = 'prompt';
          attempt--; // switching formats isn't a retry
          continue;
        }
        if (!result.retryable || attempt >= retries) return fail(result.error);
        await sleep(result.retryAfterMs ?? backoffMs * 2 ** attempt, request.signal);
        if (request.signal?.aborted === true) return fail({ kind: 'aborted', message: 'The request was cancelled.' });
      }

      const body = (typeof reply === 'object' && reply !== null ? reply : {}) as Record<string, unknown>;
      usage = readUsage(body['usage']);
      const choice = Array.isArray(body['choices'])
        ? (body['choices'][0] as Record<string, unknown> | undefined)
        : undefined;
      finishReason = typeof choice?.['finish_reason'] === 'string' ? choice['finish_reason'] : null;
      const message = (choice?.['message'] ?? {}) as Record<string, unknown>;
      const content = typeof message['content'] === 'string' ? message['content'] : '';
      if (content.trim() === '') {
        return fail(
          finishReason === 'length'
            ? { kind: 'truncated', message: 'The reply ran out of tokens before any answer.' }
            : { kind: 'empty', message: 'The reply had no content.' },
        );
      }
      const found = extractJson(content);
      if (!found.ok) {
        return fail(
          finishReason === 'length'
            ? { kind: 'truncated', message: 'The reply ran out of tokens before its JSON was complete.' }
            : { kind: 'parse', message: `The reply held no JSON object (${String(content.length)} characters).` },
        );
      }
      const decoded = await request.schema['~standard'].validate(found.value);
      if (decoded.issues !== undefined) {
        return fail({
          kind: 'schema',
          message: 'The reply did not match the schema.',
          issues: describeIssues(decoded.issues),
        });
      }
      return ok({ value: decoded.value, call: info() });
    },
  };
}
