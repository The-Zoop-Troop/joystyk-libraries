// The launcher's pure parts: what a game page tells it, the modes it offers, the seats it
// builds, what it tells the stage that runs the game and what the stage reports back, and
// the words of the results screen. No DOM and no I/O, so the model tests run in Node.
import {
  ASSIST_KINDS,
  isGameOptions,
  optionsForMode,
  type GameOption,
  isGameId,
  isJson,
  type AssistKind,
  type GameManifest,
  type Json,
  type Mode,
  type Outcome,
  type OutcomeResult,
  type SeatInfo,
  type Validator,
} from '@joystyk/contracts';
import { dailyWordStatsSchema, type DailyWordStats } from '@joystyk/daily';
import { checkDisplayName } from '@joystyk/identity';
import type { LocalMode } from '@joystyk/session';
import type { StoredPreferences } from '@joystyk/storage';

// --- The game, as the page describes it ------------------------------------------------------

export type GameStatus = 'available' | 'coming-soon';

/** What the launcher needs from the page: manifest facts, plus whether the game exists yet. */
export type LauncherGame = {
  readonly id: string;
  readonly name: string;
  readonly modes: readonly Mode[];
  /** `default`: the table size the player-count picker starts at against the computer. */
  readonly players: { readonly min: number; readonly max: number; readonly default?: number | undefined };
  readonly aiLevels: readonly string[];
  readonly status: GameStatus;
  /** The game plays AI-generated content: it stays locked until the player accepts the notice (D-44). */
  readonly aiContent?: boolean;
  readonly options?: readonly GameOption[];
};

