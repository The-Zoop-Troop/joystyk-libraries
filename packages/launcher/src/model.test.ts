// The launcher's pure helpers: modes, seats, stage reports, results and preferences.
import { DEFAULT_PREFERENCES } from '@joystyk/storage';
import { describe, expect, it } from 'vitest';
import { tallyManifest } from './fixture/index.ts';
import {
  accessGate,
  assistLine,
  clockLabel,
  clockOptions,
  clockValue,
  computerSeatsFor,
  formatElapsed,
  initialSetup,
  isLauncherGame,
  isoDuration,
  launcherGame,
  modeOptions,
  needsAiNotice,
  offerAnnouncement,
  offerText,
  parseClockValue,
  parsePreferenceChange,
  parseRoomCode,
  parseStageOutput,
  pickMode,
  playerCounts,
  startingCount,
  resultView,
  seatsFor,
  GUEST_NAME,
  spacedCode,
  startProblem,
  hostedOnline,
  ONLINE_CHECKING,
  ONLINE_UNREACHABLE,
  parseHostedGames,
  type LauncherGame,
  type OnlineRooms,
  type RoomFrame,
  type RoomOfferFrame,
} from './model.ts';

const tally = launcherGame(tallyManifest);
const hearts: LauncherGame = {
  id: 'hearts',
  name: 'Hearts',
  modes: ['ai', 'server'],
  players: { min: 4, max: 4 },
  aiLevels: ['easy', 'hard'],
  status: 'available',
};
/** The room server hosts Tally (and Nim), not Hearts. */
const hosted: OnlineRooms = { _tag: 'Hosted', games: ['test-tally', 'nim'], protocol: 1 };

describe('the game a page hands the launcher', () => {
  it('comes from the manifest and passes its own check', () => {
    expect(tally).toEqual({
      id: 'test-tally',
      name: 'Tally',
      modes: ['solo', 'ai', 'pass-and-play', 'server'],
      players: { min: 1, max: 2 },
      aiLevels: ['easy', 'hard'],
      status: 'available',
      aiContent: false,
    });
    expect(isLauncherGame(tally)).toBe(true);
    expect(isLauncherGame({ ...tally, aiContent: undefined })).toBe(true);
    expect(isLauncherGame({ ...tally, aiContent: 'yes' })).toBe(false);
    expect(isLauncherGame({ ...tally, id: 'Not An Id' })).toBe(false);
    expect(isLauncherGame({ ...tally, modes: ['solo', 'arcade'] })).toBe(false);
    expect(isLauncherGame({ ...tally, status: 'maybe' })).toBe(false);
  });

  it('opens the access gate for free games (the v2 premium gate is a no-op)', () => {
    expect(accessGate('free')).toBe('open');
  });

  it('locks AI-content games until the player accepts the notice (D-44)', () => {
    const ai = launcherGame({ ...tallyManifest, aiContent: true });
    expect(ai.aiContent).toBe(true);
    expect(needsAiNotice(ai, DEFAULT_PREFERENCES)).toBe(true);
    expect(needsAiNotice(ai, { ...DEFAULT_PREFERENCES, aiContentAccepted: false })).toBe(true);
    expect(needsAiNotice(ai, { ...DEFAULT_PREFERENCES, aiContentAccepted: true })).toBe(false);
    expect(needsAiNotice(tally, DEFAULT_PREFERENCES)).toBe(false);
  });
});

