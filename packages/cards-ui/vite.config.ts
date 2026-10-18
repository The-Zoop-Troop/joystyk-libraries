import { gyralVitePreset } from '@gyral/core/vite';
import { defineConfig } from 'vite';

// A production build of the public entry point. Workspace consumers import the TypeScript
// source through `exports`; this build runs Gyral's template compiler over the card table,
// so a template that breaks Gyral's rules fails `pnpm build`.
export default defineConfig({
  ...gyralVitePreset(),
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    rolldownOptions: { external: [/^@gyral\//, /^@joystyk\//] },
    sourcemap: true,
  },
});
