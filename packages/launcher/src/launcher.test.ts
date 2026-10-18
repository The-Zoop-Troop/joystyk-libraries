// <jy-launcher> as a model: messages in, state and commands out. No DOM.
import { callsIn, commandsFor, initial, inputsFor, reject, resolve, run, step } from '@gyral/testing';
import type { Outcome } from '@joystyk/contracts';
import { DEFAULT_PREFERENCES } from '@joystyk/storage';
import { describe, expect, it } from 'vitest';
import { tallyManifest } from './fixture/index.ts';
import {
  freshState,
  isSafePoint,
  Launcher,
  stageLoader,
  type LauncherMsg,
  type LauncherProps,
  type LauncherState,
} from './launcher.ts';
import { launcherGame, type FrameState, type RoomFrame, type StageOutput } from './model.ts';
import { clipboardDriver, inviteDriver, onlineRoomsDriver, roomUrlDriver } from './room-drivers.ts';
import { safePointDriver } from './safe-point.ts';

const { spec } = Launcher;
const props: LauncherProps = { game: launcherGame(tallyManifest) };
/** The room server hosts the Tally fixture. */
const HOSTED = { _tag: 'Hosted', games: ['test-tally'], protocol: 1 } as const;
const live: LauncherState = { ...freshState(props.game), live: true, online: HOSTED };
const out = (o: StageOutput): LauncherMsg => ({ _tag: 'StageOut', out: o });
const prepared = (save: { savedAt: number; elapsedMs: number; players: string[] } | null = null) =>
  out({ _tag: 'Prepared', save, preferences: DEFAULT_PREFERENCES });
const frame = (f: Partial<FrameState> = {}): LauncherMsg =>
  out({
    _tag: 'Frame',
    frame: {
      seats: [{ id: 0, name: 'Ada', controller: 'human' }],
      handoff: null,
      outcome: null,
      safePoint: false,
      notice: null,
      ...f,
    },
  });
const focusTargets = (commands: Parameters<typeof commandsFor>[0]) =>
  commands.filter((c) => c.driver.name === '@gyral/focus').map((c) => JSON.stringify(c.input));
const safePoints = (commands: Parameters<typeof inputsFor>[0]) => inputsFor(commands, safePointDriver);

/** Runs messages from `state`, returning the final state. */
const go = (state: LauncherState, ...msgs: LauncherMsg[]) => run(spec, msgs, { props, state }).state;
const requests = (state: LauncherState, ...msgs: LauncherMsg[]) =>
  callsIn(run(spec, msgs, { props, state }).commands).map((c) => c.args[0]);

describe('<jy-launcher> setup', () => {
  it('server-renders a setup that needs JavaScript, and reports a safe point once live', () => {
    const start = initial(spec, props);
    expect(start.state).toMatchObject({ live: false, phase: { _tag: 'Setup' }, setup: { mode: 'solo' }, safe: true });
    expect(safePoints(start.commands)).toEqual([{ safe: true, gameId: 'test-tally' }]);
    expect(step(spec, start.state, { _tag: 'Hydrated', serverRendered: true }, props).state.live).toBe(true);
  });

  it('ignores Start until hydrated', () => {
    const start = initial(spec, props).state;
    expect(step(spec, start, { _tag: 'Start' }, props).state).toBe(start);
  });

  it('picks only playable modes, valid levels and valid counts', () => {
    expect(step(spec, live, { _tag: 'PickMode', mode: 'p2p' }, props).state).toBe(live);
    const ai = step(spec, live, { _tag: 'PickMode', mode: 'ai' }, props).state;
    expect(ai.setup.mode).toBe('ai');
    expect(step(spec, ai, { _tag: 'PickLevel', level: 'hard' }, props).state.setup.aiLevel).toBe('hard');
    expect(step(spec, ai, { _tag: 'PickLevel', level: 'grandmaster' }, props).state).toBe(ai);
    expect(step(spec, ai, { _tag: 'PickPlayers', players: 7 }, props).state).toBe(ai);
  });

  it('shows name problems on Start and moves focus to the first one', () => {
    const named = go(live, { _tag: 'PickMode', mode: 'pass-and-play' }, { _tag: 'Rename', seat: 0, name: 'Ad' });
    const started = step(spec, named, { _tag: 'Start' }, props);
    expect(started.state.phase._tag).toBe('Setup');
    expect(started.state.setup.errors[0]).toMatch(/3/);
    expect(focusTargets(started.commands)[0]).toContain('aria-invalid');
    const fixed = step(spec, started.state, { _tag: 'Rename', seat: 0, name: 'Ada' }, props).state;
    expect(fixed.setup.errors[0]).toBeNull();
  });
});