describe('modes', () => {
  it('offers the local modes, server rooms and the daily puzzle, and shows P2P rooms as coming soon', () => {
    expect(modeOptions(tally, hosted)).toEqual([
      { mode: 'solo', label: 'Solo', playable: true, note: null },
      { mode: 'ai', label: 'Against the computer', playable: true, note: null },
      { mode: 'pass-and-play', label: 'Pass and play', playable: true, note: null },
      { mode: 'server', label: 'Online with friends', playable: true, note: null },
    ]);
    expect(modeOptions({ ...tally, modes: ['p2p', 'daily'] })).toEqual([
      { mode: 'p2p', label: 'Online, peer to peer', playable: false, note: 'Coming soon' },
      { mode: 'daily', label: 'Daily puzzle', playable: true, note: null },
    ]);
    expect(
      modeOptions({ ...tally, players: { min: 1, max: 1 } }, hosted).find((o) => o.mode === 'server'),
    ).toMatchObject({ playable: false, note: null });
  });

  it('offers the daily puzzle to one player, seated as the guest', () => {
    // A daily puzzle is one player's: a game for two or more can't offer it.
    expect(modeOptions({ ...tally, modes: ['daily'], players: { min: 2, max: 2 } })[0]?.playable).toBe(false);
    expect(
      seatsFor({ ...tally, modes: ['daily'] }, { ...initialSetup({ ...tally, modes: ['daily'] }), mode: 'daily' }),
    ).toEqual({
      ok: true,
      seats: [{ id: 0, name: GUEST_NAME, controller: 'human' }],
    });
  });

  it('offers Online with friends only for a game the room server hosts (D-53)', () => {
    const server = (game: LauncherGame, online: OnlineRooms) =>
      modeOptions(game, online).find((o) => o.mode === 'server');
    // Hosted: playable. Listed in the manifest but not hosted: coming soon.
    expect(server(tally, hosted)).toEqual({ mode: 'server', label: 'Online with friends', playable: true, note: null });
    expect(server(hearts, hosted)).toEqual({
      mode: 'server',
      label: 'Online with friends',
      playable: false,
      note: 'Coming soon',
    });
    expect(hostedOnline(tally, hosted)).toBe(true);
    expect(hostedOnline(hearts, hosted)).toBe(false);
    // Until the room server answers, not yet playable and nothing to say.
    expect(server(tally, ONLINE_CHECKING)).toMatchObject({ playable: false, note: null });
    expect(modeOptions(tally)).toEqual(modeOptions(tally, ONLINE_CHECKING));
    // Unreachable: online is unavailable, and every local mode still plays.
    expect(server(tally, ONLINE_UNREACHABLE)).toMatchObject({ playable: false, note: 'Unavailable right now' });
    for (const online of [ONLINE_CHECKING, ONLINE_UNREACHABLE, hosted]) {
      expect(
        modeOptions(tally, online)
          .filter((o) => o.mode !== 'server')
          .every((o) => o.playable),
      ).toBe(true);
    }
    // A coming-soon game says so once, in its hint, not per mode.
    expect(server({ ...tally, status: 'coming-soon' }, ONLINE_UNREACHABLE)).toMatchObject({
      playable: false,
      note: null,
    });
  });

  it('starts a server-only game on online play once the room server answers', () => {
    const online: LauncherGame = { ...hearts, modes: ['server'], id: 'nim' };
    expect(initialSetup(online).mode).toBeNull();
    expect(initialSetup(online, hosted).mode).toBe('server');
    expect(initialSetup(online, ONLINE_UNREACHABLE).mode).toBeNull();
  });

  it('reads the room server’s answer at the boundary', () => {
    expect(parseHostedGames({ protocol: 1, protocols: [1], games: ['nim', 'shift-23'] })).toEqual({
      _tag: 'Hosted',
      games: ['nim', 'shift-23'],
      protocol: 1,
    });
    expect(parseHostedGames({ protocol: 1, games: [] })).toEqual({ _tag: 'Hosted', games: [], protocol: 1 });
    for (const bad of [
      null,
      '<!doctype html>',
      [],
      { games: ['nim'] },
      { protocol: 0, games: [] },
      { protocol: 1, games: ['Not An Id'] },
      { protocol: 1, games: 'nim' },
    ]) {
      expect(parseHostedGames(bad)).toBeUndefined();
    }
  });

  it('offers nothing playable for a game that is coming soon', () => {
    expect(modeOptions({ ...tally, status: 'coming-soon' }).some((o) => o.playable)).toBe(false);
    expect(initialSetup({ ...tally, status: 'coming-soon' }).mode).toBeNull();
  });

  it("doesn't offer vs-AI play to a game without AI, or solo to a game for four", () => {
    expect(modeOptions({ ...tally, aiLevels: [] }).find((o) => o.mode === 'ai')?.playable).toBe(false);
    expect(modeOptions({ ...hearts, modes: ['solo', 'ai'] }).map((o) => o.playable)).toEqual([false, true]);
  });

  it('counts players per mode', () => {
    expect(playerCounts(tally, 'solo')).toEqual([1]);
    expect(playerCounts(tally, 'pass-and-play')).toEqual([2]);
    expect(playerCounts(hearts, 'ai')).toEqual([4]);
    // Pass-and-play counts people; the computer fills the rest of a game with AI.
    expect(playerCounts(hearts, 'pass-and-play')).toEqual([2, 3, 4]);
    expect(playerCounts({ ...hearts, aiLevels: [] }, 'pass-and-play')).toEqual([4]);
    expect(playerCounts({ ...hearts, players: { min: 1, max: 5 } }, 'ai')).toEqual([2, 3, 4, 5]);
  });

  it('starts on the first playable mode and keeps the count valid when the mode changes', () => {
    const setup = initialSetup(tally);
    expect(setup).toEqual({
      mode: 'solo',
      aiLevel: 'easy',
      players: 1,
      names: [],
      errors: [],
      code: '',
      watch: false,
      codeError: null,
      options: {},
    });
    expect(pickMode(tally, setup, 'pass-and-play').players).toBe(2);
    expect(initialSetup(hearts)).toMatchObject({ mode: 'ai', players: 4 });
  });

  it('starts vs-AI play at the declared default, and every other mode at its fewest', () => {
    const table: LauncherGame = {
      ...hearts,
      modes: ['ai', 'pass-and-play', 'server'],
      players: { min: 1, max: 5, default: 5 },
    };
    expect(startingCount(table, 'ai')).toBe(5);
    expect(startingCount({ ...table, players: { min: 1, max: 5 } }, 'ai')).toBe(2);
    expect(startingCount(table, 'pass-and-play')).toBe(2);
    // A room sizes itself from its lobby (D-58), so the default never reaches it.
    expect(startingCount(table, 'server')).toBe(1);
    // A default the mode doesn't offer falls back to the fewest.
    expect(startingCount({ ...table, players: { min: 1, max: 5, default: 9 } }, 'ai')).toBe(2);
    const setup = initialSetup(table);
    expect(setup).toMatchObject({ mode: 'ai', players: 5 });
    expect(launcherGame({ ...tallyManifest, players: { min: 1, max: 2, default: 2 } }).players).toEqual({
      min: 1,
      max: 2,
      default: 2,
    });
    expect(isLauncherGame({ ...tally, players: { min: 1, max: 2, default: 1.5 } })).toBe(false);
  });

  it('moves an untouched default to the new mode’s start, and keeps a count the player chose', () => {
    const table: LauncherGame = {
      ...hearts,
      modes: ['ai', 'pass-and-play', 'server'],
      players: { min: 1, max: 5, default: 5 },
    };
    const setup = initialSetup(table);
    const local = pickMode(table, setup, 'pass-and-play');
    expect(local.players).toBe(2);
    expect(pickMode(table, local, 'ai').players).toBe(5);
    expect(pickMode(table, pickMode(table, setup, 'server'), 'ai').players).toBe(5);
    const three = { ...setup, players: 3 };
    expect(pickMode(table, three, 'pass-and-play').players).toBe(3);
    expect(pickMode(table, pickMode(table, three, 'pass-and-play'), 'ai').players).toBe(3);
    expect(pickMode(table, setup, 'ai').players).toBe(5);
  });
});

