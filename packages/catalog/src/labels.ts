// Words the pages use for manifest values. Pure and shared by the views, the head and tests.
import type { Mode } from '@joystyk/contracts';
import type { GameStatus, GameSummary } from './wire.ts';

export const MODE_LABELS: Readonly<Record<Mode, string>> = {
  solo: 'Solo',
  ai: 'Against the computer',
  'pass-and-play': 'Pass and play',
  // The launcher's words (packages/launcher/src/model.ts): server rooms are how friends play online in v1 (D-48).
  p2p: 'Online, peer to peer',
  server: 'Online with friends',
  daily: 'Daily puzzle',
};

export const STATUS_LABELS: Readonly<Record<GameStatus, string>> = {
  'coming-soon': 'Coming soon',
  available: 'Play now',
};

/** "1 player", "2 players", "2–8 players". */
export function playersLabel(players: GameSummary['players']): string {
  const { min, max } = players;
  if (min === max) return `${String(min)} ${min === 1 ? 'player' : 'players'}`;
  return `${String(min)}–${String(max)} players`;
}

/** "2–8", "1": the compact form for table cells. */
export const playersRange = ({ min, max }: GameSummary['players']): string =>
  min === max ? String(min) : `${String(min)}–${String(max)}`;

/** A two-digit rank for the lineup table: 1 → "01". */
export const rankLabel = (rank: number): string => String(rank).padStart(2, '0');