describe('<jy-launcher> starting a game', () => {
  it('loads the stage code on the first Start only', () => {
    const first = step(spec, live, { _tag: 'Start' }, props);
    expect(first.state).toMatchObject({
      phase: { _tag: 'Loading' },
      round: 1,
      begin: null,
      seats: [{ id: 0, name: '', controller: 'human' }],
    });
    const [load] = commandsFor(first.commands, stageLoader);
    if (load === undefined) throw new Error('expected the stage to load');
    expect(resolve(load, undefined)).toEqual({ _tag: 'StageLoaded' });
    const ready = step(spec, first.state, { _tag: 'StageLoaded' }, props).state;
    const again = go(
      ready,
      prepared(),
      frame({ outcome: { result: 'completed', placements: [{ seat: 0, place: 1 }], summary: 'Done.' } }),
      { _tag: 'PlayAgain' },
    );
    expect(again.round).toBe(2);
    expect(commandsFor(step(spec, ready, { _tag: 'PlayAgain' }, props).commands, stageLoader)).toEqual([]);
  });

  it('reports a failed load', () => {
    const first = step(spec, live, { _tag: 'Start' }, props);
    const [load] = commandsFor(first.commands, stageLoader);
    if (load === undefined) throw new Error('expected the stage to load');
    const failure = reject(load, 'chunk missing');
    expect(failure).toMatchObject({ _tag: 'StageOut', out: { _tag: 'Failed' } });
    if (failure === undefined) throw new Error('expected a failure message');
    const broken = step(spec, first.state, failure, props);
    expect(broken.state.phase).toEqual({
      _tag: 'Failed',
      message: "The game couldn't load. Check your connection, then try again.",
    });
    expect(focusTargets(broken.commands)).toEqual([expect.stringContaining('.failed')]);
    expect(go(broken.state, { _tag: 'ChangeMode' }).phase._tag).toBe('Setup');
  });

  it('begins a new game at once when there is no save', () => {
    const loading = go(live, { _tag: 'Start' }, { _tag: 'StageLoaded' });
    const next = step(spec, loading, prepared(), props);
    expect(next.state).toMatchObject({
      begin: 'new',
      phase: { _tag: 'Playing', frame: null, menu: false },
      preferences: DEFAULT_PREFERENCES,
    });
    expect(focusTargets(next.commands)).toEqual([expect.stringContaining('jy-game-stage')]);
    // Play without a frame yet is not a safe point.
    expect(safePoints(next.commands)).toEqual([{ safe: false, gameId: 'test-tally' }]);
  });

  it('offers to resume a save, or to start again', () => {
    const loading = go(live, { _tag: 'Start' }, { _tag: 'StageLoaded' });
    const offer = step(spec, loading, prepared({ savedAt: 5, elapsedMs: 65_000, players: ['Ada'] }), props);
    expect(offer.state.phase).toEqual({ _tag: 'Resume', save: { savedAt: 5, elapsedMs: 65_000, players: ['Ada'] } });
    expect(offer.state.begin).toBeNull();
    expect(go(offer.state, { _tag: 'Resume' })).toMatchObject({ begin: 'resume', phase: { _tag: 'Playing' } });
    expect(go(offer.state, { _tag: 'NewGame' })).toMatchObject({ begin: 'new', phase: { _tag: 'Playing' } });
    expect(go(offer.state, { _tag: 'Exit' }).phase._tag).toBe('Setup');
  });
});

