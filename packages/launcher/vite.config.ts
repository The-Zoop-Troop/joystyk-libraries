import { gyralVitePreset } from '@gyral/core/vite';
import { defineConfig } from 'vite';

// A production build of the public entry points. Workspace consumers import the TypeScript
// source through `exports`; this build runs Gyral's template compiler over every component,
// so a template that breaks Gyral's rules fails `pnpm build`.
export default defineConfig({
  ...gyralVitePreset(),
  build: {
    lib: {
      entry: { index: 'src/index.ts', browser: 'src/browser/index.ts', fixture: 'src/fixture/index.ts' },
      formats: ['es'],
    },
    rolldownOptions: { external: [/^@gyral\//, /^@joystyk\//] },
    sourcemap: true,
  },
});