describe('seats', () => {
  it('seats the guest alone in solo play, named later from their profile', () => {
    expect(seatsFor(tally, initialSetup(tally))).toEqual({
      ok: true,
      seats: [{ id: 0, name: '', controller: 'human' }],
    });
  });

  it('seats computer opponents at the chosen level', () => {
    const setup = { ...pickMode(hearts, initialSetup(hearts), 'ai'), aiLevel: 'hard' };
    const seats = seatsFor(hearts, setup);
    expect(seats).toEqual({
      ok: true,
      seats: [
        { id: 0, name: '', controller: 'human' },
        { id: 1, name: 'Computer 1', controller: 'ai', aiLevel: 'hard' },
        { id: 2, name: 'Computer 2', controller: 'ai', aiLevel: 'hard' },
        { id: 3, name: 'Computer 3', controller: 'ai', aiLevel: 'hard' },
      ],
    });
    expect(seatsFor(tally, pickMode(tally, initialSetup(tally), 'ai'))).toMatchObject({
      ok: true,
      seats: [{ name: '' }, { name: 'Computer', aiLevel: 'easy' }],
    });
  });

  it('names pass-and-play seats, filling blanks and normalizing what was typed', () => {
    const setup = { ...pickMode(tally, initialSetup(tally), 'pass-and-play'), names: ['  Ada   Byte ', ''] };
    expect(seatsFor(tally, setup)).toEqual({
      ok: true,
      seats: [
        { id: 0, name: 'Ada Byte', controller: 'human' },
        { id: 1, name: 'Player 2', controller: 'human' },
      ],
    });
  });

  it('fills the seats pass-and-play leaves empty with the computer, at the chosen level', () => {
    const local: LauncherGame = { ...hearts, modes: ['ai', 'pass-and-play'], aiLevels: ['easy', 'medium', 'hard'] };
    const setup = {
      ...pickMode(local, initialSetup(local), 'pass-and-play'),
      players: 2,
      names: ['Ada', 'Bea'],
      aiLevel: 'medium',
    };
    expect(computerSeatsFor(local, setup)).toBe(2);
    expect(seatsFor(local, setup)).toEqual({
      ok: true,
      seats: [
        { id: 0, name: 'Ada', controller: 'human' },
        { id: 1, name: 'Bea', controller: 'human' },
        { id: 2, name: 'Computer 1', controller: 'ai', aiLevel: 'medium' },
        { id: 3, name: 'Computer 2', controller: 'ai', aiLevel: 'medium' },
      ],
    });
    expect(computerSeatsFor(local, { ...setup, players: 4 })).toBe(0);
    expect(computerSeatsFor(tally, pickMode(tally, initialSetup(tally), 'pass-and-play'))).toBe(0);
  });

  it('refuses names the filter refuses, and two seats with one name', () => {
    const base = pickMode(tally, initialSetup(tally), 'pass-and-play');
    const refused = seatsFor(tally, { ...base, names: ['Ad', 'Bo Bo'] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.errors[0]).toMatch(/at least 3/i);
      expect(refused.errors[1]).toBeNull();
    }
    const twins = seatsFor(tally, { ...base, names: ['Ada', 'ada'] });
    expect(twins).toEqual({ ok: false, errors: [null, 'Each player needs a different name.'] });
  });
});

