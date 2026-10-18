import { gyralVitePreset } from '@gyral/core/vite';
import { renderOnServer } from '@gyral/testing/vitest';
import { playwright } from '@vitest/browser-playwright';
import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    maxWorkers: Number(process.env['VITEST_MAX_WORKERS'] ?? Math.max(2, Math.floor(availableParallelism() / 3))),
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          testTimeout: 30_000,
          include: ['packages/*/src/**/*.test.ts', 'scripts/release/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts', '**/*.e2e.test.ts', '**/node_modules/**'],
        },
      },
      {
        ...gyralVitePreset({ optimize: ['@gyral/core'] }),
        test: {
          name: 'browser',
          include: ['packages/*/src/**/*.browser.test.ts'],
          testTimeout: 60_000,
          expect: { poll: { timeout: 45_000 } },
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            commands: { renderOnServer },
          },
        },
      },
    ],
  },
});