export const MODES: readonly Mode[] = ['solo', 'ai', 'pass-and-play', 'p2p', 'server', 'daily'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');
const isMode = (value: unknown): value is Mode =>
  typeof value === 'string' && (MODES as readonly string[]).includes(value);

export const isLauncherGame = (value: unknown): value is LauncherGame => {
  if (!isRecord(value) || !isGameId(value['id']) || typeof value['name'] !== 'string') return false;
  const players = value['players'];
  return (
    Array.isArray(value['modes']) &&
    value['modes'].every(isMode) &&
    isRecord(players) &&
    Number.isInteger(players['min']) &&
    Number.isInteger(players['max']) &&
    (players['default'] === undefined || Number.isInteger(players['default'])) &&
    isStringArray(value['aiLevels']) &&
    (value['status'] === 'available' || value['status'] === 'coming-soon') &&
    (value['aiContent'] === undefined || typeof value['aiContent'] === 'boolean') &&
    (value['options'] === undefined || isGameOptions(value['options']))
  );
};

/** The launcher's view of a manifest, for pages that have the manifest itself. */
export const launcherGame = (manifest: GameManifest, status: GameStatus = 'available'): LauncherGame => ({
  id: manifest.id,
  name: manifest.name,
  modes: [...manifest.modes],
  players:
    manifest.players.default === undefined
      ? { min: manifest.players.min, max: manifest.players.max }
      : { min: manifest.players.min, max: manifest.players.max, default: manifest.players.default },
  aiLevels: manifest.ai === null ? [] : [...manifest.ai.levels],
  status,
  aiContent: manifest.aiContent === true,
  ...(manifest.options === undefined ? {} : { options: manifest.options }),
});

/** The AI-content notice (D-44; wording approved as D-52). */
export const AI_NOTICE = {
  title: 'This game uses AI-made content',
  body: 'Some puzzles and clues here are written by an AI model. Each one passes automatic safety checks before it appears, but no person reads every one first, so now and then something may be odd or wrong. If you spot a problem, use Report a problem.',
  scope: 'Accepting unlocks all AI-content games on this device. You can change this anytime in Preferences.',
} as const;

/** True when an AI-content game must show the notice before it can start. */
export const needsAiNotice = (game: LauncherGame, preferences: StoredPreferences): boolean =>
  game.aiContent === true && preferences.aiContentAccepted !== true;

/**
 * The access gate (monetization.md): where premium games and modes will ask for an
 * entitlement in v2. Every game is free in v1, so it is always open.
 */
export const accessGate = (access: GameManifest['access']): 'open' => {
  switch (access) {
    case 'free':
      return 'open';
  }
};

// --- Modes --------------------------------------------------------------------------------

export const MODE_LABELS: Readonly<Record<Mode, string>> = {
  solo: 'Solo',
  ai: 'Against the computer',
  'pass-and-play': 'Pass and play',
  p2p: 'Online, peer to peer',
  server: 'Online with friends',
  daily: 'Daily puzzle',
};

/** The modes the launcher runs on a local session. The daily puzzle is a local session on today's published config. */
export const toLocalMode = (mode: Mode): LocalMode | null =>
  mode === 'solo' || mode === 'ai' || mode === 'pass-and-play' || mode === 'daily' ? mode : null;

/** What the stage runs: a local session, or a server room (D-48). P2P rooms arrive later. */
export type StageMode = LocalMode | 'server';

export const toStageMode = (mode: Mode): StageMode | null => (mode === 'server' ? 'server' : toLocalMode(mode));

export type ModeOption = {
  readonly mode: Mode;
  readonly label: string;
  readonly playable: boolean;
  /** Why it can't be picked, or null. */
  readonly note: string | null;
};

/**
 * What the launcher knows about the room server (`GET /api/rooms/games`): still asking, the
 * games it hosts, or no usable answer. A manifest may list `server` before the room server
 * hosts the game; only a hosted game offers Online with friends.
 */
export type OnlineRooms =
  | { readonly _tag: 'Checking' }
  | { readonly _tag: 'Hosted'; readonly games: readonly string[]; readonly protocol: number }
  | { readonly _tag: 'Unreachable' };

export const ONLINE_CHECKING: OnlineRooms = { _tag: 'Checking' };
export const ONLINE_UNREACHABLE: OnlineRooms = { _tag: 'Unreachable' };

/** The room server's answer, checked at the boundary; anything else (an error page, a proxy's 502 body) is undefined. */
export const parseHostedGames = (value: unknown): OnlineRooms | undefined => {
  if (!isRecord(value)) return undefined;
  const { games, protocol } = value;
  if (!Array.isArray(games) || !games.every(isGameId) || !Number.isInteger(protocol) || (protocol as number) < 1)
    return undefined;
  return { _tag: 'Hosted', games: [...games], protocol: protocol as number };
};

/** True when the room server opens rooms for this game. */
export const hostedOnline = (game: LauncherGame, online: OnlineRooms): boolean =>
  online._tag === 'Hosted' && online.games.includes(game.id);

/** Why Online with friends can't be picked yet: unknown while asking, coming soon (D-53) when not hosted. */
const onlineNote = (game: LauncherGame, online: OnlineRooms): string | null => {
  switch (online._tag) {
    case 'Checking':
      return null;
    case 'Unreachable':
      return 'Unavailable right now';
    case 'Hosted':
      return online.games.includes(game.id) ? null : 'Coming soon';
  }
};

/**
 * One option per mode in the manifest, in manifest order. Online with friends is playable only
 * once the room server says it hosts the game; until it answers, and when it can't be reached,
 * the local modes are unaffected.
 */
export const modeOptions = (game: LauncherGame, online: OnlineRooms = ONLINE_CHECKING): readonly ModeOption[] =>
  game.modes.map((mode) => {
    const run = toStageMode(mode);
    const fits =
      run === 'solo' || run === 'daily'
        ? game.players.min <= 1
        : run === 'ai'
          ? game.aiLevels.length > 0
          : run === 'pass-and-play' || run === 'server'
            ? game.players.max >= 2
            : false;
    const reachable = run !== 'server' || hostedOnline(game, online);
    const playable = game.status === 'available' && run !== null && fits && reachable;
    const note =
      run === null
        ? 'Coming soon'
        : run === 'server' && game.status === 'available' && fits
          ? onlineNote(game, online)
          : null;
    return { mode, label: MODE_LABELS[mode], playable, note };
  });

/**
 * The player counts a mode allows: solo is one; local multiplayer takes two or more; a room
 * sizes itself. In pass-and-play the count is people: a game with AI and more seats than
 * people (Hearts, Spades) lets two or more share the device while the computer fills the rest.
 */
export const playerCounts = (game: LauncherGame, mode: Mode | null): readonly number[] => {
  if ((mode !== 'ai' && mode !== 'pass-and-play') || game.players.max === 1) return [1];
  const counts: number[] = [];
  const fewest = mode === 'pass-and-play' && game.aiLevels.length > 0 ? 2 : Math.max(2, game.players.min);
  for (let n = fewest; n <= game.players.max; n += 1) counts.push(n);
  return counts;
};

/**
 * The count the picker starts at for a mode: against the computer, the game's declared
 * default when the mode offers it (Shift 23 seats five, D-58); otherwise the fewest. Other
 * modes count people, and a room sizes itself, so the default never applies to them.
 */
export const startingCount = (game: LauncherGame, mode: Mode | null): number => {
  const counts = playerCounts(game, mode);
  const preset = game.players.default;
  return mode === 'ai' && preset !== undefined && counts.includes(preset) ? preset : (counts[0] ?? 1);
};

/** Pass-and-play with fewer people than the game's seats: the computer plays the rest. */
export const computerSeatsFor = (game: LauncherGame, setup: Setup): number =>
  setup.mode === 'pass-and-play' ? Math.max(0, game.players.min - setup.players) : 0;

// --- Setup and seats ------------------------------------------------------------------------

export type Setup = {
  readonly mode: Mode | null;
  readonly aiLevel: string | null;
  readonly players: number;
  /** Pass-and-play names as typed, by seat. */
  readonly names: readonly string[];
  /** A problem per name, by seat, or null. */
  readonly errors: readonly (string | null)[];
  /** Online with friends: the invite code (or link) as typed into the join form. */
  readonly code: string;
  /** Join to watch, even if a seat is free (D-33). */
  readonly watch: boolean;
  /** Why the code can't be used, or null. */
  readonly codeError: string | null;
  readonly options?: Readonly<Record<string, string | number | boolean>>;
};

export const initialSetup = (game: LauncherGame, online: OnlineRooms = ONLINE_CHECKING): Setup => {
  const mode = modeOptions(game, online).find((option) => option.playable)?.mode ?? null;
  return {
    mode,
    aiLevel: game.aiLevels[0] ?? null,
    players: startingCount(game, mode),
    names: [],
    errors: [],
    code: '',
    watch: false,
    codeError: null,
    options: Object.fromEntries(optionsForMode(game.options ?? [], mode ?? 'solo').map((o) => [o.key, o.default])),
  };
};

// --- Rooms ------------------------------------------------------------------------------------

/** Invite codes: six characters without look-alikes (no 0/O or 1/I), as the room server issues them. */
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

export const isRoomCode = (value: unknown): value is string => typeof value === 'string' && ROOM_CODE.test(value);

/**
 * The room code in what a player typed or pasted: a code in any case, with spaces or dashes
 * ("k7m-2qx"), or a whole invite link (`…?room=K7M2QX`). Null when there is none.
 */
export const parseRoomCode = (input: string): string | null => {
  const trimmed = input.trim();
  const fromLink = /[?&]room=([A-Za-z0-9-]+)/.exec(trimmed)?.[1] ?? trimmed;
  const code = fromLink.toUpperCase().replace(/[\s-]/g, '');
  return isRoomCode(code) ? code : null;
};

/** "K7M 2QX": a code grouped for reading aloud and copying by eye. */
export const spacedCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** How the stage opens its room. */
export type RoomPlan =
  { readonly action: 'create' } | { readonly action: 'join'; readonly code: string; readonly watch: boolean };

/** A clock choice in the lobby (D-34, D-42): a per-move clock, a time bank, or Off. */
export type ClockSetting =
  | { readonly kind: 'move'; readonly ms: number }
  | { readonly kind: 'bank'; readonly initialMs: number; readonly incrementMs: number }
  | { readonly kind: 'off' };

/** A select option for a clock setting; `value` round-trips through `parseClockValue`. */
export type ClockOption = { readonly value: string; readonly label: string };

export const clockValue = (setting: ClockSetting): string =>
  setting.kind === 'off'
    ? 'off'
    : setting.kind === 'move'
      ? `move:${String(setting.ms)}`
      : `bank:${String(setting.initialMs)}:${String(setting.incrementMs)}`;

export const parseClockValue = (value: string | undefined): ClockSetting | undefined => {
  if (value === 'off') return { kind: 'off' };
  const move = /^move:(\d{1,9})$/.exec(value ?? '');
  if (move?.[1] !== undefined) return { kind: 'move', ms: Number(move[1]) };
  const bank = /^bank:(\d{1,9}):(\d{1,9})$/.exec(value ?? '');
  if (bank?.[1] !== undefined && bank[2] !== undefined)
    return { kind: 'bank', initialMs: Number(bank[1]), incrementMs: Number(bank[2]) };
  return undefined;
};

const duration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s >= 60 && s % 60 === 0) return s === 60 ? '1 minute' : `${String(s / 60)} minutes`;
  return s === 1 ? '1 second' : `${String(s)} seconds`;
};

