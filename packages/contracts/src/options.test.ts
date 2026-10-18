import { expect, it } from 'vitest';
import { isGameOptions, setupOptions, type GameOption } from './options.ts';
const options: readonly GameOption[] = [
  { key: 'blindNil', label: 'Blind nil', kind: 'toggle', default: false, modes: ['ai'] },
  {
    key: 'size',
    label: 'Grid size',
    kind: 'select',
    default: 10,
    choices: [
      { value: 5, label: 'Small' },
      { value: 10, label: 'Standard' },
    ],
  },
];
it('rejects invalid declarations, defaults, and repeated keys or values', () => {
  expect(isGameOptions(options)).toBe(true);
  expect(isGameOptions([...options, options[0]])).toBe(false);
  expect(isGameOptions([{ ...options[1], default: 7 }])).toBe(false);
  expect(isGameOptions([{ ...options[0], key: 'constructor' }])).toBe(false);
  expect(
    isGameOptions([
      {
        ...options[1],
        default: 1,
        choices: [
          { label: 'Number', value: 1 },
          { label: 'Text', value: '1' },
        ],
      },
    ]),
  ).toBe(false);
});
it('validates choices at a Standard Schema boundary and excludes options from other modes', () => {
  const ai = setupOptions(options, 'ai')['~standard'];
  expect(ai.validate({})).toEqual({ value: { blindNil: false, size: 10 } });
  expect(ai.validate({ size: 5, blindNil: true })).toEqual({ value: { size: 5, blindNil: true } });
  expect(ai.validate({ size: 7 })).toHaveProperty('issues');
  expect(ai.validate({ size: null })).toHaveProperty('issues');
  expect(ai.validate({ blindNil: undefined })).toHaveProperty('issues');
  expect(ai.validate({ unknown: true })).toHaveProperty('issues');
  expect(setupOptions(options, 'solo')['~standard'].validate({ blindNil: true })).toHaveProperty('issues');
  expect(setupOptions(options, 'daily')['~standard'].validate({})).toEqual({ value: {} });
});
