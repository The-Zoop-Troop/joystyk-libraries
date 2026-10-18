import { gyralVitePreset } from '@gyral/core/vite';
import { defineConfig } from 'vite';

// A production build of the public entry points. Workspace consumers import the TypeScript
// source through `exports` (apps/site bundles the client); this build runs Gyral's template
// compiler over every component, so a template that breaks Gyral's rules fails `pnpm build`.
export default defineConfig({
  ...gyralVitePreset(),
  build: {
    lib: {
      entry: { index: 'src/index.ts', client: 'src/client.ts', server: 'src/server.ts' },
      formats: ['es'],
    },
    rolldownOptions: { external: [/^@gyral\//, /^@joystyk\//, /^zod(\/|$)/] },
    sourcemap: true,
  },
});
