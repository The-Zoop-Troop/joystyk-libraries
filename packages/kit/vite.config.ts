import { defineConfig } from 'vite';

// A production build of the public entry points. Workspace consumers import the TypeScript
// source through `exports`; this build proves the package bundles on its own.
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        rng: 'src/rng.ts',
        cards: 'src/cards/index.ts',
        dice: 'src/dice.ts',
        grid: 'src/grid.ts',
        daily: 'src/daily.ts',
        turn: 'src/turn.ts',
      },
      formats: ['es'],
    },
    rollupOptions: { external: [/^@joystyk\//] },
    sourcemap: true,
  },
});
