import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// A production build of the three public entry points. Workspace consumers import the
// TypeScript source through `exports`; this build proves each entry bundles on its own.
// Dependencies and Node built-ins stay external: the adapter runs on Node, never in a browser.
export default defineConfig({
  build: {
    target: 'node24',
    lib: {
      entry: { index: 'src/index.ts', protocol: 'src/protocol/index.ts', node: 'src/node/index.ts' },
      formats: ['es'],
    },
    rolldownOptions: {
      external: [/^node:/, ...builtinModules, 'ws', /^zod(\/|$)/, /^@joystyk\//],
    },
    sourcemap: true,
  },
});