describe('<jy-launcher> and AI-made content (D-44)', () => {
  const aiProps: LauncherProps = { game: { ...props.game, aiContent: true } };
  const loading = run(spec, [{ _tag: 'Start' }, { _tag: 'StageLoaded' }], {
    props: aiProps,
    state: { ...freshState(aiProps.game), live: true },
  }).state;

  it('holds an AI-content game behind the notice until the player accepts it', () => {
    const notice = step(spec, loading, prepared(), aiProps);
    expect(notice.state.phase).toEqual({ _tag: 'AiNotice', save: null });
    expect(notice.state.begin).toBeNull();
    expect(focusTargets(notice.commands)).toEqual([expect.stringContaining('.ai-notice')]);
    const accepted = step(spec, notice.state, { _tag: 'AcceptAiNotice' }, aiProps).state;
    expect(accepted).toMatchObject({
      begin: 'new',
      phase: { _tag: 'Playing' },
      preferences: { aiContentAccepted: true },
    });
    expect(run(spec, [{ _tag: 'Exit' }], { props: aiProps, state: notice.state }).state.phase._tag).toBe('Setup');
  });

  it('goes on to the resume offer after the notice, and skips the notice once accepted', () => {
    const save = { savedAt: 1, elapsedMs: 2, players: ['Ada'] };
    const notice = step(spec, loading, prepared(save), aiProps).state;
    expect(step(spec, notice, { _tag: 'AcceptAiNotice' }, aiProps).state.phase).toEqual({ _tag: 'Resume', save });
    const acceptedBefore = out({
      _tag: 'Prepared',
      save: null,
      preferences: { ...DEFAULT_PREFERENCES, aiContentAccepted: true },
    });
    expect(step(spec, loading, acceptedBefore, aiProps).state.phase._tag).toBe('Playing');
  });

  it("doesn't ask for games without AI-made content", () => {
    expect(go(go(live, { _tag: 'Start' }, { _tag: 'StageLoaded' }), prepared()).phase._tag).toBe('Playing');
  });
});

describe('<jy-launcher> during play', () => {
  const playing = go(live, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared());

  it('follows the session: notices, safe points, the hand-off screen and reveals', () => {
    const shown = step(spec, playing, frame({ safePoint: true }), props);
    expect(safePoints(shown.commands)).toEqual([{ safe: true, gameId: 'test-tally' }]);
    const handoff = step(spec, shown.state, frame({ handoff: { seat: 1, name: 'Bo' } }), props);
    expect(focusTargets(handoff.commands)).toEqual([expect.stringContaining('.reveal')]);
    expect(safePoints(handoff.commands)).toEqual([{ safe: false, gameId: 'test-tally' }]);
    const revealed = step(spec, handoff.state, { _tag: 'Reveal' }, props);
    expect(revealed.state.reveals).toBe(1);
    // No hand-off, nothing to reveal.
    expect(step(spec, shown.state, { _tag: 'Reveal' }, props).state).toBe(shown.state);
  });

  it('opens and closes the overlay, which pauses the stage, but never over the hand-off screen', () => {
    const open = go(playing, frame(), { _tag: 'OpenMenu' });
    expect(open.phase).toMatchObject({ _tag: 'Playing', menu: true });
    expect(go(open, { _tag: 'CloseMenu' }).phase).toMatchObject({ menu: false });
    expect(go(open, { _tag: 'MenuClosed' }).phase).toMatchObject({ menu: false });
    const handoff = go(playing, frame({ handoff: { seat: 1, name: 'Bo' } }));
    expect(go(handoff, { _tag: 'OpenMenu' })).toBe(handoff);
  });

  it('changes preferences once the stage has read them', () => {
    const next = go(playing, {
      _tag: 'SetPreference',
      changes: { reducedMotion: 'reduce', singleKeyShortcuts: false },
    });
    expect(next.preferences).toEqual({ ...DEFAULT_PREFERENCES, reducedMotion: 'reduce', singleKeyShortcuts: false });
    const before = go(live, { _tag: 'SetPreference', changes: { sound: false } });
    expect(before.preferences).toBeNull();
  });

  it('follows preferences changed in another tab (gp-d4v)', () => {
    const elsewhere = { ...DEFAULT_PREFERENCES, reducedMotion: 'reduce', theme: 'dark' } as const;
    const next = go(playing, out({ _tag: 'Preferences', preferences: elsewhere }));
    expect(next.preferences).toEqual(elsewhere);
    expect(next.phase).toEqual(playing.phase);
    // Before the stage has read them, there is nothing to follow yet.
    expect(go(live, out({ _tag: 'Preferences', preferences: elsewhere })).preferences).toBeNull();
  });

  it('exits to the setup when asked by the player or by the game', () => {
    for (const exit of [{ _tag: 'Exit' } as const, out({ _tag: 'ExitRequested' })]) {
      const next = step(spec, go(playing, frame()), exit, props);
      expect(next.state.phase._tag).toBe('Setup');
      expect(focusTargets(next.commands)).toEqual([expect.stringContaining('.start')]);
    }
  });

  it('announces what the game asks for, nudging a repeated message', () => {
    const once = go(playing, out({ _tag: 'Announce', message: 'Ada adds 2.', politeness: 'polite' }));
    expect(once.polite).toBe('Ada adds 2.');
    expect(go(once, out({ _tag: 'Announce', message: 'Ada adds 2.', politeness: 'polite' })).polite).toBe(
      'Ada adds 2. ',
    );
    expect(go(playing, out({ _tag: 'Announce', message: 'Check!', politeness: 'assertive' })).assertive).toBe('Check!');
  });
});