describe('stage reports', () => {
  const preferences = {
    reducedMotion: 'system',
    sound: true,
    volume: 0.8,
    singleKeyShortcuts: true,
    theme: 'system',
    locale: null,
  };
  const frame = {
    seats: [{ id: 0, name: 'Ada', controller: 'human' }],
    handoff: null,
    outcome: null,
    safePoint: false,
    notice: null,
  };
  const daily = {
    date: '2026-10-08',
    share: 'Word of the Day 2026-10-08 2/3\n✅❌✅',
    shareWords: 'Word of the Day 2026-10-08 2/3\nMeaning: right.',
    streak: 3,
    bestStreak: 5,
    winStreak: null,
    bestWinStreak: null,
    next: 'New puzzle at 8:00 PM (in 6 hours)',
    earlier: null,
  };

  it('accepts well-formed reports', () => {
    expect(parseStageOutput({ _tag: 'Prepared', save: null, preferences })).toEqual({
      _tag: 'Prepared',
      save: null,
      preferences,
    });
    expect(
      parseStageOutput({ _tag: 'Prepared', save: { savedAt: 1, elapsedMs: 2, players: ['Ada'] }, preferences })?._tag,
    ).toBe('Prepared');
    expect(parseStageOutput({ _tag: 'Preferences', preferences })).toEqual({ _tag: 'Preferences', preferences });
    expect(parseStageOutput({ _tag: 'Frame', frame })).toEqual({ _tag: 'Frame', frame });
    expect(parseStageOutput({ _tag: 'Frame', frame: { ...frame, handoff: { seat: 1, name: 'Bo' } } })?._tag).toBe(
      'Frame',
    );
    expect(parseStageOutput({ _tag: 'ExitRequested' })).toEqual({ _tag: 'ExitRequested' });
    expect(parseStageOutput({ _tag: 'Rematch', config: { firstSeat: 1 } })).toEqual({
      _tag: 'Rematch',
      config: { firstSeat: 1 },
    });
    expect(
      parseStageOutput({ _tag: 'Prepared', save: null, preferences: { ...preferences, aiContentAccepted: true } })
        ?._tag,
    ).toBe('Prepared');
    expect(parseStageOutput({ _tag: 'Announce', message: 'Hi', politeness: 'polite' })).toEqual({
      _tag: 'Announce',
      message: 'Hi',
      politeness: 'polite',
    });
    expect(parseStageOutput({ _tag: 'Failed', message: 'No.' })).toEqual({ _tag: 'Failed', message: 'No.' });
    expect(parseStageOutput({ _tag: 'Daily', daily })).toEqual({ _tag: 'Daily', daily });
    expect(
      parseStageOutput({
        _tag: 'Daily',
        daily: { ...daily, winStreak: 2, bestWinStreak: 4, earlier: { result: 'won', summary: '4/6' } },
      })?._tag,
    ).toBe('Daily');
  });

  it('drops anything else', () => {
    expect(parseStageOutput(null)).toBeUndefined();
    expect(
      parseStageOutput({ _tag: 'Prepared', save: null, preferences: { ...preferences, volume: 'loud' } }),
    ).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Frame', frame: { ...frame, safePoint: 'yes' } })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Announce', message: 'Hi', politeness: 'shout' })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Teleport' })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Preferences', preferences: { ...preferences, theme: 'neon' } })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Rematch', config: { at: Number.NaN } })).toBeUndefined();
    expect(
      parseStageOutput({ _tag: 'Prepared', save: null, preferences: { ...preferences, aiContentAccepted: 'yes' } }),
    ).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Daily', daily: { ...daily, date: 'today' } })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Daily', daily: { ...daily, streak: -1 } })).toBeUndefined();
    expect(
      parseStageOutput({ _tag: 'Daily', daily: { ...daily, earlier: { result: 'great', summary: '' } } }),
    ).toBeUndefined();
  });
});

