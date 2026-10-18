// Finds the JSON value in a model reply. A JSON-schema response format usually yields bare
// JSON, but some servers ignore it, and reasoning models may wrap the answer in a
// <think>…</think> block, prose or a ```json code fence. This only *finds* the JSON; the
// caller still decodes it through the item's schema (core belief 9), so nothing is guessed.

/** Removes reasoning blocks: <think>…</think>, and an unclosed leading block up to its end tag. */
export const stripReasoning = (text: string): string =>
  text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, '')
    .trim();

const tryParse = (text: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
};

/** The end index (exclusive) of the balanced object or array starting at `start`, or -1. */
const balancedEnd = (text: string, start: number): number => {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
};

/**
 * The first JSON object (or array) in a model reply: the whole reply, then any fenced code
 * block, then the first balanced `{…}` or `[…]` that parses. Undefined when there is none.
 */
export const extractJson = (reply: string): { ok: true; value: unknown } | { ok: false } => {
  const text = stripReasoning(reply);
  const whole = tryParse(text);
  if (whole.ok && typeof whole.value === 'object' && whole.value !== null) return whole;
  for (const fence of text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) {
    const parsed = tryParse((fence[1] ?? '').trim());
    if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) return parsed;
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = balancedEnd(text, i);
    if (end < 0) continue;
    const parsed = tryParse(text.slice(i, end));
    if (parsed.ok) return parsed;
  }
  return { ok: false };
};