/** "30 seconds a move", "5 minutes, plus 2 seconds a move", "Off". */
export const clockLabel = (setting: ClockSetting): string => {
  switch (setting.kind) {
    case 'off':
      return 'Off';
    case 'move':
      return `${duration(setting.ms)} a move`;
    case 'bank':
      return setting.incrementMs > 0
        ? `${duration(setting.initialMs)}, plus ${duration(setting.incrementMs)} a move`
        : `${duration(setting.initialMs)} each`;
  }
};

/**
 * The lobby's clock choices for a manifest clock: its presets with the default marked, then
 * Off, which private rooms always offer and never default to (D-42). None for a game without
 * a clock.
 */
export const clockOptions = (clock: GameManifest['clock']): readonly ClockOption[] => {
  if (clock === null) return [];
  const presets: ClockSetting[] =
    clock.mode === 'bank'
      ? clock.presets.map((p) => ({ kind: 'bank', initialMs: p.initialMs, incrementMs: p.incrementMs }))
      : clock.presets.map((s) => ({ kind: 'move', ms: s * 1000 }));
  const usual: ClockSetting =
    clock.mode === 'bank'
      ? { kind: 'bank', initialMs: clock.default.initialMs, incrementMs: clock.default.incrementMs }
      : { kind: 'move', ms: clock.default * 1000 };
  const all = presets.some((p) => clockValue(p) === clockValue(usual)) ? presets : [usual, ...presets];
  return [
    ...all.map((p) => ({
      value: clockValue(p),
      label: clockValue(p) === clockValue(usual) ? `${clockLabel(p)} (usual)` : clockLabel(p),
    })),
    { value: 'off', label: 'Off: no clock' },
  ];
};

/** A seat in the lobby, as the stage reports it. */
export type RoomSeat = {
  readonly id: number;
  readonly name: string;
  readonly controller: 'human' | 'ai';
  readonly aiLevel: string | null;
  /** A player holds the seat (also while the computer covers for them). */
  readonly claimed: boolean;
  readonly ready: boolean;
  readonly connected: boolean;
};

/** The current decision clock, for the bar; `paused` while nobody is at the table (D-58). */
export type RoomTimer = {
  readonly seat: number;
  readonly name: string;
  readonly seconds: number;
  readonly paused: boolean;
};

/** A rematch or end-match offer as the results and the bar show it (D-61). */
export type RoomOfferFrame = {
  /** Names the offer in answers. */
  readonly id: number;
  readonly kind: 'rematch' | 'end';
  readonly by: number;
  readonly byName: string;
  readonly status: 'open' | 'declined' | 'withdrawn';
  /** Seats that have accepted (the proposer, and computer seats for a rematch). */
  readonly accepted: readonly number[];
  /** The seat that declined, if one did, and its player's name. */
  readonly declinedBy: number | null;
  readonly declinedName: string | null;
  /** Players whose answer an open offer still waits for. */
  readonly waiting: readonly string[];
  /** An end offer: whole seconds until the match ends unless someone declines. */
  readonly seconds: number | null;
};