describe('<jy-launcher> results', () => {
  const outcome: Outcome = {
    result: 'won',
    placements: [{ seat: 0, place: 1 }],
    summary: 'Ada reached 5 first.',
    elapsedMs: 30_000,
    undosUsed: 1,
    assists: ['undo'],
  };
  const playing = go(
    live,
    { _tag: 'PickMode', mode: 'ai' },
    { _tag: 'Start' },
    { _tag: 'StageLoaded' },
    prepared(),
    frame(),
  );

  it('shows the outcome, focuses it, announces it and reports a safe point', () => {
    const done = step(spec, playing, frame({ outcome }), props);
    expect(done.state.phase).toEqual({
      _tag: 'Results',
      result: {
        result: 'won',
        headline: 'You won!',
        summary: 'Ada reached 5 first.',
        elapsedMs: 30_000,
        assisted: 'Assisted: 1 undo',
      },
      shown: true,
    });
    expect(done.state.assertive).toBe('You won! Ada reached 5 first.');
    expect(focusTargets(done.commands)).toEqual([expect.stringContaining('#results-title')]);
    expect(safePoints(done.commands)).toEqual([{ safe: true, gameId: 'test-tally' }]);
    expect(isSafePoint(done.state.phase)).toBe(true);
  });

  it('closes the results to show the final board, and reopens them, staying a safe point', () => {
    const done = go(playing, frame({ outcome }));
    const hidden = step(spec, done, { _tag: 'HideResults' }, props);
    expect(hidden.state.phase).toMatchObject({ _tag: 'Results', shown: false });
    expect(focusTargets(hidden.commands)).toEqual([expect.stringContaining('jy-game-stage')]);
    expect(safePoints(hidden.commands)).toEqual([]);
    expect(isSafePoint(hidden.state.phase)).toBe(true);
    // Hiding twice does nothing.
    expect(go(hidden.state, { _tag: 'HideResults' })).toBe(hidden.state);

    const shown = step(spec, hidden.state, { _tag: 'ShowResults' }, props);
    expect(shown.state.phase).toMatchObject({ _tag: 'Results', shown: true });
    expect(focusTargets(shown.commands)).toEqual([expect.stringContaining('#results-title')]);
    expect(safePoints(shown.commands)).toEqual([]);
    expect(go(shown.state, { _tag: 'ShowResults' })).toBe(shown.state);
    // Neither applies outside the results.
    expect(go(playing, { _tag: 'HideResults' })).toBe(playing);
    expect(go(playing, { _tag: 'ShowResults' })).toBe(playing);
  });

  it('ignores frames after the outcome, but follows the game asking to exit', () => {
    const done = go(playing, frame({ outcome }));
    expect(go(done, frame({ outcome, notice: 'The game is over.' }))).toBe(done);
    expect(go(done, out({ _tag: 'ExitRequested' })).phase._tag).toBe('Setup');
  });

  it('plays again with the same seats, or goes back to choose a mode', () => {
    const done = go(playing, frame({ outcome }));
    const again = go(done, { _tag: 'PlayAgain' });
    expect(again).toMatchObject({
      phase: { _tag: 'Loading' },
      round: 2,
      begin: null,
      reveals: 0,
      seats: done.seats,
      config: null,
    });
    const changed = go(done, { _tag: 'ChangeMode' });
    expect(changed.phase._tag).toBe('Setup');
    // Both work from the final board too, with the results closed.
    const reviewing = go(done, { _tag: 'HideResults' });
    expect(go(reviewing, { _tag: 'PlayAgain' })).toMatchObject({ phase: { _tag: 'Loading' }, round: 2 });
    expect(go(reviewing, { _tag: 'ChangeMode' }).phase._tag).toBe('Setup');
  });

  it("plays again with the engine's rematch config, and forgets it for a fresh start", () => {
    const done = go(playing, out({ _tag: 'Rematch', config: { firstSeat: 1 } }), frame({ outcome }));
    expect(done.rematch).toEqual({ firstSeat: 1 });
    const again = go(done, { _tag: 'PlayAgain' });
    expect(again).toMatchObject({ config: { firstSeat: 1 }, rematch: null });
    const fresh = go(done, { _tag: 'ChangeMode' }, { _tag: 'Start' });
    expect(fresh.config).toBeNull();
  });

  it('starts over for another game on client navigation, staying live', () => {
    const other = { game: { ...props.game, id: 'other-game', name: 'Other' } };
    const changed = step(spec, playing, { _tag: 'PropsChanged', props: other, prev: props }, other).state;
    expect(changed).toMatchObject({ live: true, phase: { _tag: 'Setup' }, round: 0 });
  });
});

