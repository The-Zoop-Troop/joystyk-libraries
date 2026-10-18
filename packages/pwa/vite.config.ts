import { defineConfig } from 'vite';

// A production build of the shared and page entry points. Workspace consumers import the
// TypeScript source through `exports`. The service worker itself is bundled by the build
// entry ('@joystyk/pwa/build') during the site's build.
export default defineConfig({
  build: {
    lib: { entry: { index: 'src/index.ts', client: 'src/client/index.ts' }, formats: ['es'] },
    rolldownOptions: { external: [/^@joystyk\//, /^zod(\/|$)/] },
    sourcemap: true,
  },
});