/** What the stage reports about its room after every change: plain data for the lobby and the bar. */
export type RoomFrame = {
  readonly code: string;
  /** The invite link: this game page with `?room=CODE`. */
  readonly link: string;
  /** `connecting` until the first snapshot arrives. */
  readonly phase: 'connecting' | 'lobby' | 'playing' | 'finished' | 'closed';
  readonly connection: 'connecting' | 'online' | 'reconnecting' | 'closed';
  /** The viewer's seat; null for a spectator. */
  readonly seat: number | null;
  readonly host: number | null;
  readonly seats: readonly RoomSeat[];
  readonly minSeats: number;
  readonly clock: ClockSetting;
  readonly clockOptions: readonly ClockOption[];
  readonly aiLevel: string | null;
  readonly aiLevels: readonly string[];
  readonly spectators: number;
  readonly timer: RoomTimer | null;
  /** The latest rejection or connection problem, worded for players, and its code. */
  readonly notice: string | null;
  readonly noticeCode: string | null;
  /** Counts matches in this room; a rematch raises it. */
  readonly match: number;
  /** The latest rematch or end-match offer. */
  readonly offer: RoomOfferFrame | null;
};

/** What the lobby asks of the room. The stage turns each into a room control. */
export type RoomRequest =
  | { readonly kind: 'ready'; readonly ready: boolean }
  | { readonly kind: 'clock'; readonly setting: ClockSetting }
  | { readonly kind: 'ai-level'; readonly level: string }
  | { readonly kind: 'fill-with-ai'; readonly seat: number }
  | { readonly kind: 'remove-seat'; readonly seat: number }
  | { readonly kind: 'start' }
  /** Offer a rematch, or to end the match early (D-61); offering what is already offered accepts it. */
  | { readonly kind: 'offer'; readonly offer: 'rematch' | 'end' }
  /** Answer the offer with this id. */
  | { readonly kind: 'answer'; readonly offer: number; readonly answer: 'accept' | 'decline' | 'withdraw' }
  | { readonly kind: 'leave' }
  /** Take the seat back after another tab replaced this one. */
  | { readonly kind: 'reconnect' };

/** "Ana", "Ana and Ben", "Ana, Ben and Cy". */
const nameList = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

/**
 * What an offer's state means to the viewer (`me`, null for a spectator), in words. An open
 * end offer says how long is left unless `countdown` is false (live-region announcements).
 */
export const offerText = (offer: RoomOfferFrame, me: number | null, countdown = true): string => {
  const mine = offer.by === me;
  const waiting = offer.waiting.length === 0 ? '' : ` Waiting for ${nameList(offer.waiting)}.`;
  if (offer.kind === 'rematch') {
    switch (offer.status) {
      case 'open':
        if (mine) return `You offered a rematch.${waiting}`;
        if (me !== null && offer.accepted.includes(me)) return `You accepted ${offer.byName}'s rematch.${waiting}`;
        return `${offer.byName} offers a rematch.`;
      case 'declined':
        return `${offer.declinedBy === me ? 'You' : (offer.declinedName ?? 'Someone')} declined the rematch.`;
      case 'withdrawn':
        return mine ? 'You withdrew your rematch offer.' : `${offer.byName} withdrew the rematch offer.`;
    }
  }
  switch (offer.status) {
    case 'open': {
      const left =
        countdown && offer.seconds !== null
          ? ` It ends in ${formatElapsed(offer.seconds * 1000)} unless someone declines.`
          : '';
      if (mine) return `You asked to end the match.${left}`;
      if (me !== null && offer.accepted.includes(me)) return `You agreed to end the match.${left}`;
      return `${offer.byName} asks to end the match with no result.${left}`;
    }
    case 'declined':
      return `${offer.declinedBy === me ? 'You' : (offer.declinedName ?? 'Someone')} declined to end the match.`;
    case 'withdrawn':
      return mine
        ? 'You withdrew your offer to end the match.'
        : `${offer.byName} withdrew the offer to end the match.`;
  }
};

/**
 * What to announce (politely) when the room's offer changed: a new offer, an answer, or
 * nothing. `seats` names the players who accepted.
 */
export const offerAnnouncement = (
  before: RoomOfferFrame | null,
  after: RoomOfferFrame | null,
  me: number | null,
  seats: readonly RoomSeat[],
): string | null => {
  if (after === null) return null;
  if (before === null || before.id !== after.id || before.status !== after.status) return offerText(after, me, false);
  const joined = after.accepted.filter((seat) => !before.accepted.includes(seat) && seat !== me);
  const names = joined.flatMap((seat) =>
    seats.filter((s) => s.id === seat && s.controller === 'human').map((s) => s.name),
  );
  return names.length === 0 ? null : `${nameList(names)} accepted.`;
};

/** Seats a player or the computer fills. */
export const filledSeats = (room: RoomFrame): readonly RoomSeat[] =>
  room.seats.filter((s) => s.claimed || s.controller === 'ai');

