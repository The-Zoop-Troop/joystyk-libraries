import type { SoundCue } from '@joystyk/contracts';

type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type SoundFamily = 'wood' | 'paper' | 'glass' | 'arcade' | 'terminal' | 'garden';
/** Deliberate palette per game; no samples, music, network downloads or third-party recordings. */
export const SOUND_PROFILES: Readonly<Record<string, SoundFamily>> = {
  'garden-crossing': 'garden',
  'tower-stacker': 'wood',
  'rock-field': 'arcade',
  '2048': 'wood',
  backgammon: 'wood',
  blackjack: 'paper',
  'brick-break': 'arcade',
  checkers: 'wood',
  chess: 'wood',
  'chinese-checkers': 'glass',
  'circuit-84': 'terminal',
  'clue-teams': 'paper',
  'code-breaker': 'glass',
  containment: 'arcade',
  'crazy-eights': 'paper',
  cribbage: 'wood',
  crossword: 'paper',
  'daily-word': 'paper',
  dominoes: 'wood',
  'dots-and-boxes': 'paper',
  'drop-four': 'wood',
  equation: 'glass',
  euchre: 'paper',
  'five-dice': 'wood',
  'four-groups': 'glass',
  freecell: 'paper',
  'gem-swap': 'glass',
  'gin-rummy': 'paper',
  go: 'glass',
  'go-fish': 'paper',
  golf: 'paper',
  greed: 'wood',
  hangman: 'paper',
  hearts: 'paper',
  honeycomb: 'garden',
  klondike: 'paper',
  'letter-drop': 'wood',
  'liars-dice': 'wood',
  'light-trails': 'arcade',
  ludo: 'wood',
  mancala: 'wood',
  'map-guess': 'garden',
  'memory-match': 'paper',
  minesweeper: 'glass',
  'mini-golf': 'garden',
  'naval-battle': 'arcade',
  nim: 'wood',
  nonogram: 'paper',
  'old-maid': 'paper',
  paddle: 'arcade',
  pig: 'wood',
  'pipe-link': 'glass',
  pyramid: 'paper',
  queens: 'glass',
  reversi: 'wood',
  'rock-paper-scissors': 'paper',
  'shift-23': 'terminal',
  'shut-the-box': 'wood',
  snake: 'arcade',
  spades: 'paper',
  spider: 'paper',
  sudoku: 'paper',
  'tic-tac-toe': 'paper',
  'tile-match': 'glass',
  tripeaks: 'paper',
  war: 'paper',
  'word-flux': 'garden',
  'word-hunt': 'garden',
  'word-ladder': 'wood',
  'word-of-the-day': 'paper',
};

/** Games which already select sound effects in their own controls and drivers. */
export const CUSTOM_AUDIO_GAMES = new Set([
  'garden-crossing',
  'tower-stacker',
  'rock-field',
  'snake',
  'paddle',
  'light-trails',
  'containment',
  'circuit-84',
  'brick-break',
  'gem-swap',
  'mini-golf',
  'klondike',
  'freecell',
  'spider',
  'pyramid',
  'tripeaks',
  'golf',
]);
export type Tone = {
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly wave: Waveform;
  readonly delay: number;
  readonly strength: number;
};
const NOTES: Record<SoundCue, readonly [number, number, number]> = {
  move: [220, 140, 0.045],
  card: [170, 100, 0.045],
  clear: [350, 120, 0.14],
  success: [660, 880, 0.18],
  error: [160, 100, 0.11],
  lose: [180, 70, 0.22],
  level: [520, 1040, 0.25],
  start: [440, 660, 0.13],
  tick: [900, 600, 0.025],
  capture: [440, 880, 0.16],
  hit: [260, 80, 0.06],
  paddle: [140, 80, 0.065],
  power: [440, 880, 0.12],
  stroke: [170, 65, 0.07],
  rail: [240, 100, 0.07],
  water: [95, 60, 0.14],
  cup: [450, 850, 0.16],
  cascade: [300, 170, 0.1],
  trace: [150, 180, 0.035],
  life: [100, 60, 0.2],
  warning: [220, 180, 0.14],
  dice: [240, 100, 0.075],
};
const PALETTES: Record<SoundFamily, readonly [Waveform, number, number]> = {
  wood: ['triangle', 0.8, 0.055],
  paper: ['sine', 0.9, 0.038],
  glass: ['sine', 1.5, 0.04],
  arcade: ['square', 1, 0.028],
  terminal: ['triangle', 1.25, 0.035],
  garden: ['sine', 1.1, 0.042],
};
export const tonesFor = (family: SoundFamily, cue: SoundCue, variation = 0): readonly Tone[] => {
  const notes = NOTES[cue];
  if (notes === undefined) return [];
  const [wave, pitch, strength] = PALETTES[family];
  const shift = 2 ** (Math.max(-4, Math.min(8, Number.isFinite(variation) ? variation : 0)) / 12);
  const [from, to, duration] = notes;
  const chord = ['success', 'level', 'capture', 'cup', 'power'].includes(cue);
  return (chord ? [1, 1.25, 1.5] : [1]).map((n, index) => ({
    from: from * pitch * shift * n,
    to: to * pitch * shift * n,
    duration,
    wave,
    delay: index * 0.045,
    strength: chord ? strength * 0.7 : strength,
  }));
};

