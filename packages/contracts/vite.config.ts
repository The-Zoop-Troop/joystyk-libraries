import { defineConfig } from 'vite';

// A production build of the public entry point. Workspace consumers import the TypeScript
// source through `exports`; this build proves the package bundles on its own.
export default defineConfig({
  build: {
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    sourcemap: true,
  },
});