/** Why the host can't start yet, or null when the match can start (the room checks again). */
export const startProblem = (room: RoomFrame): string | null => {
  const filled = filledSeats(room);
  if (filled.length < room.minSeats) {
    return `Waiting for ${room.minSeats - filled.length === 1 ? 'another player' : `${String(room.minSeats - filled.length)} more players`}. Share the link, or add the computer.`;
  }
  const waiting = filled.filter((s) => s.controller === 'human' && (!s.ready || !s.connected));
  if (waiting.length > 0) return `Waiting for ${waiting.map((s) => s.name).join(' and ')} to be ready.`;
  return null;
};

/**
 * A new mode keeps the AI level, and fits the player count to the mode: a count the player
 * chose carries over when the new mode allows it. In a game that declares a default, a count
 * still at the old mode's starting count was never chosen, so the new mode starts at its own.
 */
export const pickMode = (game: LauncherGame, setup: Setup, mode: Mode): Setup => {
  const counts = playerCounts(game, mode);
  const untouched = game.players.default !== undefined && setup.players === startingCount(game, setup.mode);
  const players = counts.includes(setup.players) && !untouched ? setup.players : startingCount(game, mode);
  return { ...setup, mode, players, errors: [] };
};

/** The name a seat gets when its field is left empty. */
export const defaultName = (seat: number): string => `Player ${String(seat + 1)}`;

/** An empty name on a human seat means "the guest's own display name"; the stage fills it in. */
export const GUEST_NAME = '';

/**
 * The seats for a setup, numbered from 0, or a problem per pass-and-play name. Solo and
 * vs-AI play seat the guest first; AI seats are named for the computer.
 */
export const seatsFor = (
  game: LauncherGame,
  setup: Setup,
):
  | { readonly ok: true; readonly seats: readonly SeatInfo[] }
  | { readonly ok: false; readonly errors: readonly (string | null)[] } => {
  switch (setup.mode) {
    case 'solo':
    case 'daily':
      return { ok: true, seats: [{ id: 0, name: GUEST_NAME, controller: 'human' }] };
    case 'ai': {
      const level = setup.aiLevel ?? game.aiLevels[0] ?? 'default';
      const opponents = setup.players - 1;
      const seats: SeatInfo[] = [{ id: 0, name: GUEST_NAME, controller: 'human' }];
      for (let n = 1; n <= opponents; n += 1) {
        seats.push({
          id: n,
          name: opponents === 1 ? 'Computer' : `Computer ${String(n)}`,
          controller: 'ai',
          aiLevel: level,
        });
      }
      return { ok: true, seats };
    }
    case 'pass-and-play': {
      const names: string[] = [];
      const errors: (string | null)[] = [];
      for (let seat = 0; seat < setup.players; seat += 1) {
        const typed = setup.names[seat]?.trim() ?? '';
        if (typed === '') {
          names.push(defaultName(seat));
          errors.push(null);
          continue;
        }
        const checked = checkDisplayName(typed);
        names.push(checked.ok ? checked.value : typed);
        errors.push(checked.ok ? null : checked.error.message);
      }
      names.forEach((name, seat) => {
        if (errors[seat] === null && names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== seat) {
          errors[seat] = 'Each player needs a different name.';
        }
      });
      if (errors.some((e) => e !== null)) return { ok: false, errors };
      const people: SeatInfo[] = names.map((name, id) => ({ id, name, controller: 'human' }));
      const level = setup.aiLevel ?? game.aiLevels[0] ?? 'default';
      const computers = computerSeatsFor(game, setup);
      for (let n = 1; n <= computers; n += 1) {
        people.push({
          id: people.length,
          name: computers === 1 ? 'Computer' : `Computer ${String(n)}`,
          controller: 'ai',
          aiLevel: level,
        });
      }
      return { ok: true, seats: people };
    }
    default:
      return { ok: false, errors: [] };
  }
};

// --- The stage: what the launcher asks of it, and what it reports -----------------------------

/** How to start: a new game, the saved one, or not yet (only load and look for a save). */
export type Begin = 'new' | 'resume' | null;

/**
 * What the launcher's view hands the stage element that runs the game. Plain data: the
 * stage acts on changes (begin, pause, a new reveal, new preferences).
 */
export type StageControl = {
  readonly gameId: string;
  readonly mode: StageMode;
  readonly seats: readonly SeatInfo[];
  readonly begin: Begin;
  /** True while the platform overlay is open. */
  readonly paused: boolean;
  /** How many hand-offs the players have revealed. Each increase reveals one. */
  readonly reveals: number;
  /** The player's choices, or null until the stage has read them. */
  readonly preferences: StoredPreferences | null;
  /** A rematch's config (the engine's `rematch`), or null for the game's own setup. */
  readonly config: Json | null;
  /** Online with friends: how to open the room. Null for local play. */
  readonly room: RoomPlan | null;
  /** A validated choice from the resume offer, when this game keeps several saves. */
  readonly resumeSlot?: string;
  readonly setup?: Json;
};

/** A saved game, as the resume offer describes it. */
export type SaveSummary = {
  readonly savedAt: number;
  readonly elapsedMs: number;
  readonly players: readonly string[];
  readonly slot?: string;
  readonly choices?: readonly {
    readonly slot: string;
    readonly label: string;
    readonly savedAt: number;
    readonly elapsedMs: number;
    readonly players: readonly string[];
  }[];
};

