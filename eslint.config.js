import gyral from '@gyral/core/eslint';
import parser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['**/dist/', '**/coverage/', '**/.gyral/', 'vendor/', '.beads/', '.agents/', '.claude/', 'scripts/__fixtures__/'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { sourceType: 'module', ecmaVersion: 'latest' },
    },
    ...gyral.configs.recommended,
  },
];
