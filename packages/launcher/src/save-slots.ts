import type { Validator } from '@joystyk/contracts';
/** Boundary for an engine's public save description, before it reaches storage or the UI. */
export const saveDescription: Validator<{ key: string; label: string }> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return { issues: [{ message: 'Expected a save description.' }] };
      const p = raw as Record<string, unknown>;
      return typeof p['key'] === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(p['key']) &&
        typeof p['label'] === 'string' &&
        p['label'].trim().length > 0 &&
        p['label'].length <= 100
        ? { value: { key: p['key'], label: p['label'] } }
        : { issues: [{ message: 'Use a safe save key and a short public label.' }] };
    },
  },
};