/** What the frame needs from each snapshot; the stage reports it only when it changes. */
export type FrameState = {
  readonly seats: readonly SeatInfo[];
  /** Pass-and-play, D-31: the seat the device goes to next, behind the hand-off screen. */
  readonly handoff: { readonly seat: number; readonly name: string } | null;
  readonly outcome: Outcome | null;
  readonly safePoint: boolean;
  /** The latest rejection or problem, worded for players. */
  readonly notice: string | null;
};

/**
 * The daily puzzle's results, as the stage reports them after recording the result
 * (content-pipeline.md, "Results and streaks" and "Share text"). Plain data.
 */
export type DailyFrame = {
  readonly statistics?: DailyWordStats;
  /** The puzzle's UTC date, `yyyy-mm-dd`. */
  readonly date: string;
  /** The share text in both forms: emoji rows, and the rows in words for *Copy as text*. */
  readonly share: string;
  readonly shareWords: string;
  /** Days finished in a row, and the best run. */
  readonly streak: number;
  readonly bestStreak: number;
  /** Days won in a row, for a daily that can be lost; null otherwise. */
  readonly winStreak: number | null;
  readonly bestWinStreak: number | null;
  /** "New puzzle at 8:00 PM (in 6 hours)", in the player's own time. */
  readonly next: string;
  /** Set when today's puzzle was already finished before this visit: its result and summary. */
  readonly earlier: { readonly result: OutcomeResult; readonly summary: string } | null;
};

export type StageOutput =
  | { readonly _tag: 'Prepared'; readonly save: SaveSummary | null; readonly preferences: StoredPreferences }
  /** The player changed a preference in another tab of the site (gp-d4v). */
  | { readonly _tag: 'Preferences'; readonly preferences: StoredPreferences }
  | { readonly _tag: 'Frame'; readonly frame: FrameState }
  | { readonly _tag: 'ExitRequested' }
  | { readonly _tag: 'Announce'; readonly message: string; readonly politeness: 'polite' | 'assertive' }
  | { readonly _tag: 'Notice'; readonly message: string }
  /** At the outcome, when the engine names a rematch config: what "Play again" starts with. */
  | { readonly _tag: 'Rematch'; readonly config: Json }
  /** Online with friends: the room after every change (and each second while a clock runs). */
  | { readonly _tag: 'Room'; readonly room: RoomFrame }
  /** The daily puzzle: its recorded result, streaks and share text, or today's earlier result. */
  | { readonly _tag: 'Daily'; readonly daily: DailyFrame }
  /** The puzzle the game plays, when the stage knows its ID (a daily puzzle): for "Report a problem". */
  | { readonly _tag: 'Puzzle'; readonly puzzleId: string }
  | { readonly _tag: 'Failed'; readonly message: string };

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const isStoredPreferences = (value: unknown): value is StoredPreferences =>
  isRecord(value) &&
  ['system', 'reduce', 'no-preference'].includes(value['reducedMotion'] as string) &&
  typeof value['sound'] === 'boolean' &&
  isNumber(value['volume']) &&
  typeof value['singleKeyShortcuts'] === 'boolean' &&
  ['system', 'light', 'dark'].includes(value['theme'] as string) &&
  (value['locale'] === null || typeof value['locale'] === 'string') &&
  (value['aiContentAccepted'] === undefined || typeof value['aiContentAccepted'] === 'boolean');

const isSeat = (value: unknown): value is SeatInfo =>
  isRecord(value) &&
  Number.isInteger(value['id']) &&
  typeof value['name'] === 'string' &&
  (value['controller'] === 'human' || value['controller'] === 'ai');

const isOutcome = (value: unknown): value is Outcome =>
  isRecord(value) &&
  ['won', 'lost', 'draw', 'completed', 'abandoned'].includes(value['result'] as string) &&
  Array.isArray(value['placements']) &&
  typeof value['summary'] === 'string';

const isFrame = (value: unknown): value is FrameState =>
  isRecord(value) &&
  Array.isArray(value['seats']) &&
  value['seats'].every(isSeat) &&
  (value['handoff'] === null ||
    (isRecord(value['handoff']) &&
      Number.isInteger(value['handoff']['seat']) &&
      typeof value['handoff']['name'] === 'string')) &&
  (value['outcome'] === null || isOutcome(value['outcome'])) &&
  typeof value['safePoint'] === 'boolean' &&
  (value['notice'] === null || typeof value['notice'] === 'string');

const isClockSetting = (value: unknown): value is ClockSetting =>
  isRecord(value) &&
  ['move', 'bank', 'off'].includes(value['kind'] as string) &&
  parseClockValue(clockValue(value as ClockSetting)) !== undefined;

const isRoomSeat = (value: unknown): value is RoomSeat =>
  isRecord(value) &&
  Number.isInteger(value['id']) &&
  typeof value['name'] === 'string' &&
  (value['controller'] === 'human' || value['controller'] === 'ai') &&
  (value['aiLevel'] === null || typeof value['aiLevel'] === 'string') &&
  typeof value['claimed'] === 'boolean' &&
  typeof value['ready'] === 'boolean' &&
  typeof value['connected'] === 'boolean';

const isSeatOrNull = (value: unknown): value is number | null => value === null || Number.isInteger(value);