describe('results', () => {
  const seats = [
    { id: 0, name: 'Ada', controller: 'human' as const },
    { id: 1, name: 'Bo', controller: 'human' as const },
  ];

  it('formats play time for people and for <time datetime>', () => {
    expect(formatElapsed(42_400)).toBe('0:42');
    expect(formatElapsed(725_000)).toBe('12:05');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(isoDuration(65_000)).toBe('PT1M5S');
    expect(isoDuration(3_723_000)).toBe('PT1H2M3S');
    expect(isoDuration(0)).toBe('PT0S');
  });

  it('names the winner in pass-and-play and speaks to the player otherwise', () => {
    const won = {
      result: 'won' as const,
      placements: [
        { seat: 1, place: 1 },
        { seat: 0, place: 2 },
      ],
      summary: 'Bo reached 5 first.',
      elapsedMs: 61_000,
    };
    expect(resultView(won, seats, 'pass-and-play')).toEqual({
      result: 'won',
      headline: 'Bo wins!',
      summary: 'Bo reached 5 first.',
      elapsedMs: 61_000,
      assisted: null,
    });
    expect(resultView(won, seats, 'ai').headline).toBe('You won!');
    expect(resultView({ ...won, result: 'lost' }, seats, 'ai').headline).toBe('You lost');
    expect(resultView({ ...won, result: 'draw' }, seats, 'ai').headline).toBe("It's a draw");
    expect(resultView({ ...won, result: 'completed' }, seats, 'solo').headline).toBe('Complete!');
    expect(resultView({ result: 'abandoned', placements: [], summary: 'Gave up.' }, seats, 'solo')).toMatchObject({
      headline: 'Game over',
      elapsedMs: null,
    });
  });

  it('marks assistance from the undo count and the assists the runner recorded', () => {
    const base = { result: 'won' as const, placements: [], summary: '' };
    expect(assistLine(base)).toBeNull();
    expect(assistLine({ ...base, undosUsed: 0, assists: [] })).toBeNull();
    expect(assistLine({ ...base, undosUsed: 1, assists: ['undo'] })).toBe('Assisted: 1 undo');
    expect(assistLine({ ...base, undosUsed: 2, assists: ['undo', 'hint', 'check'] })).toBe(
      'Assisted: 2 undos, hints, checks',
    );
    expect(assistLine({ ...base, assists: ['reveal'] })).toBe('Assisted: reveals');
    expect(resultView({ ...base, assists: ['hint'] }, seats, 'solo').assisted).toBe('Assisted: hints');
  });
});