describe('<jy-launcher> online with friends', () => {
  const server = go(live, { _tag: 'PickMode', mode: 'server' });
  const room = (r: Partial<RoomFrame> = {}): LauncherMsg =>
    out({
      _tag: 'Room',
      room: {
        code: 'K7M2QX',
        link: 'https://joystyk.test/games/test-tally?room=K7M2QX',
        phase: 'lobby',
        connection: 'online',
        seat: 0,
        host: 0,
        seats: [
          { id: 0, name: 'Ada', controller: 'human', aiLevel: null, claimed: true, ready: false, connected: true },
          { id: 1, name: 'Seat 2', controller: 'human', aiLevel: null, claimed: false, ready: false, connected: false },
        ],
        minSeats: 2,
        clock: { kind: 'off' },
        clockOptions: [],
        aiLevel: null,
        aiLevels: ['easy', 'hard'],
        spectators: 0,
        timer: null,
        notice: null,
        noticeCode: null,
        match: 0,
        offer: null,
        ...r,
      },
    });
  const seats = [
    { id: 0, name: 'Ada', controller: 'human' as const },
    { id: 1, name: 'Bo', controller: 'human' as const },
  ];

  it('asks the room server once live, then reads an invite from the URL and readies the join form', () => {
    const hydrated = step(spec, initial(spec, props).state, { _tag: 'Hydrated', serverRendered: true }, props);
    expect(commandsFor(hydrated.commands, inviteDriver)).toEqual([]);
    const [check] = commandsFor(hydrated.commands, onlineRoomsDriver);
    if (check === undefined) throw new Error('expected the room server to be asked');
    const answered = resolve(check, HOSTED);
    expect(answered).toEqual({ _tag: 'OnlineChecked', online: HOSTED });
    if (answered === undefined) throw new Error('expected a message');
    const checked = step(spec, hydrated.state, answered, props);
    expect(checked.state.online).toEqual(HOSTED);
    const [read] = commandsFor(checked.commands, inviteDriver);
    if (read === undefined) throw new Error('expected the invite to be read');
    expect(resolve(read, null)).toBeUndefined();
    const found = resolve(read, 'K7M2QX');
    expect(found).toEqual({ _tag: 'InviteFound', code: 'K7M2QX' });
    if (found === undefined) throw new Error('expected a message');
    const ready = step(spec, checked.state, found, props);
    expect(ready.state.setup).toMatchObject({ mode: 'server', code: 'K7M2QX' });
    expect(focusTargets(ready.commands)).toEqual([expect.stringContaining('.join-room')]);
  });

  it('keeps online play closed when the room server is unreachable or doesn’t host the game, and local play open', () => {
    const hydrated = step(spec, initial(spec, props).state, { _tag: 'Hydrated', serverRendered: true }, props);
    const [check] = commandsFor(hydrated.commands, onlineRoomsDriver);
    if (check === undefined) throw new Error('expected the room server to be asked');
    // A failed request answers Unreachable too.
    expect(reject(check, 'offline')).toEqual({ _tag: 'OnlineChecked', online: { _tag: 'Unreachable' } });
    for (const online of [{ _tag: 'Unreachable' } as const, { _tag: 'Hosted', games: ['nim'], protocol: 1 } as const]) {
      const state = step(spec, hydrated.state, { _tag: 'OnlineChecked', online }, props).state;
      expect(step(spec, state, { _tag: 'PickMode', mode: 'server' }, props).state.setup.mode).toBe('solo');
      expect(step(spec, state, { _tag: 'InviteFound', code: 'K7M2QX' }, props).state.setup.mode).toBe('solo');
      const ai = step(spec, state, { _tag: 'PickMode', mode: 'ai' }, props).state;
      expect(ai.setup.mode).toBe('ai');
      expect(step(spec, ai, { _tag: 'Start' }, props).state.phase._tag).toBe('Loading');
    }
  });

  it('reads the invite at once for a game without online play, and asks the room server after navigating to one', () => {
    const local = { game: { ...props.game, id: 'solo-game', modes: ['solo' as const] } };
    const hydrated = step(spec, initial(spec, local).state, { _tag: 'Hydrated', serverRendered: true }, local);
    expect(commandsFor(hydrated.commands, onlineRoomsDriver)).toEqual([]);
    expect(commandsFor(hydrated.commands, inviteDriver)).toHaveLength(1);
    const moved = step(spec, hydrated.state, { _tag: 'PropsChanged', props, prev: local }, props);
    expect(commandsFor(moved.commands, onlineRoomsDriver)).toHaveLength(1);
    // Once answered, the answer holds for the next game page too.
    const answered = step(spec, moved.state, { _tag: 'OnlineChecked', online: HOSTED }, props).state;
    const again = step(spec, answered, { _tag: 'PropsChanged', props: local, prev: props }, local);
    expect(again.state.online).toEqual(HOSTED);
    expect(commandsFor(again.commands, onlineRoomsDriver)).toEqual([]);
  });

  it('creates a room, waits in the lobby, and shows the room in the address bar', () => {
    const loading = go(server, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared());
    expect(loading).toMatchObject({ plan: { action: 'create' }, begin: 'new', phase: { _tag: 'Loading' }, seats: [] });
    const lobby = step(spec, loading, room(), props);
    expect(lobby.state.phase).toEqual({ _tag: 'Lobby' });
    expect(focusTargets(lobby.commands)).toEqual([expect.stringContaining('#lobby-title')]);
    expect(inputsFor(lobby.commands, roomUrlDriver)).toEqual(['K7M2QX']);
    expect(isSafePoint(lobby.state.phase)).toBe(true);
    // Later reports update the room without moving focus or the URL again.
    const later = step(spec, lobby.state, room({ spectators: 2 }), props);
    expect(later.state.room?.spectators).toBe(2);
    expect(later.commands).toEqual([]);
  });

  it('joins by code, refusing one that cannot be a code', () => {
    const bad = step(spec, go(server, { _tag: 'TypeCode', code: 'hello' }), { _tag: 'JoinRoom' }, props);
    expect(bad.state.phase._tag).toBe('Setup');
    expect(bad.state.setup.codeError).toMatch(/six-character code/);
    expect(focusTargets(bad.commands)).toEqual([expect.stringContaining('#room-code')]);
    const joined = go(
      server,
      { _tag: 'TypeCode', code: 'k7m 2qx' },
      { _tag: 'ToggleWatch', watch: true },
      { _tag: 'JoinRoom' },
    );
    expect(joined).toMatchObject({ plan: { action: 'join', code: 'K7M2QX', watch: true }, phase: { _tag: 'Loading' } });
  });

  it('hands lobby requests to the stage in order, only once the room is open', () => {
    const loading = go(server, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared());
    expect(requests(loading, { _tag: 'RoomRequest', request: { kind: 'ready', ready: true } })).toEqual([]);
    const messages: LauncherMsg[] = [
      room(),
      { _tag: 'RoomRequest', request: { kind: 'ready', ready: true } },
      { _tag: 'RoomRequest', request: { kind: 'clock', setting: { kind: 'off' } } },
      { _tag: 'RoomRequest', request: { kind: 'fill-with-ai', seat: 1 } },
      { _tag: 'RoomRequest', request: { kind: 'start' } },
    ];
    const lobby = go(loading, ...messages);
    expect(requests(loading, ...messages)).toEqual([
      { kind: 'ready', ready: true },
      { kind: 'clock', setting: { kind: 'off' } },
      { kind: 'fill-with-ai', seat: 1 },
      { kind: 'start' },
    ]);
    expect(requests(lobby, { _tag: 'RoomRequest', request: { kind: 'ai-level', level: 'grandmaster' } })).toHaveLength(
      0,
    );
    expect(requests(lobby, { _tag: 'RoomRequest', request: { kind: 'ai-level', level: 'hard' } }).at(-1)).toEqual({
      kind: 'ai-level',
      level: 'hard',
    });
  });

  it('mounts the game when the match starts, shows results by viewer, and plays a rematch on the same stage', () => {
    const lobby = go(server, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared(), room({ seat: 1 }));
    const playing = step(spec, lobby, frame({ seats }), props);
    expect(playing.state.phase).toMatchObject({ _tag: 'Playing' });
    expect(focusTargets(playing.commands)).toEqual([expect.stringContaining('jy-game-stage')]);
    const outcome: Outcome = {
      result: 'won',
      placements: [
        { seat: 0, place: 1 },
        { seat: 1, place: 2 },
      ],
      summary: 'Ada reached 5 first.',
    };
    const done = go(playing.state, frame({ seats, outcome }));
    expect(done.phase).toMatchObject({ _tag: 'Results', result: { headline: 'Ada wins' } });
    const rematch = go(done, { _tag: 'PlayAgain' });
    expect(rematch.round).toBe(done.round);
    expect(requests(done, { _tag: 'PlayAgain' })).toEqual([{ kind: 'offer', offer: 'rematch' }]);
    expect(go(rematch, frame({ seats })).phase._tag).toBe('Playing');
  });

  it('answers the open offer by its id, asks to end the match from the menu, and announces offers politely', () => {
    const offer = {
      id: 9,
      kind: 'rematch' as const,
      by: 0,
      byName: 'Ada',
      status: 'open' as const,
      accepted: [0],
      declinedBy: null,
      declinedName: null,
      waiting: ['Bo'],
      seconds: null,
    };
    const lobby = go(server, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared(), room({ seat: 1 }));
    const offered = go(lobby, room({ seat: 1, offer }));
    expect(offered.polite).toBe('Ada offers a rematch.');
    expect(requests(offered, { _tag: 'AnswerOffer', answer: 'accept' })).toEqual([
      { kind: 'answer', offer: 9, answer: 'accept' },
    ]);
    const declined = go(
      offered,
      room({ seat: 1, offer: { ...offer, status: 'declined', declinedBy: 1, declinedName: 'Bo', waiting: [] } }),
    );
    expect(declined.polite).toBe('You declined the rematch.');
    // Nothing is open, so there is nothing to answer.
    expect(requests(declined, { _tag: 'AnswerOffer', answer: 'accept' })).toEqual([]);

    const playing = go(lobby, room({ seat: 1, phase: 'playing' }), frame({ seats }), { _tag: 'OpenMenu' });
    const asked = go(playing, { _tag: 'OfferEnd' });
    expect(requests(playing, { _tag: 'OfferEnd' })).toEqual([{ kind: 'offer', offer: 'end' }]);
    expect(asked.phase).toMatchObject({ _tag: 'Playing', menu: false });
    const ending = {
      ...offer,
      id: 12,
      kind: 'end' as const,
      by: 1,
      byName: 'Bo',
      accepted: [1],
      waiting: ['Ada'],
      seconds: 60,
    };
    const open = go(asked, room({ seat: 1, phase: 'playing', offer: ending }));
    expect(open.polite).toBe('You asked to end the match.');
    // While it is open, nobody may ask again.
    expect(requests(open, { _tag: 'OfferEnd' })).toHaveLength(0);
    const accepted = go(open, room({ seat: 1, phase: 'playing', offer: { ...ending, accepted: [1, 0], waiting: [] } }));
    expect(accepted.polite).toBe('Ada accepted.');
  });

  it('leaves through the stage: the seat goes first, then the setup comes back and the URL loses the code', () => {
    const lobby = go(server, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared(), room());
    const leaving = go(lobby, { _tag: 'RoomRequest', request: { kind: 'leave' } });
    expect(requests(lobby, { _tag: 'RoomRequest', request: { kind: 'leave' } })).toEqual([{ kind: 'leave' }]);
    expect(leaving.phase._tag).toBe('Lobby');
    const left = step(spec, leaving, out({ _tag: 'ExitRequested' }), props);
    expect(left.state).toMatchObject({ phase: { _tag: 'Setup' }, room: null, plan: null });
    expect(inputsFor(left.commands, roomUrlDriver)).toEqual([null]);
    // The menu's exit and the results' "Leave room" ask the same.
    const playing = go(lobby, frame());
    expect(requests(playing, { _tag: 'Exit' })).toEqual([{ kind: 'leave' }]);
    const done = go(playing, frame({ outcome: { result: 'draw', placements: [], summary: 'Even.' } }));
    expect(requests(done, { _tag: 'ChangeMode' })).toEqual([{ kind: 'leave' }]);
  });

  it('copies the invite and says whether it worked', () => {
    const lobby = go(server, { _tag: 'Start' }, { _tag: 'StageLoaded' }, prepared(), room());
    const copying = step(spec, lobby, { _tag: 'Copy', what: 'link' }, props);
    const [copy] = commandsFor(copying.commands, clipboardDriver);
    if (copy === undefined) throw new Error('expected a copy');
    expect(copy.input).toBe('https://joystyk.test/games/test-tally?room=K7M2QX');
    expect(resolve(copy, undefined)).toEqual({ _tag: 'Copied', what: 'link', ok: true });
    expect(reject(copy, 'denied')).toEqual({ _tag: 'Copied', what: 'link', ok: false });
    expect(go(lobby, { _tag: 'Copied', what: 'code', ok: true }).polite).toBe('Room code copied.');
    expect(go(lobby, { _tag: 'Copied', what: 'link', ok: false }).polite).toMatch(/Select the link/);
  });
});