const isOfferFrame = (value: unknown): value is RoomOfferFrame =>
  isRecord(value) &&
  Number.isInteger(value['id']) &&
  (value['kind'] === 'rematch' || value['kind'] === 'end') &&
  Number.isInteger(value['by']) &&
  typeof value['byName'] === 'string' &&
  ['open', 'declined', 'withdrawn'].includes(value['status'] as string) &&
  Array.isArray(value['accepted']) &&
  value['accepted'].every((seat) => Number.isInteger(seat)) &&
  isSeatOrNull(value['declinedBy']) &&
  (value['declinedName'] === null || typeof value['declinedName'] === 'string') &&
  isStringArray(value['waiting']) &&
  (value['seconds'] === null || isNumber(value['seconds']));

const isRoomFrame = (value: unknown): value is RoomFrame => {
  if (!isRecord(value)) return false;
  const timer = value['timer'];
  const options = value['clockOptions'];
  return (
    isRoomCode(value['code']) &&
    typeof value['link'] === 'string' &&
    ['connecting', 'lobby', 'playing', 'finished', 'closed'].includes(value['phase'] as string) &&
    ['connecting', 'online', 'reconnecting', 'closed'].includes(value['connection'] as string) &&
    isSeatOrNull(value['seat']) &&
    isSeatOrNull(value['host']) &&
    Array.isArray(value['seats']) &&
    value['seats'].every(isRoomSeat) &&
    Number.isInteger(value['minSeats']) &&
    isClockSetting(value['clock']) &&
    Array.isArray(options) &&
    options.every((o) => isRecord(o) && typeof o['value'] === 'string' && typeof o['label'] === 'string') &&
    (value['aiLevel'] === null || typeof value['aiLevel'] === 'string') &&
    isStringArray(value['aiLevels']) &&
    Number.isInteger(value['spectators']) &&
    (timer === null ||
      (isRecord(timer) &&
        Number.isInteger(timer['seat']) &&
        typeof timer['name'] === 'string' &&
        isNumber(timer['seconds']) &&
        typeof timer['paused'] === 'boolean')) &&
    (value['notice'] === null || typeof value['notice'] === 'string') &&
    (value['noticeCode'] === null || typeof value['noticeCode'] === 'string') &&
    Number.isInteger(value['match']) &&
    (value['offer'] === null || isOfferFrame(value['offer']))
  );
};

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

const isDailyFrame = (value: unknown): value is DailyFrame => {
  if (!isRecord(value)) return false;
  const earlier = value['earlier'];
  return (
    typeof value['date'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value['date']) &&
    typeof value['share'] === 'string' &&
    typeof value['shareWords'] === 'string' &&
    isCount(value['streak']) &&
    isCount(value['bestStreak']) &&
    (value['winStreak'] === null || isCount(value['winStreak'])) &&
    (value['bestWinStreak'] === null || isCount(value['bestWinStreak'])) &&
    typeof value['next'] === 'string' &&
    (value['statistics'] === undefined || dailyWordStatsSchema.safeParse(value['statistics']).success) &&
    (earlier === null ||
      (isRecord(earlier) &&
        ['won', 'lost', 'draw', 'completed', 'abandoned'].includes(earlier['result'] as string) &&
        typeof earlier['summary'] === 'string'))
  );
};

const savePart = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const validSaveSummary = (value: unknown): value is SaveSummary => {
  if (
    !isRecord(value) ||
    !isNumber(value['savedAt']) ||
    !isNumber(value['elapsedMs']) ||
    !isStringArray(value['players'])
  )
    return false;
  if (value['slot'] !== undefined && !savePart(value['slot'])) return false;
  const choices = value['choices'];
  return (
    choices === undefined ||
    (Array.isArray(choices) &&
      choices.length > 0 &&
      choices.every(
        (c) =>
          isRecord(c) &&
          savePart(c['slot']) &&
          typeof c['label'] === 'string' &&
          c['label'].length > 0 &&
          c['label'].length <= 100 &&
          isNumber(c['savedAt']) &&
          isNumber(c['elapsedMs']) &&
          isStringArray(c['players']),
      ) &&
      new Set(choices.map((c) => (c as { slot: string }).slot)).size === choices.length &&
      choices.some((c) => (c as { slot: string }).slot === value['slot']))
  );
};
const saveSummarySchema: Validator<SaveSummary> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) =>
      validSaveSummary(raw) ? { value: raw } : { issues: [{ message: 'Expected a validated saved-game offer.' }] },
  },
};
const isSaveSummary = (raw: unknown): raw is SaveSummary => {
  const p = saveSummarySchema['~standard'].validate(raw);
  return !(p instanceof Promise) && p.issues === undefined;
};

