import { defineConfig } from 'vite';

// A production build of every entry point. Workspace consumers import the TypeScript source
// through `exports`; this build proves the package bundles on its own.
export default defineConfig({
  build: {
    lib: {
      entry: { index: 'src/index.ts', browser: 'src/browser/index.ts', 'browser-rooms': 'src/browser/rooms.ts' },
      formats: ['es'],
    },
    rolldownOptions: { external: [/^@joystyk\//] },
    sourcemap: true,
  },
});
