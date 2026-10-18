// @joystyk/launcher/fixture: Tally, a test game for the launcher's own tests and for apps
// that register it in test builds (apps/site does, behind JOYSTYK_TEST_GAMES=1). It is not
// a real game: never list it in production.
import { defineManifest, type GameEntry } from '@joystyk/contracts';

export const TALLY_ID = 'test-tally';

export const tallyManifest = defineManifest({
  id: TALLY_ID,
  name: 'Tally',
  summary: 'A test game for the launcher: race to five by adding one or two to your score.',
  category: 'arcade',
  tags: ['test'],
  modes: ['solo', 'ai', 'pass-and-play', 'server'],
  players: { min: 1, max: 2 },
  ai: { levels: ['easy', 'hard'] },
  layers: { engine: true, simulation: false },
  privateState: true,
  handoff: true,
  essentialMotion: false,
  access: 'free',
  versions: { build: '0.0.1', rules: 1, save: 1, minProtocol: 1 },
  undo: 'none',
  clock: null,
  assets: `/games/${TALLY_ID}/manifest.json`,
  // A pale green board in light mode and a deep green one in dark mode, each with its ink.
  theme: {
    accent: { light: 'oklch(46% 0.15 145)', dark: 'oklch(80% 0.16 145)' },
    surface: { light: 'oklch(96% 0.03 145)', dark: 'oklch(25% 0.04 145)' },
    ink: { light: 'oklch(24% 0.04 145)', dark: 'oklch(95% 0.02 145)' },
  },
});

/** The game's entry: the manifest now, the module (engine and canvas) when someone plays. */
export const tallyEntry: GameEntry<HTMLElement> = {
  manifest: tallyManifest,
  load: async () => (await import('./module.ts')).tallyModule,
};

export {
  tallyEngine,
  type TallyCommand,
  type TallyConfig,
  type TallyEvent,
  type TallyState,
  type TallyView,
} from './engine.ts';
export { tallyProbe } from './probe.ts';