/** Checks a stage report at the boundary; anything unexpected is dropped. */
export const parseStageOutput = (value: unknown): StageOutput | undefined => {
  if (!isRecord(value)) return undefined;
  switch (value['_tag']) {
    case 'Prepared':
      return (value['save'] === null || isSaveSummary(value['save'])) && isStoredPreferences(value['preferences'])
        ? { _tag: 'Prepared', save: value['save'], preferences: value['preferences'] }
        : undefined;
    case 'Preferences':
      return isStoredPreferences(value['preferences'])
        ? { _tag: 'Preferences', preferences: value['preferences'] }
        : undefined;
    case 'Frame':
      return isFrame(value['frame']) ? { _tag: 'Frame', frame: value['frame'] } : undefined;
    case 'ExitRequested':
      return { _tag: 'ExitRequested' };
    case 'Rematch':
      return isJson(value['config']) ? { _tag: 'Rematch', config: value['config'] } : undefined;
    case 'Room':
      return isRoomFrame(value['room']) ? { _tag: 'Room', room: value['room'] } : undefined;
    case 'Daily':
      return isDailyFrame(value['daily']) ? { _tag: 'Daily', daily: value['daily'] } : undefined;
    case 'Puzzle':
      return typeof value['puzzleId'] === 'string' &&
        /^[a-z0-9-]+(:[a-z0-9-]+)+$/.test(value['puzzleId']) &&
        value['puzzleId'].length <= 120
        ? { _tag: 'Puzzle', puzzleId: value['puzzleId'] }
        : undefined;
    case 'Announce':
      return typeof value['message'] === 'string' &&
        (value['politeness'] === 'polite' || value['politeness'] === 'assertive')
        ? { _tag: 'Announce', message: value['message'], politeness: value['politeness'] }
        : undefined;
    case 'Notice':
    case 'Failed':
      return typeof value['message'] === 'string' ? { _tag: value['_tag'], message: value['message'] } : undefined;
    default:
      return undefined;
  }
};

// --- Results ------------------------------------------------------------------------------

export type ResultView = {
  readonly result: OutcomeResult;
  readonly headline: string;
  readonly summary: string;
  readonly elapsedMs: number | null;
  /** "Assisted: 2 undos, hints", or null for an unassisted game. */
  readonly assisted: string | null;
};

/** "0:42", "12:05", "1:02:03". */
export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes)}:${seconds}`;
};

/** An ISO 8601 duration for `<time datetime>`: "PT1M5S". */
export const isoDuration = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `PT${hours > 0 ? `${String(hours)}H` : ''}${minutes > 0 ? `${String(minutes)}M` : ''}${String(seconds)}S`;
};

const ASSIST_WORDS: Readonly<Record<Exclude<AssistKind, 'undo'>, string>> = {
  hint: 'hints',
  check: 'checks',
  reveal: 'reveals',
  shuffle: 'shuffles',
};

/** The assistance line for an outcome, from what the runner recorded, or null when there was none. */
export const assistLine = (outcome: Outcome): string | null => {
  const undos = outcome.undosUsed ?? 0;
  const kinds = new Set<AssistKind>(outcome.assists ?? []);
  if (undos > 0) kinds.add('undo');
  const parts = ASSIST_KINDS.filter((kind) => kinds.has(kind)).map((kind) =>
    kind === 'undo' ? (undos > 1 ? `${String(undos)} undos` : undos === 1 ? '1 undo' : 'undo') : ASSIST_WORDS[kind],
  );
  return parts.length === 0 ? null : `Assisted: ${parts.join(', ')}`;
};

const nameOf = (seats: readonly SeatInfo[], seat: number | undefined): string =>
  seats.find((s) => s.id === seat)?.name ?? 'Someone';

/**
 * The results screen's words for an outcome. In a room the headline depends on who is
 * looking: `viewer` is the player's seat, or null for a spectator, who hears who won.
 */
export const resultView = (
  outcome: Outcome,
  seats: readonly SeatInfo[],
  mode: StageMode,
  viewer: number | null = null,
): ResultView => {
  const winner = outcome.placements.find((p) => p.place === 1)?.seat;
  const headline = ((): string => {
    switch (outcome.result) {
      case 'won':
        if (mode === 'server') {
          if (viewer === null) return `${nameOf(seats, winner)} wins!`;
          return outcome.placements.find((p) => p.seat === viewer)?.place === 1
            ? 'You won!'
            : `${nameOf(seats, winner)} wins`;
        }
        return mode === 'pass-and-play' ? `${nameOf(seats, winner)} wins!` : 'You won!';
      case 'lost':
        return 'You lost';
      case 'draw':
        return "It's a draw";
      case 'completed':
        return 'Complete!';
      case 'abandoned':
        return 'Game over';
    }
  })();
  return {
    result: outcome.result,
    headline,
    summary: outcome.summary,
    elapsedMs: outcome.elapsedMs ?? null,
    assisted: assistLine(outcome),
  };
};

// --- Preferences --------------------------------------------------------------------------

/** One preference control's change, parsed from its name and value, or undefined if invalid. */
export const parsePreferenceChange = (
  name: string,
  value: string | undefined,
  checked: boolean | undefined,
): Partial<StoredPreferences> | undefined => {
  switch (name) {
    case 'reducedMotion':
      return value === 'system' || value === 'reduce' || value === 'no-preference'
        ? { reducedMotion: value }
        : undefined;
    case 'theme':
      return value === 'system' || value === 'light' || value === 'dark' ? { theme: value } : undefined;
    case 'sound':
      return checked === undefined ? undefined : { sound: checked };
    case 'singleKeyShortcuts':
      return checked === undefined ? undefined : { singleKeyShortcuts: checked };
    case 'aiContentAccepted':
      return checked === undefined ? undefined : { aiContentAccepted: checked };
    case 'volume': {
      const percent = Number(value);
      return value !== undefined && value !== '' && Number.isInteger(percent) && percent >= 0 && percent <= 100
        ? { volume: percent / 100 }
        : undefined;
    }
    default:
      return undefined;
  }
};
