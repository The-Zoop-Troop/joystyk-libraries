import { defineConfig } from 'vite';

// A production build of both entry points. Workspace consumers import the TypeScript source
// through `exports`; this build proves each entry bundles on its own.
export default defineConfig({
  build: {
    lib: { entry: { index: 'src/index.ts', browser: 'src/browser/index.ts' }, formats: ['es'] },
    rolldownOptions: { external: [/^@joystyk\//, /^zod(\/|$)/] },
    sourcemap: true,
  },
});
