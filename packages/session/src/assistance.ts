import { ASSIST_KINDS, type AssistCounts, type Validator } from '@joystyk/contracts';
import { isRecord } from './values.ts';
/** Standard Schema boundary for the optional, extensible saved count map. */
export const assistCountsSchema: Validator<AssistCounts> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) => {
      if (!isRecord(raw)) return { issues: [{ message: 'Assistance counts must be an object.' }] };
      for (const [kind, count] of Object.entries(raw))
        if (
          !(ASSIST_KINDS as readonly string[]).includes(kind) ||
          !Number.isSafeInteger(count) ||
          (count as number) < 0
        )
          return { issues: [{ message: 'Use a known assistance kind and a nonnegative safe integer.', path: [kind] }] };
      return { value: { ...raw } as AssistCounts };
    },
  },
};
