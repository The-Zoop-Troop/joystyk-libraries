import { expect, it } from 'vitest';
import { saveDescription } from './save-slots.ts';
it('rejects path separators, oversized keys and blank public labels at the save boundary', () => {
  const parse = (raw: unknown) => saveDescription['~standard'].validate(raw);
  expect(parse({ key: '2026-10-10', label: 'Hill · 2026-10-10' })).toEqual({
    value: { key: '2026-10-10', label: 'Hill · 2026-10-10' },
  });
  for (const raw of [
    null,
    [],
    { key: '../solo', label: 'Hill' },
    { key: 'a/b', label: 'Hill' },
    { key: 'a'.repeat(49), label: 'Hill' },
    { key: 'hill', label: ' ' },
    { key: 'hill', label: 'a'.repeat(101) },
  ])
    expect(parse(raw)).toHaveProperty('issues');
});
