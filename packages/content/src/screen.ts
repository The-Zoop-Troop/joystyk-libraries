// Layer 3 of the all-ages filter: a second model call screens every text field against the
// same rules as the word lists (content-pipeline.md, "The all-ages filter"). It can only add
// a rejection: a "safe" verdict never overrides the blocklist or the sensitive list, and a
// failed screening call fails the attempt, because nothing publishes unscreened.
import { err, ok, type Result } from '@joystyk/contracts';
import * as z from 'zod';
import type { FieldText } from './filter.ts';
import type { CompletionFailure, ModelClient, CallInfo } from './model.ts';

export const SCREEN_PROMPT_VERSION = 'screen-v1';

export const screenVerdict = z.object({
  safe: z.boolean(),
  reasons: z.array(z.string().max(200)).max(10),
});
export type ScreenVerdict = z.infer<typeof screenVerdict>;

export const SCREEN_SYSTEM = [
  'You check text for a puzzle website that children play. Be strict.',
  'Mark the text unsafe if any field contains or implies any of these:',
  '- profanity, insults, slurs, or anything sexual or romantic;',
  '- violence, weapons, war, death, injury, illness, or disasters;',
  '- crime, drugs, alcohol, tobacco, or gambling;',
  '- religion, politics, or current news;',
  '- a real living person, a brand, a product, or a company;',
  '- anything scary, cruel, mean, or sad enough to upset a young child.',
  'Judge safety only. Puzzles include wrong answer choices on purpose, so never mark text unsafe for being false, nonsensical or ungrammatical; other checks handle accuracy.',
  'Everyday things are fine: mild feelings (bored, grumpy, tired), harmless tricks and games, the ordinary words "news" or "newspaper" without naming real events, school, family and pets. Words for ordinary unkind behavior, such as scolding, teasing or grumbling, are fine when the text itself is gentle.',
  'Reply with JSON: {"safe": boolean, "reasons": [short reasons, empty when safe]}.',
].join('\n');

export const screenMessages = (fields: readonly FieldText[]) =>
  [
    { role: 'system', content: SCREEN_SYSTEM },
    {
      role: 'user',
      content: `Check these fields:\n${fields.map((field) => `${field.path}: ${field.text}`).join('\n')}`,
    },
  ] as const;

export type ScreenResult = Result<{ verdict: ScreenVerdict; call: CallInfo }, CompletionFailure>;

/** Runs the model screen over the fields. */
export const modelScreen = async (
  model: ModelClient,
  fields: readonly FieldText[],
  signal?: AbortSignal,
): Promise<ScreenResult> => {
  const result = await model.complete({
    name: 'safety_screen',
    schema: screenVerdict,
    messages: screenMessages(fields),
    temperature: 0,
    ...(signal === undefined ? {} : { signal }),
  });
  return result.ok ? ok({ verdict: result.value.value, call: result.value.call }) : err(result.error);
};