/** Redacted, already-validated events only. This mapping never examines a hidden answer. */
export const eventCue = (gameId: string, type: string): SoundCue | null => {
  if (gameId === 'shift-23')
    return (
      (
        {
          Drew: 'card',
          Swapped: 'card',
          Sheltered: 'card',
          Dice: 'dice',
          Shifted: 'power',
          BetTo: 'move',
          Matched: 'move',
          WentAllIn: 'move',
          Penalty: 'error',
          HandEnded: 'clear',
        } as const
      )[type as 'Drew'] ?? null
    );
  if (gameId === 'crossword' || gameId === 'sudoku') {
    if (['letterSet', 'digitSet', 'noteToggled', 'cleared'].includes(type)) return 'tick';
    if (['answerFilled', 'unitCompleted'].includes(type)) return 'clear';
  }
  if (gameId === 'containment')
    return (
      (
        {
          wallStarted: 'trace',
          wallBroken: 'life',
          wallFinished: 'hit',
          sealed: 'capture',
          cleared: 'level',
          started: 'start',
          over: 'lose',
        } as const
      )[type as 'wallStarted'] ?? null
    );
  if (gameId === 'greed')
    return (
      ({ threw: 'dice', rolled: 'dice', kept: 'move', banked: 'clear', won: 'success' } as const)[type as 'threw'] ??
      null
    );
  if (
    [
      'placed',
      'moved',
      'played',
      'dropped',
      'added',
      'set',
      'painted',
      'digitSet',
      'letterSet',
      'flipped',
      'turned',
      'selected',
      'rotated',
      'joined',
      'linked',
      'drawn',
      'connected',
      'marked',
      'sowed',
      'guessed',
      'answered',
      'guessMade',
    ].includes(type)
  )
    return 'move';
  if (['drew', 'dealerDrew', 'dealt', 'shuffled', 'redealt', 'discarded', 'cardPlayed'].includes(type)) return 'card';
  if (['rolled', 'threw', 'roll'].includes(type)) return 'dice';
  if (
    [
      'removed',
      'cleared',
      'matched',
      'lineCompleted',
      'unitCompleted',
      'scored',
      'wordFound',
      'found',
      'letterFound',
      'banked',
      'settled',
      'captured',
      'merged',
      'ate',
      'foodEaten',
      'bonusFound',
      'boxCompleted',
      'trickWon',
      'booked',
      'swept',
      'allConnected',
    ].includes(type)
  )
    return 'clear';
  if (
    [
      'wrong',
      'close',
      'mismatched',
      'notQuite',
      'fullButWrong',
      'letterMissed',
      'wordMissed',
      'detonated',
      'bust',
      'busted',
      'crashed',
      'lifeLost',
    ].includes(type)
  )
    return 'error';
  if (['levelUp', 'rankReached', 'milestone', 'reached2048', 'levelCleared'].includes(type)) return 'level';
  if (['won', 'solved', 'completed', 'finished', 'handWon', 'roundWon', 'courseFinished'].includes(type))
    return 'success';
  if (['lost', 'overflow'].includes(type)) return 'lose';
  if (['began', 'started', 'launched'].includes(type)) return 'start';
  if (['returned', 'paddleHit', 'wallBounce', 'brickHit', 'wallHit'].includes(type)) return 'hit';
  // Connection, seat, setup, pass, timer and hint events are deliberately silent.
  return null;
};
