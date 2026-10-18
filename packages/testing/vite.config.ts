import { defineConfig } from 'vite';

// A production build of the public entry points. Workspace consumers import the TypeScript
// source through `exports`; this build proves the package bundles on its own.
export default defineConfig({
  build: {
    lib: {
      entry: { index: 'src/index.ts', fixtures: 'src/fixtures/index.ts' },
      formats: ['es'],
    },
    rollupOptions: { external: [/^@joystyk\//, /^vitest/] },
    sourcemap: true,
  },
});