describe('rooms', () => {
  const room: RoomFrame = {
    code: 'K7M2QX',
    link: 'https://joystyk.test/games/nim?room=K7M2QX',
    phase: 'lobby',
    connection: 'online',
    seat: 0,
    host: 0,
    seats: [
      { id: 0, name: 'Ana', controller: 'human', aiLevel: null, claimed: true, ready: true, connected: true },
      { id: 1, name: 'Seat 2', controller: 'human', aiLevel: null, claimed: false, ready: false, connected: false },
    ],
    minSeats: 2,
    clock: { kind: 'move', ms: 30_000 },
    clockOptions: [],
    aiLevel: null,
    aiLevels: ['easy'],
    spectators: 0,
    timer: null,
    notice: null,
    noticeCode: null,
    match: 0,
    offer: null,
  };

  it('reads a code in any case, with spaces or dashes, or from a whole invite link', () => {
    expect(parseRoomCode('k7m 2qx')).toBe('K7M2QX');
    expect(parseRoomCode(' K7M-2QX ')).toBe('K7M2QX');
    expect(parseRoomCode('https://joystyk.com/games/nim?room=K7M2QX')).toBe('K7M2QX');
    expect(parseRoomCode('K7M2Q0')).toBeNull();
    expect(parseRoomCode('K7M2Q')).toBeNull();
    expect(parseRoomCode('')).toBeNull();
    expect(spacedCode('K7M2QX')).toBe('K7M 2QX');
  });

  it('offers the manifest presets with the usual one marked, then Off, never by default (D-42)', () => {
    expect(clockOptions(null)).toEqual([]);
    expect(clockOptions({ mode: 'move', default: 30, presets: [15, 30, 60] })).toEqual([
      { value: 'move:15000', label: '15 seconds a move' },
      { value: 'move:30000', label: '30 seconds a move (usual)' },
      { value: 'move:60000', label: '1 minute a move' },
      { value: 'off', label: 'Off: no clock' },
    ]);
    const bank = clockOptions({
      mode: 'bank',
      default: { initialMs: 300_000, incrementMs: 2000 },
      presets: [{ initialMs: 300_000, incrementMs: 2000 }],
    });
    expect(bank[0]).toEqual({ value: 'bank:300000:2000', label: '5 minutes, plus 2 seconds a move (usual)' });
    for (const option of [...bank, ...clockOptions({ default: 10, presets: [10] })]) {
      const parsed = parseClockValue(option.value);
      expect(parsed === undefined ? undefined : clockValue(parsed)).toBe(option.value);
    }
    expect(parseClockValue('move:x')).toBeUndefined();
    expect(clockLabel({ kind: 'off' })).toBe('Off');
  });

  it('says why the host cannot start yet', () => {
    expect(startProblem(room)).toBe('Waiting for another player. Share the link, or add the computer.');
    const ben = {
      id: 1,
      name: 'Ben',
      controller: 'human' as const,
      aiLevel: null,
      claimed: true,
      ready: false,
      connected: true,
    };
    expect(startProblem({ ...room, seats: [room.seats[0]!, ben] })).toBe('Waiting for Ben to be ready.');
    expect(startProblem({ ...room, seats: [room.seats[0]!, { ...ben, ready: true }] })).toBeNull();
    expect(startProblem({ ...room, seats: [room.seats[0]!, { ...ben, controller: 'ai', claimed: false }] })).toBeNull();
  });

  it('checks a room report at the boundary', () => {
    expect(parseStageOutput({ _tag: 'Room', room })).toEqual({ _tag: 'Room', room });
    expect(parseStageOutput({ _tag: 'Room', room: { ...room, code: 'nope' } })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Room', room: { ...room, clock: { kind: 'sundial' } } })).toBeUndefined();
    expect(parseStageOutput({ _tag: 'Room', room: { ...room, seats: [{ id: 0 }] } })).toBeUndefined();
    const withOffer = { ...room, offer, timer: { seat: 0, name: 'Ana', seconds: 12, paused: true } };
    expect(parseStageOutput({ _tag: 'Room', room: withOffer })).toEqual({ _tag: 'Room', room: withOffer });
    expect(
      parseStageOutput({ _tag: 'Room', room: { ...room, offer: { ...offer, status: 'accepted' } } }),
    ).toBeUndefined();
    expect(
      parseStageOutput({ _tag: 'Room', room: { ...room, timer: { seat: 0, name: 'Ana', seconds: 12 } } }),
    ).toBeUndefined();
  });

  const offer: RoomOfferFrame = {
    id: 9,
    kind: 'rematch',
    by: 0,
    byName: 'Ana',
    status: 'open',
    accepted: [0, 2],
    declinedBy: null,
    declinedName: null,
    waiting: ['Ben', 'Cy'],
    seconds: null,
  };

  it('words an offer for whoever reads it', () => {
    expect(offerText(offer, 0)).toBe('You offered a rematch. Waiting for Ben and Cy.');
    expect(offerText(offer, 1)).toBe('Ana offers a rematch.');
    expect(offerText({ ...offer, accepted: [0, 1, 2], waiting: ['Cy'] }, 1)).toBe(
      "You accepted Ana's rematch. Waiting for Cy.",
    );
    expect(offerText(offer, null)).toBe('Ana offers a rematch.');
    expect(offerText({ ...offer, status: 'declined', declinedBy: 1, declinedName: 'Ben', waiting: [] }, 0)).toBe(
      'Ben declined the rematch.',
    );
    expect(offerText({ ...offer, status: 'declined', declinedBy: 1, declinedName: 'Ben', waiting: [] }, 1)).toBe(
      'You declined the rematch.',
    );
    expect(offerText({ ...offer, status: 'withdrawn', waiting: [] }, 1)).toBe('Ana withdrew the rematch offer.');
    const ending: RoomOfferFrame = { ...offer, kind: 'end', accepted: [0], waiting: ['Ben'], seconds: 45 };
    expect(offerText(ending, 1)).toBe(
      'Ana asks to end the match with no result. It ends in 0:45 unless someone declines.',
    );
    expect(offerText(ending, 1, false)).toBe('Ana asks to end the match with no result.');
    expect(offerText(ending, 0)).toBe('You asked to end the match. It ends in 0:45 unless someone declines.');
    expect(offerText({ ...ending, status: 'declined', declinedBy: 1, declinedName: 'Ben' }, 0)).toBe(
      'Ben declined to end the match.',
    );
  });

  it('announces a new offer and each answer once, and stays quiet while only the countdown moves', () => {
    const seats = [
      room.seats[0]!,
      { id: 1, name: 'Ben', controller: 'human' as const, aiLevel: null, claimed: true, ready: false, connected: true },
      {
        id: 2,
        name: 'Computer',
        controller: 'ai' as const,
        aiLevel: 'easy',
        claimed: false,
        ready: false,
        connected: false,
      },
    ];
    expect(offerAnnouncement(null, offer, 1, seats)).toBe('Ana offers a rematch.');
    expect(offerAnnouncement(offer, offer, 1, seats)).toBeNull();
    expect(offerAnnouncement(offer, { ...offer, accepted: [0, 2, 1] }, 0, seats)).toBe('Ben accepted.');
    expect(offerAnnouncement(offer, { ...offer, accepted: [0, 2, 1] }, 1, seats)).toBeNull();
    expect(offerAnnouncement(offer, { ...offer, status: 'withdrawn' }, 1, seats)).toBe(
      'Ana withdrew the rematch offer.',
    );
    const ending: RoomOfferFrame = { ...offer, kind: 'end', seconds: 45 };
    expect(offerAnnouncement(ending, { ...ending, seconds: 44 }, 1, seats)).toBeNull();
    expect(offerAnnouncement(offer, null, 1, seats)).toBeNull();
  });

  it('words a room result for the player who reads it', () => {
    const seats = [
      { id: 0, name: 'Ana', controller: 'human' as const },
      { id: 1, name: 'Ben', controller: 'human' as const },
    ];
    const won = {
      result: 'won' as const,
      placements: [
        { seat: 1, place: 1 },
        { seat: 0, place: 2 },
      ],
      summary: 'Ben took the last stone.',
    };
    expect(resultView(won, seats, 'server', 1).headline).toBe('You won!');
    expect(resultView(won, seats, 'server', 0).headline).toBe('Ben wins');
    expect(resultView(won, seats, 'server', null).headline).toBe('Ben wins!');
  });
});

describe('preference controls', () => {
  it('parses each control and refuses anything out of range', () => {
    expect(parsePreferenceChange('reducedMotion', 'reduce', undefined)).toEqual({ reducedMotion: 'reduce' });
    expect(parsePreferenceChange('reducedMotion', 'wobbly', undefined)).toBeUndefined();
    expect(parsePreferenceChange('theme', 'dark', undefined)).toEqual({ theme: 'dark' });
    expect(parsePreferenceChange('sound', 'on', false)).toEqual({ sound: false });
    expect(parsePreferenceChange('singleKeyShortcuts', 'on', true)).toEqual({ singleKeyShortcuts: true });
    expect(parsePreferenceChange('aiContentAccepted', 'on', false)).toEqual({ aiContentAccepted: false });
    expect(parsePreferenceChange('volume', '35', undefined)).toEqual({ volume: 0.35 });
    expect(parsePreferenceChange('volume', '135', undefined)).toBeUndefined();
    expect(parsePreferenceChange('volume', '', undefined)).toBeUndefined();
    expect(parsePreferenceChange('locale', 'en', undefined)).toBeUndefined();
  });
});
