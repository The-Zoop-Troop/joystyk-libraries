import type { ChildValue } from '@gyral/core';
// <jy-launcher>: the frame around a game (D-07). It picks a mode from the manifest, builds
// the seats, then hands a `<jy-game-stage>` the plan; the stage loads the game's module,
// creates the local session and mounts the canvas, and reports back. Around the canvas the
// launcher draws the platform's own screens: the resume offer, the pass-and-play hand-off
// (D-31), the overlay (pause, preferences, exit) and the results, with the `results` ad slot.
// The results open as a non-modal dialog over the finished game: the canvas stays mounted
// (and inert while they show), so the player can close them and look at the final board.
//
// Online with friends (server rooms, D-48) adds a lobby: the stage opens the room (creating
// it, or joining by link or code) and reports it after every change; the launcher draws the
// invite, the seats, the clock and the host's controls, and asks the room for changes through
// the stage. The game mounts when the match starts, and its results show over the final board.
//
// The model is pure and JSON, so the page server-renders the setup form: without JavaScript
// it shows a disabled Start button and says JavaScript is needed. Everything with a lifecycle
// (storage, the session, the mounted game) lives in the stage element, loaded on first Start.
import {
  command,
  css,
  defineDriver,
  define,
  call,
  keyed,
  each,
  focus,
  html,
  intentsOf,
  nothing,
  prop,
  type Command,
  type Next,
} from '@gyral/core';
import {
  optionsForMode,
  type GameOption,
  type OptionValue,
  type Json,
  type Mode,
  type SeatInfo,
} from '@joystyk/contracts';
import type { StoredPreferences } from '@joystyk/storage';
import '@joystyk/ui/ad-slot';
import {
  clockLabel,
  clockValue,
  computerSeatsFor,
  formatElapsed,
  initialSetup,
  isLauncherGame,
  isoDuration,
  AI_NOTICE,
  MODE_LABELS,
  modeOptions,
  needsAiNotice,
  offerAnnouncement,
  offerText,
  ONLINE_CHECKING,
  parseClockValue,
  parsePreferenceChange,
  parseRoomCode,
  parseStageOutput,
  pickMode,
  playerCounts,
  resultView,
  seatsFor,
  spacedCode,
  startProblem,
  toStageMode,
  type Begin,
  type ClockOption,
  type DailyFrame,
  type FrameState,
  type LauncherGame,
  type ModeOption,
  type OnlineRooms,
  type ResultView,
  type RoomFrame,
  type RoomOfferFrame,
  type RoomPlan,
  type RoomRequest,
  type RoomSeat,
  type SaveSummary,
  type Setup,
  type StageControl,
  type StageOutput,
} from './model.ts';
import './report-problem.ts';
import { checkOnline, copyText, readInvite, shareText, showRoomInUrl } from './room-drivers.ts';
import { reportSafePoint } from './safe-point.ts';

export type Phase =
  | { readonly _tag: 'Setup' }
  | { readonly _tag: 'Loading' }
  /** D-44: an AI-content game waits for the player to accept the notice. */
  | { readonly _tag: 'AiNotice'; readonly save: SaveSummary | null }
  | { readonly _tag: 'Resume'; readonly save: SaveSummary }
  /** Online with friends: the room is open and its match hasn't started. */
  | { readonly _tag: 'Lobby' }
  | { readonly _tag: 'Playing'; readonly frame: FrameState | null; readonly menu: boolean }
  /**
   * The game is over. Its canvas stays mounted with the final board; `shown` says whether the
   * results dialog is open over it (the canvas is inert then) or closed for a look at the board.
   */
  | { readonly _tag: 'Results'; readonly result: ResultView; readonly shown: boolean }
  | { readonly _tag: 'Failed'; readonly message: string };

export type LauncherState = {
  /** True once hydrated; exposed as `:state(live)`. */
  readonly live: boolean;
  readonly setup: Setup;
  readonly phase: Phase;
  /** Counts games started here; each gets a fresh stage element. */
  readonly round: number;
  /** The stage element's code has loaded. */
  readonly stageReady: boolean;
  readonly seats: readonly SeatInfo[];
  readonly begin: Begin;
  readonly resumeSlot: string | null;
  readonly reveals: number;
  readonly preferences: StoredPreferences | null;
  /** The frame's live regions. */
  readonly polite: string;
  readonly assertive: string;
  /** A message about the last game or save, shown on the setup and play screens. */
  readonly notice: string | null;
  /** The safe point last reported to the page. */
  readonly safe: boolean;
  /** The config this round starts with: null for the game's own setup, or a rematch's. */
  readonly config: Json | null;
  /** The config "Play again" starts with, when the finished game's engine named one. */
  readonly rematch: Json | null;
  /** Online with friends: how this round opens its room, or null for local play. */
  readonly plan: RoomPlan | null;
  /** The room as the stage last reported it. */
  readonly room: RoomFrame | null;
  /** The daily puzzle's results: streaks and share text, once the stage has recorded them. */
  readonly daily: DailyFrame | null;
  /** The puzzle this round plays, when the stage names it (a daily puzzle), for "Report a problem". */
  readonly puzzle: string | null;
  /** Which games the room server hosts, as it last answered (the same for every game page). */
  readonly online: OnlineRooms;
};

export type LauncherMsg =
  | { readonly _tag: 'PickMode'; readonly mode: Mode }
  | { readonly _tag: 'PickLevel'; readonly level: string }
  | { readonly _tag: 'PickPlayers'; readonly players: number }
  | { readonly _tag: 'Rename'; readonly seat: number; readonly name: string }
  | {
      readonly _tag: 'PickGameOption';
      readonly key: string;
      readonly value: string;
      readonly checked: boolean | undefined;
    }
  | { readonly _tag: 'Start' }
  | { readonly _tag: 'StageLoaded' }
  | { readonly _tag: 'StageOut'; readonly out: StageOutput }
  | { readonly _tag: 'AcceptAiNotice' }
  | { readonly _tag: 'Resume' }
  | { readonly _tag: 'ChooseSave'; readonly slot: string }
  | { readonly _tag: 'NewGame' }
  | { readonly _tag: 'Reveal' }
  | { readonly _tag: 'OpenMenu' }
  | { readonly _tag: 'CloseMenu' }
  | { readonly _tag: 'MenuClosed' }
  | { readonly _tag: 'SetPreference'; readonly changes: Partial<StoredPreferences> }
  | { readonly _tag: 'Exit' }
  | { readonly _tag: 'PlayAgain' }
  | { readonly _tag: 'ChangeMode' }
  /** Close the results to look at the final board (Escape, or "Review the board"). */
  | { readonly _tag: 'HideResults' }
  | { readonly _tag: 'ShowResults' }
  /** Online with friends: the join form, the invite in the address bar, and lobby requests. */
  | { readonly _tag: 'TypeCode'; readonly code: string }
  | { readonly _tag: 'ToggleWatch'; readonly watch: boolean }
  | { readonly _tag: 'JoinRoom' }
  | { readonly _tag: 'InviteFound'; readonly code: string }
  /** The room server's answer: which games it hosts, or that it can't be reached. */
  | { readonly _tag: 'OnlineChecked'; readonly online: OnlineRooms }
  /** D-61: ask to end the match early, or answer the room's open offer. */
  | { readonly _tag: 'OfferEnd' }
  | { readonly _tag: 'RoomRequest'; readonly request: RoomRequest }
  | { readonly _tag: 'AnswerOffer'; readonly answer: 'accept' | 'decline' | 'withdraw' }
  | { readonly _tag: 'Copy'; readonly what: 'link' | 'code' }
  | { readonly _tag: 'Copied'; readonly what: 'link' | 'code'; readonly ok: boolean }
  /** The daily results: share (or copy) the emoji form, or copy the words form. */
  | { readonly _tag: 'Share'; readonly form: 'symbols' | 'words' }
  | {
      readonly _tag: 'Shared';
      readonly form: 'symbols' | 'words';
      readonly how: 'shared' | 'copied' | 'cancelled' | 'failed';
    };

const props = {
  /** The game, from its manifest and catalog listing. Property only (`.game=${…}`). */
  game: prop.value(isLauncherGame, { required: true }),
};
export type LauncherProps = { readonly game: LauncherGame };

const i = intentsOf<typeof Launcher>();

// --- Effects ------------------------------------------------------------------------------------

/** Loads and registers `<jy-game-stage>` on first Start, so pages pay for it only when played. */
export const stageLoader = defineDriver<undefined, void, string>({
  name: 'launcher-stage',
  run: async () => {
    await import('./browser/stage.ts');
  },
  concurrency: 'exhaust',
  toError: (cause) => (cause instanceof Error ? cause.message : String(cause)),
});

const loadStage = (): Command<LauncherMsg> =>
  command<undefined, void, string, LauncherMsg>(stageLoader, undefined, {
    onSuccess: () => ({ _tag: 'StageLoaded' }),
    onFailure: () => ({
      _tag: 'StageOut',
      out: { _tag: 'Failed', message: "The game couldn't load. Check your connection, then try again." },
    }),
  });

// --- The model ----------------------------------------------------------------------------------

export const freshState = (game: LauncherGame, live = false, online: OnlineRooms = ONLINE_CHECKING): LauncherState => ({
  live,
  setup: initialSetup(game, online),
  phase: { _tag: 'Setup' },
  round: 0,
  stageReady: false,
  seats: [],
  begin: null,
  resumeSlot: null,
  reveals: 0,
  preferences: null,
  polite: '',
  assertive: '',
  notice: null,
  safe: true,
  config: null,
  rematch: null,
  plan: null,
  room: null,
  daily: null,
  puzzle: null,
  online,
});

/** True when the page should ask the room server which games it hosts: the game lists online play and nobody has answered yet. */
const asksOnline = (game: LauncherGame, online: OnlineRooms): boolean =>
  online._tag === 'Checking' && game.modes.includes('server');

/** The modes this game offers, given the room server's last answer. */
const optionsOf = (s: LauncherState, game: LauncherGame): readonly ModeOption[] => modeOptions(game, s.online);

/** Whether an update could be offered now (offline-and-updates.md, Rule 2). */
export const isSafePoint = (phase: Phase): boolean =>
  phase._tag === 'Playing' ? (phase.frame?.safePoint ?? false) : true;

/** Returns the next state, reporting the safe point to the page when it changed. */
const settle = (
  next: LauncherState,
  game: LauncherGame,
  commands: readonly Command<LauncherMsg>[] = [],
): Next<LauncherState, LauncherMsg> => {
  const safe = isSafePoint(next.phase);
  return safe === next.safe
    ? [next, commands]
    : [{ ...next, safe }, [...commands, reportSafePoint({ safe, gameId: game.id })]];
};

/** A fresh live region text; repeating a message nudges it so screen readers say it again. */
const say = (previous: string, message: string): string => (previous === message ? `${message} ` : message);

const STAGE = 'jy-game-stage';

const beginPlay = (s: LauncherState, game: LauncherGame, begin: 'new' | 'resume'): Next<LauncherState, LauncherMsg> =>
  // A room keeps loading until the stage reports it; its game mounts when the match starts.
  // (After the AI-content notice, the phase goes back to Loading so the room's report opens the lobby.)
  s.plan !== null
    ? settle({ ...s, begin, phase: { _tag: 'Loading' } }, game)
    : settle(
        {
          ...s,
          begin,
          resumeSlot: begin === 'resume' && s.phase._tag === 'Resume' ? (s.phase.save.slot ?? null) : null,
          phase: { _tag: 'Playing', frame: null, menu: false },
        },
        game,
        [focus(STAGE)],
      );

const toSetup = (s: LauncherState, game: LauncherGame): Next<LauncherState, LauncherMsg> =>
  settle({ ...s, phase: { _tag: 'Setup' }, begin: null, room: null, plan: null }, game, [
    focus('.start'),
    ...(s.room === null ? [] : [showRoomInUrl<LauncherMsg>(null)]),
  ]);

const startRound = (
  s: LauncherState,
  game: LauncherGame,
  seats: readonly SeatInfo[],
  config: Json | null,
  plan: RoomPlan | null = null,
): Next<LauncherState, LauncherMsg> =>
  settle(
    {
      ...s,
      seats,
      config,
      rematch: null,
      round: s.round + 1,
      begin: null,
      resumeSlot: null,
      reveals: 0,
      notice: null,
      plan,
      room: null,
      daily: null,
      puzzle: null,
      phase: { _tag: 'Loading' },
      polite: say(
        s.polite,
        plan === null ? `Loading ${game.name}…` : plan.action === 'create' ? 'Opening a room…' : 'Joining the room…',
      ),
    },
    game,
    s.stageReady ? [] : [loadStage()],
  );

/** Hands a request to the room through the stage. */
const ask = (s: LauncherState, request: RoomRequest): Next<LauncherState, LauncherMsg> => [
  s,
  [call(STAGE, 'roomRequest', request)],
];

/** A lobby request, once the room is open. The room itself checks who may ask what. */
const askRoom = (s: LauncherState, request: RoomRequest): Next<LauncherState, LauncherMsg> =>
  s.plan !== null && s.room !== null ? ask(s, request) : s;

/** A seat number from a button's value. */
const seatOf = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d{1,2}$/.test(value)) return undefined;
  return Number(value);
};

/** True while this round plays in a server room. */
const inRoom = (s: LauncherState): boolean => s.plan !== null;

/** The stage's room report: the lobby until the match starts, the address bar once the code is known. */
const roomReport = (s: LauncherState, room: RoomFrame, game: LauncherGame): Next<LauncherState, LauncherMsg> => {
  const first = s.room === null || s.room.code !== room.code;
  const commands = first ? [showRoomInUrl<LauncherMsg>(room.code)] : [];
  const next = { ...s, room };
  const offered = offerAnnouncement(s.room?.offer ?? null, room.offer, room.seat, room.seats);
  const line = room.notice !== null && room.notice !== s.room?.notice ? room.notice : offered;
  const announce = line === null ? {} : { polite: say(s.polite, line) };
  if (s.phase._tag === 'Loading') {
    return settle({ ...next, ...announce, phase: { _tag: 'Lobby' } }, game, [...commands, focus('#lobby-title')]);
  }
  return settle({ ...next, ...announce }, game, commands);
};

/** After loading (and the AI-content notice): resume a save, or begin at once. */
const proceed = (s: LauncherState, game: LauncherGame, save: SaveSummary | null): Next<LauncherState, LauncherMsg> =>
  save === null
    ? beginPlay(s, game, 'new')
    : settle({ ...s, phase: { _tag: 'Resume', save } }, game, [focus('.resume .primary')]);

const fromStage = (s: LauncherState, out: StageOutput, game: LauncherGame): Next<LauncherState, LauncherMsg> => {
  switch (out._tag) {
    case 'Prepared': {
      if (s.phase._tag !== 'Loading') return { ...s, preferences: out.preferences };
      const prepared = { ...s, preferences: out.preferences };
      return needsAiNotice(game, out.preferences)
        ? settle({ ...prepared, phase: { _tag: 'AiNotice', save: out.save } }, game, [focus('.ai-notice .primary')])
        : proceed(prepared, game, out.save);
    }
    case 'Preferences':
      // Another tab changed them; the stage has already passed them to the game.
      return s.preferences === null ? s : { ...s, preferences: out.preferences };
    case 'Rematch':
      return { ...s, rematch: out.config };
    case 'Daily': {
      const { daily } = out;
      if (s.phase._tag === 'Results') return { ...s, daily };
      // Today's puzzle was finished earlier: its results show without a game.
      if (daily.earlier === null || (s.phase._tag !== 'Playing' && s.phase._tag !== 'Loading')) return s;
      const result: ResultView = {
        result: daily.earlier.result,
        headline: "You've played today's puzzle",
        summary: daily.earlier.summary,
        elapsedMs: null,
        assisted: null,
      };
      return settle(
        {
          ...s,
          daily,
          phase: { _tag: 'Results', result, shown: true },
          polite: say(s.polite, `${result.headline}. ${daily.next}.`),
        },
        game,
        [focus('#results-title')],
      );
    }
    case 'Puzzle':
      return { ...s, puzzle: out.puzzleId };
    case 'Room':
      return inRoom(s) ? roomReport(s, out.room, game) : s;
    case 'Frame': {
      const { frame } = out;
      // In a room the game mounts when the match starts, and again at a rematch.
      const starts =
        inRoom(s) &&
        frame.outcome === null &&
        (s.phase._tag === 'Lobby' || s.phase._tag === 'Loading' || s.phase._tag === 'Results');
      if (starts) return settle({ ...s, phase: { _tag: 'Playing', frame, menu: false } }, game, [focus(STAGE)]);
      const looking = inRoom(s) && frame.outcome !== null && (s.phase._tag === 'Lobby' || s.phase._tag === 'Loading');
      if (s.phase._tag !== 'Playing' && !looking) return s;
      if (frame.outcome !== null) {
        const result = resultView(
          frame.outcome,
          frame.seats,
          toStageMode(s.setup.mode ?? 'solo') ?? 'solo',
          s.room?.seat ?? null,
        );
        return settle(
          {
            ...s,
            phase: { _tag: 'Results', result, shown: true },
            assertive: say(s.assertive, `${result.headline} ${result.summary}`),
          },
          game,
          [focus('#results-title')],
        );
      }
      if (s.phase._tag !== 'Playing') return s;
      const before = s.phase.frame?.handoff ?? null;
      const handedOff = frame.handoff !== null && (before === null || before.seat !== frame.handoff.seat);
      return settle(
        { ...s, phase: { ...s.phase, frame, menu: s.phase.menu && frame.handoff === null } },
        game,
        handedOff ? [focus('.reveal')] : [],
      );
    }
    case 'ExitRequested':
      return s.phase._tag === 'Playing' || s.phase._tag === 'Results' || s.phase._tag === 'Lobby'
        ? toSetup(s, game)
        : s;
    case 'Announce':
      return out.politeness === 'assertive'
        ? { ...s, assertive: say(s.assertive, out.message) }
        : { ...s, polite: say(s.polite, out.message) };
    case 'Notice':
      return { ...s, notice: out.message, polite: say(s.polite, out.message) };
    case 'Failed':
      return s.phase._tag === 'Setup'
        ? s
        : settle({ ...s, phase: { _tag: 'Failed', message: out.message } }, game, [focus('.failed h3')]);
  }
};

// --- The view -----------------------------------------------------------------------------------

// --- Rooms: the join form, the lobby and its seats ----------------------------------------------

const joinView = (s: LauncherState) => html`<form class="join" aria-labelledby="join-title" data-intent=${i.JoinRoom}>
  <h3 id="join-title">Join a friend's room</h3>
  <p class="field">
    <label for="room-code">Room code or invite link</label>
    <input
      id="room-code"
      name="code"
      value=${s.setup.code}
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      maxlength="200"
      aria-invalid=${s.setup.codeError === null ? null : 'true'}
      aria-describedby=${s.setup.codeError === null ? 'room-code-hint' : 'room-code-hint room-code-error'}
      data-intent=${i.TypeCode}
    />
    <small id="room-code-hint" class="note">Six letters and digits, such as K7M 2QX.</small>
  </p>
  ${s.setup.codeError === null ? nothing : html`<p class="error" id="room-code-error">${s.setup.codeError}</p>`}
  <p class="check">
    <input type="checkbox" id="room-watch" name="watch" ?checked=${s.setup.watch} data-intent=${i.ToggleWatch} />
    <label for="room-watch">Just watch</label>
  </p>
  <div class="actions"><button type="submit" class="join-room" ?disabled=${!s.live}>Join room</button></div>
</form>`;

type SeatPick = {
  readonly me: number | null;
  readonly host: number | null;
  readonly hosting: boolean;
  readonly lobby: boolean;
};

const seatTags = (seat: RoomSeat, pick: SeatPick): string => {
  const tags: string[] = [];
  if (seat.id === pick.me) tags.push('you');
  if (seat.id === pick.host) tags.push('host');
  if (seat.controller === 'ai')
    tags.push(
      seat.claimed ? 'the computer plays for now' : `the computer${seat.aiLevel === null ? '' : `, ${seat.aiLevel}`}`,
    );
  else if (seat.claimed) {
    if (!seat.connected) tags.push('away');
    else if (pick.lobby) tags.push(seat.ready ? 'ready' : 'not ready');
  }
  return tags.join(' · ');
};

const SeatRow = (seat: RoomSeat, pick: SeatPick) => {
  const open = !seat.claimed && seat.controller === 'human';
  const label = open ? 'Open seat' : seat.controller === 'ai' && !seat.claimed ? 'Computer' : seat.name;
  const removable = pick.hosting && pick.lobby && seat.id !== pick.me && !open;
  return html`<li class="seat" data-open=${open ? 'yes' : 'no'} data-ready=${seat.ready ? 'yes' : 'no'}>
    <span class="seat-name">${label}</span>
    <small class="seat-tags">${seatTags(seat, pick)}</small>
    ${
      pick.hosting && pick.lobby && open
        ? html`<button type="button" class="small" value=${seat.id} data-intent=${i.FillSeat}>
          Add the computer<span class="visually-hidden"> to seat ${seat.id + 1}</span>
        </button>`
        : nothing
    }
    ${
      removable
        ? html`<button type="button" class="small" value=${seat.id} data-intent=${i.RemoveSeat}>
          Remove<span class="visually-hidden"> ${label} from seat ${seat.id + 1}</span>
        </button>`
        : nothing
    }
  </li>`;
};

const ClockRow = (o: ClockOption, picked: boolean) =>
  html`<option value=${o.value} ?selected=${picked}>${o.label}</option>`;

const connectionLine = (room: RoomFrame): string | null => {
  if (room.connection === 'connecting') return 'Connecting to the room…';
  if (room.connection === 'reconnecting') return 'Connection lost. Reconnecting…';
  return null;
};

const lobbyView = (s: LauncherState, game: LauncherGame) => {
  const room = s.room;
  if (room === null) return nothing;
  const me = room.seat === null ? undefined : room.seats.find((seat) => seat.id === room.seat);
  const hosting = room.seat !== null && room.seat === room.host;
  const lobby = room.phase === 'lobby';
  const problem = startProblem(room);
  const pick: SeatPick = { me: room.seat, host: room.host, hosting, lobby };
  const status = connectionLine(room) ?? room.notice ?? '';
  const closed = room.connection === 'closed';
  return html`<section class="lobby panel" aria-labelledby="lobby-title">
    <h3 id="lobby-title" tabindex="-1">${game.name} room <span class="code">${spacedCode(room.code)}</span></h3>
    <p class="room-status" role="status">${status}</p>
    ${
      closed
        ? html`<div class="actions">
          ${room.noticeCode === 'replaced' ? html`<button type="button" class="primary" value="reconnect" data-intent=${i.RoomAction}>Use this tab instead</button>` : nothing}
          <button type="button" value="leave" data-intent=${i.RoomAction}>Back</button>
        </div>`
        : html`<div class="invite">
            <p class="field">
              <label for="invite-link">Invite link</label>
              <input id="invite-link" class="invite-link" readonly value=${room.link} />
            </p>
            <div class="actions">
              <button type="button" value="link" data-intent=${i.Copy}>Copy link</button>
              <button type="button" value="code" data-intent=${i.Copy}>Copy code</button>
            </div>
            <p class="note">Send the link to a friend, or read them the code. Anyone with it can join or watch.</p>
          </div>
          <h4 id="seats-title">Players</h4>
          <ol class="seats" aria-labelledby="seats-title">
            ${each(
              room.seats,
              (seat) => seat.id,
              SeatRow,
              () => pick,
            )}
          </ol>
          <p class="note">${room.spectators === 0 ? 'Nobody is watching.' : room.spectators === 1 ? '1 person is watching.' : `${String(room.spectators)} people are watching.`}</p>
          ${
            room.clockOptions.length === 0
              ? nothing
              : hosting && lobby
                ? html`<p class="field">
                  <label for="room-clock">Turn clock</label>
                  <select id="room-clock" name="clock" data-intent=${i.PickClock}>
                    ${each(
                      room.clockOptions,
                      (o) => o.value,
                      ClockRow,
                      (o) => o.value === clockValue(room.clock),
                    )}
                  </select>
                </p>`
                : html`<p class="clock-setting">Turn clock: ${clockLabel(room.clock)}</p>`
          }
          ${
            hosting && lobby && room.aiLevels.length > 1
              ? html`<p class="field">
                <label for="room-ai-level">Computer level</label>
                <select id="room-ai-level" name="aiLevel" data-intent=${i.PickRoomLevel}>
                  ${each(
                    room.aiLevels,
                    (l) => l,
                    LevelOption,
                    (l) => l === (room.aiLevel ?? room.aiLevels[0]),
                  )}
                </select>
              </p>`
              : nothing
          }
          <div class="actions">
            ${
              me === undefined || !lobby
                ? html`<p class="note">${room.seat === null ? 'You are watching. The match starts when the host starts it.' : ''}</p>`
                : html`<button type="button" class="ready" aria-pressed=${me.ready ? 'true' : 'false'} value=${me.ready ? 'no' : 'yes'} data-intent=${i.ToggleReady}>
                  Ready
                </button>`
            }
            ${
              hosting && lobby
                ? html`<button type="button" class="primary start-match" aria-describedby="start-hint" ?disabled=${problem !== null} data-intent=${i.StartMatch}>
                  Start the match
                </button>`
                : nothing
            }
            <button type="button" class="leave" value="leave" data-intent=${i.RoomAction}>Leave room</button>
          </div>
          ${hosting && lobby ? html`<p class="hint" id="start-hint">${problem ?? 'Everyone is ready.'}</p>` : nothing}
          ${!hosting && lobby && me !== undefined ? html`<p class="hint">The host starts the match once everyone is ready.</p>` : nothing}`
    }
  </section>`;
};

const ModeRow = (o: ModeOption, picked: boolean) => html`<label class="mode" data-playable=${o.playable ? 'yes' : 'no'}>
  <input type="radio" name="mode" value=${o.mode} ?checked=${picked} ?disabled=${!o.playable} data-intent=${i.PickMode} />
  <span>${o.label}</span>
  ${o.note === null ? nothing : html`<small class="soon">${o.note}</small>`}
</label>`;

const LevelOption = (level: string, picked: boolean) =>
  html`<option value=${level} ?selected=${picked}>${level}</option>`;

const CountOption = (count: number, picked: boolean) =>
  html`<option value=${count} ?selected=${picked}>${count}</option>`;

type NameField = { readonly seat: number; readonly name: string; readonly error: string | null };

const NameRow = (f: NameField) => html`<div class="name">
  <label for="name-${f.seat}">Player ${f.seat + 1}</label>
  <input
    id="name-${f.seat}"
    name="seat-${f.seat}"
    value=${f.name}
    placeholder="Player ${f.seat + 1}"
    maxlength="20"
    autocomplete="off"
    spellcheck="false"
    aria-invalid=${f.error === null ? null : 'true'}
    aria-describedby=${f.error === null ? null : `name-${f.seat}-error`}
    data-intent=${i.Rename}
  />
  ${f.error === null ? nothing : html`<p class="error" id="name-${f.seat}-error">${f.error}</p>`}
</div>`;

const setupHint = (s: LauncherState, game: LauncherGame, options: readonly ModeOption[]): string => {
  if (!s.live) return 'JavaScript is needed to play.';
  if (game.status !== 'available') return 'Coming soon: not playable yet.';
  if (!options.some((o) => o.playable)) return 'This game is coming soon.';
  return '';
};

const GameChoice = (choice: { readonly value: string | number; readonly label: string }, selected: OptionValue) =>
  html`<option value=${String(choice.value)} ?selected=${choice.value === selected}>${choice.label}</option>`;
const GameOptionRow = (option: GameOption, value: OptionValue) => html`<p class="field">
  ${
    option.kind === 'toggle'
      ? html`<label><input type="checkbox" name=${option.key} value="toggle" ?checked=${value === true} data-intent=${i.PickGameOption}> ${option.label}</label>`
      : html`<label>${option.label}<select name=${option.key} data-intent=${i.PickGameOption}>${each(
          option.choices,
          (c) => String(c.value),
          GameChoice,
          () => value,
        )}</select></label>`
  }
  ${option.help === undefined ? nothing : html`<small>${option.help}</small>`}
</p>`;

const setupView = (s: LauncherState, game: LauncherGame) => {
  const options = optionsOf(s, game);
  const { mode } = s.setup;
  const counts = playerCounts(game, mode);
  const playable = options.some((o) => o.mode === mode && o.playable);
  const names: NameField[] = [];
  if (mode === 'pass-and-play') {
    for (let seat = 0; seat < s.setup.players; seat += 1)
      names.push({ seat, name: s.setup.names[seat] ?? '', error: s.setup.errors[seat] ?? null });
  }
  return html`<form class="setup" aria-label="Start ${game.name}" data-intent=${i.Start}>
    ${s.notice === null ? nothing : html`<p class="notice">${s.notice}</p>`}
    <fieldset class="modes">
      <legend>Choose how to play</legend>
      <div class="mode-list">${each(
        options,
        (o) => o.mode,
        ModeRow,
        (o) => o.mode === mode,
      )}</div>
    </fieldset>
    ${
      (mode === 'ai' || computerSeatsFor(game, s.setup) > 0) && game.aiLevels.length > 1
        ? html`<p class="field">
          <label for="ai-level">Computer level</label>
          <select id="ai-level" name="aiLevel" data-intent=${i.PickLevel}>
            ${each(
              game.aiLevels,
              (l) => l,
              LevelOption,
              (l) => l === s.setup.aiLevel,
            )}
          </select>
        </p>`
        : nothing
    }
    ${
      counts.length > 1
        ? html`<p class="field">
          <label for="players">Players</label>
          <select id="players" name="players" data-intent=${i.PickPlayers}>
            ${each(
              counts,
              (n) => n,
              CountOption,
              (n) => n === s.setup.players,
            )}
          </select>
        </p>`
        : nothing
    }
    ${
      mode === 'pass-and-play'
        ? html`<fieldset class="names">
          <legend>Player names</legend>
          ${each(names, (f) => f.seat, NameRow)}
          ${
            computerSeatsFor(game, s.setup) > 0
              ? html`<p class="note">The computer plays the other ${computerSeatsFor(game, s.setup) === 1 ? 'seat' : `${String(computerSeatsFor(game, s.setup))} seats`}.</p>`
              : nothing
          }
        </fieldset>`
        : nothing
    }
    ${mode === 'server' ? html`<p class="note">Open a room and invite friends with a link, or join a friend's room below.</p>` : nothing}
    ${
      optionsForMode(game.options ?? [], mode ?? 'solo').length === 0
        ? nothing
        : html`<fieldset class="game-options"><legend>Game options</legend>${each(
            optionsForMode(game.options ?? [], mode ?? 'solo'),
            (o) => o.key,
            GameOptionRow,
            (o) => s.setup.options?.[o.key] ?? o.default,
          )}</fieldset>`
    }
    <div class="actions">
      ${
        mode === 'server'
          ? html`<button type="submit" class="start primary" ?disabled=${!s.live || !playable}>Create a room</button>`
          : html`<button type="submit" class="start primary" aria-label="Start ${game.name}" ?disabled=${!s.live || !playable}>Start</button>`
      }
      <p class="hint">${setupHint(s, game, options)}</p>
    </div>
    ${game.aiContent === true ? html`<p class="note">This game uses AI-made content. You'll see a short notice before it starts.</p>` : nothing}
  </form>
  ${mode === 'server' && playable ? joinView(s) : nothing}`;
};

const resumeView = (save: SaveSummary) => {
  const players = save.players.filter((p) => p !== '');
  return html`<section class="resume panel" aria-labelledby="resume-title">
    <h3 id="resume-title">Continue your saved game?</h3>
    ${save.choices === undefined ? nothing : html`<label>Saved game<select aria-label="Saved game" data-intent=${i.ChooseSave}>${save.choices.map((choice) => html`<option value=${choice.slot} ?selected=${choice.slot === save.slot}>${choice.label}</option>`)}</select></label>`}
    <p>
      ${players.length > 1 ? `${players.join(' and ')}: ` : ''}<time datetime=${isoDuration(save.elapsedMs)}>${formatElapsed(save.elapsedMs)}</time> played so far.
    </p>
    <div class="actions">
      <button type="button" class="primary" data-intent=${i.Resume}>Resume</button>
      <button type="button" data-intent=${i.NewGame}>Start a new game</button>
      <button type="button" data-intent=${i.Exit}>Back</button>
    </div>
  </section>`;
};

const aiNoticeView = () => html`<section class="ai-notice panel" aria-labelledby="ai-notice-title">
  <h3 id="ai-notice-title">${AI_NOTICE.title}</h3>
  <p>${AI_NOTICE.body}</p>
  <p>${AI_NOTICE.scope}</p>
  <div class="actions">
    <button type="button" class="primary" data-intent=${i.AcceptAiNotice}>Accept and play</button>
    <button type="button" data-intent=${i.Exit}>Not now</button>
  </div>
</section>`;

const handoffView = (handoff: {
  readonly name: string;
}) => html`<section class="handoff panel" aria-labelledby="handoff-title">
  <h3 id="handoff-title">Pass to ${handoff.name}, then tap to reveal</h3>
  <p>Only ${handoff.name} should look at the screen.</p>
  <button type="button" class="reveal primary" data-intent=${i.Reveal}>Tap to reveal</button>
</section>`;

/**
 * The results, as a non-modal dialog over the finished game's canvas: modal would make the
 * page inert, and the results are where the page may offer an update (a safe point). It stays
 * in the document while closed, so reopening it keeps the ad slot as it was.
 */
/** The buttons that answer an open offer, for a player who hasn't answered it yet. */
const answerButtons = (offer: RoomOfferFrame, me: number | null, what: string) => {
  if (me === null || offer.status !== 'open') return nothing;
  if (offer.by === me)
    return html`<button type="button" value="withdraw" data-intent=${i.AnswerOffer}>Withdraw the offer</button>`;
  if (offer.accepted.includes(me)) return nothing;
  return html`<button type="button" class="primary" value="accept" data-intent=${i.AnswerOffer}>Accept<span class="visually-hidden"> ${what}</span></button>
    <button type="button" value="decline" data-intent=${i.AnswerOffer}>Decline<span class="visually-hidden"> ${what}</span></button>`;
};

/** The results' actions: a local game plays again; in a room any player offers a rematch, which starts when everyone accepts (D-61). */
const resultActions = (s: LauncherState, game: LauncherGame) => {
  if (s.setup.mode === 'daily') {
    return html`<div class="actions">
      ${
        s.daily === null || s.daily.share === ''
          ? nothing
          : html`<button type="button" class="primary share" value="symbols" data-intent=${i.Share}>Share</button>
            <button type="button" value="words" data-intent=${i.Share}>Copy as text</button>`
      }
      ${game.modes.length > 1 ? html`<button type="button" data-intent=${i.ChangeMode}>Change mode</button>` : nothing}
      <a class="back" href="/">Back to all games</a>
    </div>`;
  }
  if (!inRoom(s)) {
    return html`<div class="actions">
      <button type="button" class="primary" data-intent=${i.PlayAgain}>Play again</button>
      <button type="button" data-intent=${i.ChangeMode}>Change mode</button>
      <a class="back" href="/">Back to all games</a>
    </div>`;
  }
  const room = s.room;
  const me = room?.seat ?? null;
  const seated = room !== null && me !== null && room.connection === 'online';
  const offer = room?.offer?.kind === 'rematch' ? room.offer : null;
  const open = offer?.status === 'open' ? offer : null;
  const note =
    offer !== null
      ? offerText(offer, me)
      : me === null
        ? 'The players may start a rematch; stay to watch it.'
        : 'Any player can offer a rematch. It starts when everyone accepts.';
  return html`<div class="actions">
      ${seated && open === null ? html`<button type="button" class="primary offer-rematch" data-intent=${i.PlayAgain}>Offer a rematch</button>` : nothing}
      ${seated && open !== null ? answerButtons(open, me, 'the rematch') : nothing}
      <button type="button" data-intent=${i.ChangeMode}>Leave room</button>
      <a class="back" href="/">Back to all games</a>
    </div>
    <p class="note offer-state">${note}</p>`;
};

/** The daily part of the results: streaks, the next release and the share text it would send. */
const dailyView = (d: DailyFrame) => html`<dl class="facts daily-facts">
    <div>
      <dt>Streak</dt>
      <dd>${d.streak} ${d.streak === 1 ? 'day' : 'days'} (best ${d.bestStreak})</dd>
    </div>
    ${
      d.winStreak === null
        ? nothing
        : html`<div>
          <dt>Wins in a row</dt>
          <dd>${d.winStreak} (best ${d.bestWinStreak ?? d.winStreak})</dd>
        </div>`
    }
  </dl>
  ${
    d.statistics === undefined
      ? nothing
      : html`<section class="word-statistics" aria-labelledby="word-statistics-title">
    <h4 id="word-statistics-title">Daily Word statistics</h4>
    <dl class="facts"><div><dt>Played</dt><dd>${d.statistics.played}</dd></div><div><dt>Won</dt><dd>${d.statistics.won}</dd></div><div><dt>Win rate</dt><dd>${d.statistics.winPercent}%</dd></div></dl>
    <table><caption>Wins by guess count</caption><tbody>${d.statistics.distribution.map((count, index) => html`<tr><th scope="row">${index + 1} ${index === 0 ? 'guess' : 'guesses'}</th><td><meter min="0" max=${Math.max(1, d.statistics!.won)} value=${count} aria-label="Wins in ${index + 1} guesses">${count}</meter></td><td>${count}</td></tr>`)}</tbody></table>
  </section>`
  }
  <p class="next">${d.next}</p>
  ${
    d.share === ''
      ? nothing
      : html`<figure class="share-preview">
        <figcaption>What Share sends</figcaption>
        <pre aria-hidden="true">${d.share}</pre>
        <p class="visually-hidden">${d.shareWords}</p>
      </figure>`
  }`;

const resultsView = (s: LauncherState, r: ResultView, shown: boolean, game: LauncherGame) => html`<dialog
  id="results"
  class="results"
  aria-labelledby="results-title"
  data-result=${r.result}
  ?open=${shown}
  data-intent=${i.HideResults}
  data-intent-on="keydown"
>
  <div class="results-body">
    <p class="kicker">Game over</p>
    <h3 id="results-title" tabindex="-1">${r.headline}</h3>
    <p class="summary">${r.summary}</p>
    <dl class="facts">
      ${
        r.elapsedMs === null
          ? nothing
          : html`<div>
            <dt>Time</dt>
            <dd><time datetime=${isoDuration(r.elapsedMs)}>${formatElapsed(r.elapsedMs)}</time></dd>
          </div>`
      }
      ${
        r.assisted === null
          ? nothing
          : html`<div class="assisted">
            <dt>Help</dt>
            <dd>${r.assisted}</dd>
          </div>`
      }
    </dl>
    ${s.daily === null ? nothing : dailyView(s.daily)} ${resultActions(s, game)} ${reportView(s, game)}
    ${
      s.daily?.earlier != null
        ? nothing
        : html`<p class="review">
          <button type="button" class="review-board" aria-keyshortcuts="Escape" data-intent=${i.HideResults}>Review the board</button>
        </p>`
    }
  </div>
  <ad-slot class="results-ad" slot-id="results" page="results" game-id=${game.id}></ad-slot>
</dialog>`;

const failedView = (message: string) => html`<section class="failed panel" role="alert" aria-labelledby="failed-title">
  <h3 id="failed-title" tabindex="-1">The game couldn't start</h3>
  <p>${message}</p>
  <div class="actions"><button type="button" class="primary" data-intent=${i.ChangeMode}>Back</button></div>
</section>`;

const ReducedMotionOption = (o: { readonly value: string; readonly label: string }, picked: boolean) =>
  html`<option value=${o.value} ?selected=${picked}>${o.label}</option>`;

const MOTION_OPTIONS = [
  { value: 'system', label: 'Follow my device' },
  { value: 'reduce', label: 'Reduce motion' },
  { value: 'no-preference', label: 'Full motion' },
] as const;

const THEME_OPTIONS = [
  { value: 'system', label: 'Follow my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

const preferencesView = (p: StoredPreferences) => html`<fieldset class="prefs">
  <legend>Preferences</legend>
  <p class="field">
    <label for="pref-motion">Motion</label>
    <select id="pref-motion" name="reducedMotion" data-intent=${i.SetPreference}>
      ${each(
        MOTION_OPTIONS,
        (o) => o.value,
        ReducedMotionOption,
        (o) => o.value === p.reducedMotion,
      )}
    </select>
  </p>
  <p class="field">
    <label for="pref-theme">Game colors</label>
    <select id="pref-theme" name="theme" data-intent=${i.SetPreference}>
      ${each(
        THEME_OPTIONS,
        (o) => o.value,
        ReducedMotionOption,
        (o) => o.value === p.theme,
      )}
    </select>
  </p>
  <p class="check">
    <input type="checkbox" id="pref-sound" name="sound" ?checked=${p.sound} data-intent=${i.SetPreference} />
    <label for="pref-sound">Sound</label>
  </p>
  <p class="field">
    <label for="pref-volume">Volume</label>
    <input type="range" id="pref-volume" name="volume" min="0" max="100" step="5" value=${Math.round(p.volume * 100)} data-intent=${i.SetPreference} />
  </p>
  <p class="check">
    <input
      type="checkbox"
      id="pref-keys"
      name="singleKeyShortcuts"
      aria-describedby="pref-keys-note"
      ?checked=${p.singleKeyShortcuts}
      data-intent=${i.SetPreference}
    />
    <label for="pref-keys">Single-key shortcuts</label>
  </p>
  <p class="note" id="pref-keys-note">Turn these off if you use speech input or a switch.</p>
  <p class="check">
    <input
      type="checkbox"
      id="pref-ai"
      name="aiContentAccepted"
      aria-describedby="pref-ai-note"
      ?checked=${p.aiContentAccepted === true}
      data-intent=${i.SetPreference}
    />
    <label for="pref-ai">Allow games with AI-made content</label>
  </p>
  <p class="note" id="pref-ai-note">Turned off, those games ask again before they start.</p>
</fieldset>`;

/** The puzzle a report names: the one the stage reported, else the daily result's date. */
const puzzleOf = (s: LauncherState, game: LauncherGame): string =>
  s.puzzle ?? (s.daily === null ? '' : `${game.id}:${s.daily.date}`);

/**
 * "Report a problem" for a game with AI-made content (D-52), in the frame: the results and the
 * menu, never the canvas (D-07).
 */
const reportView = (s: LauncherState, game: LauncherGame) =>
  game.aiContent === true
    ? html`<jy-report-problem class="report" game-id=${game.id} puzzle-id=${puzzleOf(s, game)}></jy-report-problem>`
    : nothing;

const overlayView = (
  open: boolean,
  preferences: StoredPreferences | null,
  game: LauncherGame,
  room: boolean,
  canEnd: boolean,
  report: ReturnType<typeof reportView>,
) => html`<dialog
  class="overlay"
  aria-labelledby="menu-title"
  ?modal=${open}
  data-intent=${i.MenuClosed}
  data-intent-on="close"
>
  <h3 id="menu-title">${room ? 'Menu' : 'Paused'}</h3>
  <p class="note">${room ? 'The match goes on while this menu is open.' : `${game.name} waits while this menu is open.`}</p>
  <div class="actions">
    <button type="button" class="primary" autofocus data-intent=${i.CloseMenu}>${room ? 'Back to the game' : 'Resume'}</button>
    ${canEnd ? html`<button type="button" class="end-match" aria-describedby="end-match-note" data-intent=${i.OfferEnd}>Ask to end the match</button>` : nothing}
    <button type="button" class="exit" data-intent=${i.Exit}>${room ? 'Leave room' : 'Save and exit'}</button>
  </div>
  ${canEnd ? html`<p class="note" id="end-match-note">It ends with no result if the others agree, or if nobody declines within a minute.</p>` : nothing}
  ${report} ${preferences === null ? nothing : preferencesView(preferences)}
</dialog>`;

const StageRow = (_round: number, pick: readonly [StageControl, boolean, string, boolean]) =>
  html`<jy-game-stage
    class="stage"
    role="region"
    tabindex="-1"
    aria-label=${pick[2]}
    ?hidden=${pick[1]}
    ?inert=${pick[3]}
    .control=${pick[0]}
    data-intent=${i.StageOut}
  ></jy-game-stage>`;

const stageControl = (s: LauncherState, game: LauncherGame): StageControl => ({
  gameId: game.id,
  mode: toStageMode(s.setup.mode ?? 'solo') ?? 'solo',
  seats: s.seats,
  begin: s.begin,
  // A room never pauses: the match goes on while the menu is open.
  paused: s.phase._tag === 'Playing' && s.phase.menu && !inRoom(s),
  reveals: s.reveals,
  preferences: s.preferences,
  config: s.config,
  setup: Object.fromEntries(
    optionsForMode(game.options ?? [], s.setup.mode ?? 'solo')
      .map((o) => [o.key, s.setup.options?.[o.key] ?? o.default])
      .concat(
        s.setup.mode === 'ai' && game.players.max === 1
          ? [['level', s.setup.aiLevel ?? game.aiLevels[0] ?? 'medium']]
          : [],
      ),
  ),
  room: s.plan,
  ...(s.resumeSlot === null ? {} : { resumeSlot: s.resumeSlot }),
});

/** The bar's button: the overlay during play; after it, a way back to closed results. */
const barButton = (phase: Phase, handoff: boolean) => {
  if (phase._tag === 'Playing') {
    return html`<button type="button" class="menu-button" aria-haspopup="dialog" ?disabled=${handoff} data-intent=${i.OpenMenu}>Menu</button>`;
  }
  if (phase._tag !== 'Results') return nothing;
  // Held in place while the results show, so the bar keeps its size.
  return html`<button
    type="button"
    class="menu-button show-results"
    aria-controls="results"
    data-held=${phase.shown ? 'yes' : 'no'}
    data-intent=${i.ShowResults}
  >
    Show results
  </button>`;
};

/** The bar's clock while a room's decision clock runs: whose it is and what is left. */
const timerView = (room: RoomFrame | null) => {
  const timer = room?.timer ?? null;
  if (timer === null) return nothing;
  const mine = timer.seat === room?.seat;
  return html`<p class="timer" role="timer" data-low=${timer.seconds <= 10 && !timer.paused ? 'yes' : 'no'} data-paused=${timer.paused ? 'yes' : 'no'}>
    ${mine ? 'Your time' : `${timer.name}'s time`}: <time datetime=${isoDuration(timer.seconds * 1000)}>${formatElapsed(timer.seconds * 1000)}</time>${
      timer.paused ? ' (paused: nobody is at the table)' : ''
    }
  </p>`;
};

/** The bar's line for an offer to end the match: its state, and the viewer's answer buttons. */
const offerBar = (room: RoomFrame | null) => {
  const offer = room?.offer ?? null;
  if (room === null || offer?.kind !== 'end') return nothing;
  return html`<div class="offer" role="group" aria-label="Offer to end the match">
    <p class="offer-text">${offerText(offer, room.seat)}</p>
    ${room.connection === 'online' ? answerButtons(offer, room.seat, 'ending the match') : nothing}
  </div>`;
};

/** A seated player may ask to end a match in progress when no such offer is open. */
const canOfferEnd = (room: RoomFrame | null): boolean =>
  room !== null &&
  room.seat !== null &&
  room.phase === 'playing' &&
  room.connection === 'online' &&
  room.offer?.status !== 'open';

/** The bar's status line: loading, a room's connection, or the latest notice. */
const statusLine = (s: LauncherState, game: LauncherGame, notice: string | null): string => {
  if (s.phase._tag === 'Loading')
    return s.plan === null
      ? `Loading ${game.name}…`
      : s.plan.action === 'create'
        ? 'Opening a room…'
        : 'Joining the room…';
  // The lobby has a status line of its own.
  if (s.phase._tag === 'Lobby') return '';
  const connection = s.room === null ? null : connectionLine(s.room);
  return connection ?? notice ?? '';
};

const playView = (s: LauncherState, game: LauncherGame) => {
  const { phase } = s;
  const results = phase._tag === 'Results' ? phase : null;
  const staged =
    phase._tag === 'Loading' ||
    phase._tag === 'AiNotice' ||
    phase._tag === 'Resume' ||
    phase._tag === 'Lobby' ||
    phase._tag === 'Playing' ||
    results !== null;
  const frame = phase._tag === 'Playing' ? phase.frame : null;
  const handoff = frame?.handoff ?? null;
  // The canvas shows during play (not behind a hand-off) and, with the final board, after it.
  const hidden = (phase._tag !== 'Playing' && results === null) || handoff !== null;
  const inert = results?.shown ?? false;
  const control = stageControl(s, game);
  const label = `${game.name}: game`;
  const notice = frame?.notice ?? s.room?.notice ?? s.notice;
  const replaced = s.room?.connection === 'closed' && s.room.noticeCode === 'replaced' && phase._tag !== 'Lobby';
  return html`<div class="play">
    <div class="bar">
      <p class="mode-label">${game.name} · ${MODE_LABELS[s.setup.mode ?? 'solo']}${s.room === null ? '' : ` · ${spacedCode(s.room.code)}`}</p>
      <p class="status" role="status">${statusLine(s, game, notice)}</p>
      ${phase._tag === 'Lobby' ? nothing : timerView(s.room)}
      ${replaced ? html`<button type="button" value="reconnect" data-intent=${i.RoomAction}>Use this tab instead</button>` : nothing}
      ${barButton(phase, handoff !== null)}
      ${phase._tag === 'Playing' ? offerBar(s.room) : nothing}
    </div>
    ${phase._tag === 'AiNotice' ? aiNoticeView() : nothing} ${phase._tag === 'Resume' ? resumeView(phase.save) : nothing}
    ${phase._tag === 'Lobby' ? lobbyView(s, game) : nothing}
    ${handoff === null ? nothing : handoffView(handoff)}
    <div class="arena">
      ${staged && s.stageReady ? keyed(s.round, StageRow(s.round, [control, hidden, label, inert])) : nothing}
      ${results === null ? nothing : resultsView(s, results.result, results.shown, game)}
    </div>
    ${phase._tag === 'Playing' ? overlayView(phase.menu, s.preferences, game, inRoom(s), inRoom(s) && canOfferEnd(s.room), reportView(s, game)) : nothing}
  </div>`;
};

const mainView = (s: LauncherState, game: LauncherGame) => {
  switch (s.phase._tag) {
    case 'Setup':
      return setupView(s, game);
    case 'Failed':
      return failedView(s.phase.message);
    case 'Loading':
    case 'AiNotice':
    case 'Resume':
    case 'Lobby':
    case 'Playing':
    case 'Results':
      return playView(s, game);
  }
};

const styles = css`
  @layer components {
    :host {
      display: block;
      container-type: inline-size;
      --launcher-accent: var(--jy-arcade-yellow, var(--jy-accent, oklch(50% 0.2 285)));
      --launcher-ink: var(--jy-arcade-ink, oklch(20% 0.03 285));
    }
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    h3,
    p,
    dl,
    dd,
    fieldset {
      margin: 0;
    }
    .launcher {
      display: grid;
      gap: var(--jy-space-s, 1rem);
    }
    .setup,
    .panel,
    .play {
      display: grid;
      gap: var(--jy-space-s, 1rem);
    }
    fieldset {
      padding: var(--jy-space-xs, 0.75rem) var(--jy-space-s, 1rem);
      border: 2px solid color-mix(in oklch, currentColor 30%, transparent);
      border-radius: var(--jy-radius-s, 0.5rem);
    }
    legend,
    .kicker,
    .mode-label,
    .start,
    .soon {
      font-family: var(--jy-font-mono, ui-monospace, monospace);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    legend {
      padding-inline: 0.4em;
      font-size: var(--jy-step--1, 0.9rem);
    }
    .mode-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--jy-space-2xs, 0.5rem) var(--jy-space-s, 1rem);
    }
    .mode {
      display: inline-flex;
      align-items: center;
      gap: 0.5em;
      min-block-size: var(--jy-target-min, 2.75rem);
      cursor: pointer;
      &[data-playable='no'] {
        cursor: not-allowed;
        opacity: 0.75;
      }
    }
    .soon {
      font-size: 0.7rem;
      padding: 0.1em 0.5em;
      border: 1px solid currentColor;
      border-radius: var(--jy-radius-pill, 999px);
    }
    input[type='radio'],
    input[type='checkbox'] {
      inline-size: 1.15em;
      block-size: 1.15em;
      margin: 0;
      accent-color: var(--launcher-accent);
    }
    input[type='range'] {
      accent-color: var(--launcher-accent);
    }
    .field,
    .name {
      display: grid;
      gap: var(--jy-space-3xs, 0.25rem);
      justify-items: start;
    }
    .names {
      display: grid;
      gap: var(--jy-space-xs, 0.75rem);
    }
    .check {
      display: flex;
      align-items: center;
      gap: 0.5em;
      min-block-size: var(--jy-target-min, 2.75rem);
    }
    input:not([type]),
    select {
      min-block-size: var(--jy-target-min, 2.75rem);
      padding-inline: 0.6em;
      border: 2px solid color-mix(in oklch, currentColor 35%, transparent);
      border-radius: var(--jy-radius-s, 0.5rem);
      background: var(--jy-surface-raised, Canvas);
      color: var(--jy-text, CanvasText);
      font: inherit;
    }
    input[aria-invalid='true'] {
      border-color: var(--jy-danger, red);
    }
    .error {
      color: var(--jy-danger, red);
      font-weight: 600;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--jy-space-2xs, 0.5rem) var(--jy-space-s, 1rem);
    }
    button,
    .back {
      min-block-size: var(--jy-target-min, 2.75rem);
      padding: 0.55em 1.2em;
      border: 2px solid var(--launcher-accent);
      border-radius: var(--jy-radius-s, 0.5rem);
      background: transparent;
      color: inherit;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      touch-action: manipulation;
      transition: translate var(--jy-duration-fast, 120ms) var(--jy-ease-out, ease-out);
    }
    .back {
      display: inline-flex;
      align-items: center;
      text-decoration: none;
    }
    .primary {
      border-color: transparent;
      background: var(--launcher-accent);
      color: var(--launcher-ink);
      box-shadow: 0 0.25em 0 color-mix(in oklch, var(--launcher-accent) 55%, black);
    }
    .start {
      padding-inline: 1.6em;
      font-weight: 700;
      letter-spacing: 0.1em;
    }
    button:active:not(:disabled) {
      translate: 0 0.15em;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    :is(button, .back, input, select):focus-visible {
      outline: 3px solid var(--jy-focus-ring, currentColor);
      outline-offset: 3px;
    }
    .hint,
    .note {
      font-size: var(--jy-step--1, 0.9rem);
      opacity: 0.85;
    }
    .notice {
      font-weight: 600;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--jy-space-2xs, 0.5rem) var(--jy-space-s, 1rem);
    }
    .mode-label {
      font-size: var(--jy-step--1, 0.9rem);
      color: var(--launcher-accent);
    }
    .status {
      flex: 1;
      min-inline-size: 0;
      min-block-size: 1lh;
    }
    .menu-button {
      margin-inline-start: auto;
    }
    /* Keeps its place in the bar while the results show, so nothing moves when they close. */
    .show-results[data-held='yes'] {
      visibility: hidden;
    }
    /* The canvas and, after the game, the results over it. */
    .arena {
      position: relative;
      display: grid;
    }
    /* The canvas: the game's own surface and theme tokens, set by the stage. */
    .stage {
      display: block;
      min-block-size: 12rem;
      border-radius: var(--jy-radius-m, 0.75rem);
      outline-offset: 4px;
      transition: opacity var(--jy-duration, 200ms) var(--jy-ease-out, ease-out);
      &[hidden] {
        display: none;
      }
      /* Behind the results the final board stays visible, dimmed, and can't be used. */
      &[inert] {
        opacity: 0.55;
      }
    }
    .handoff {
      place-items: center;
      min-block-size: 16rem;
      padding: var(--jy-space-l, 2rem) var(--jy-space-s, 1rem);
      border: 3px dashed var(--launcher-accent);
      border-radius: var(--jy-radius-m, 0.75rem);
      text-align: center;
      h3 {
        font-size: var(--jy-step-1, 1.4rem);
        text-wrap: balance;
      }
    }
    .reveal {
      min-inline-size: min(100%, 16rem);
      min-block-size: 3.5rem;
    }
    /*
     * Over the canvas, out of the flow: opening and closing the results never moves the board
     * or the page. A board shorter than the results scrolls them instead of growing.
     */
    .results {
      position: absolute;
      inset-block-start: var(--jy-space-s, 1rem);
      inset-inline: var(--jy-space-s, 1rem);
      z-index: 1;
      inline-size: auto;
      block-size: auto;
      max-inline-size: 48rem;
      max-block-size: calc(100% - 2 * var(--jy-space-s, 1rem));
      margin: 0 auto;
      padding: var(--jy-space-m, 1.5rem);
      overflow: auto;
      overscroll-behavior: contain;
      border: 3px solid var(--launcher-accent);
      border-radius: var(--jy-radius-m, 0.75rem);
      background: var(--jy-surface, Canvas);
      color: var(--jy-text, CanvasText);
      box-shadow: var(--jy-shadow, none);
      opacity: 1;
      translate: 0 0;
      transition:
        opacity var(--jy-duration, 200ms) var(--jy-ease-out, ease-out),
        translate var(--jy-duration, 200ms) var(--jy-ease-out, ease-out),
        display var(--jy-duration, 200ms) allow-discrete;
      &[open] {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: var(--jy-space-s, 1rem);
        align-items: start;
      }
      &:not([open]) {
        opacity: 0;
        translate: 0 0.5rem;
      }
    }
    @starting-style {
      .results[open] {
        /* Keep text readable from the first frame; animate the panel's position. */
        translate: 0 0.5rem;
      }
    }
    @container (inline-size >= 40rem) {
      .results[open] {
        grid-template-columns: minmax(0, 1fr) 300px;
      }
    }
    .results-body {
      display: grid;
      gap: var(--jy-space-s, 1rem);
      align-content: start;
    }
    .results h3 {
      font-size: var(--jy-step-2, 2rem);
      color: var(--launcher-accent);
    }
    .kicker {
      font-size: var(--jy-step--1, 0.9rem);
    }
    .facts {
      display: flex;
      flex-wrap: wrap;
      gap: var(--jy-space-s, 1rem);
      dt {
        font-size: 0.75rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.8;
      }
      dd {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
    }
    /* The daily results: the next release, and the share text exactly as Share sends it. */
    .next {
      margin-block: var(--jy-space-xs, 0.5rem);
    }
    .share-preview {
      margin: 0 0 var(--jy-space-s, 1rem);
      figcaption {
        font-size: 0.75rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.8;
      }
      pre {
        margin: var(--jy-space-2xs, 0.25rem) 0 0;
        padding: var(--jy-space-xs, 0.5rem);
        border-radius: 0.5rem;
        background: color-mix(in oklch, currentColor 8%, transparent);
        font-family: inherit;
        line-height: 1.3;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    }
    .results-ad {
      min-inline-size: 0;
    }
    .review-board {
      min-inline-size: 0;
      padding-inline: 0;
      border-color: transparent;
      text-decoration: underline;
      text-underline-offset: 0.2em;
    }
    .overlay {
      inline-size: min(100% - 2rem, 30rem);
      max-block-size: min(100dvh - 2rem, 44rem);
      padding: var(--jy-space-m, 1.5rem);
      border: 3px solid var(--launcher-accent);
      border-radius: var(--jy-radius-m, 0.75rem);
      background: var(--jy-surface, Canvas);
      color: var(--jy-text, CanvasText);
      box-shadow: var(--jy-shadow, none);
      opacity: 1;
      scale: 1;
      transition:
        opacity var(--jy-duration, 200ms) var(--jy-ease-out, ease-out),
        scale var(--jy-duration, 200ms) var(--jy-ease-out, ease-out),
        display var(--jy-duration, 200ms) allow-discrete,
        overlay var(--jy-duration, 200ms) allow-discrete;
      &:not([open]) {
        opacity: 0;
        scale: 0.96;
      }
      &::backdrop {
        background: oklch(15% 0.03 285 / 0.6);
      }
      &[open] {
        display: grid;
        gap: var(--jy-space-s, 1rem);
      }
    }
    @starting-style {
      .overlay[open] {
        opacity: 0;
        scale: 0.96;
      }
    }
    /* Online with friends: the join form and the lobby. */
    .join,
    .lobby {
      display: grid;
      gap: var(--jy-space-s, 1rem);
      padding: var(--jy-space-s, 1rem);
      border: 2px solid color-mix(in oklch, currentColor 30%, transparent);
      border-radius: var(--jy-radius-s, 0.5rem);
    }
    .join h3,
    .lobby h3 {
      font-size: var(--jy-step-1, 1.4rem);
    }
    .lobby h4 {
      margin: 0;
      font-size: var(--jy-step-0, 1rem);
    }
    .code,
    .invite-link {
      font-family: var(--jy-font-mono, ui-monospace, monospace);
      letter-spacing: 0.08em;
    }
    .code {
      color: var(--launcher-accent);
      white-space: nowrap;
    }
    .invite {
      display: grid;
      gap: var(--jy-space-2xs, 0.5rem);
    }
    .invite .field,
    .join .field {
      justify-items: stretch;
    }
    .invite-link,
    #room-code {
      inline-size: min(100%, 36rem);
    }
    .seats {
      display: grid;
      gap: var(--jy-space-2xs, 0.5rem);
      margin: 0;
      padding: 0;
      list-style: none;
      counter-reset: seat;
    }
    .seat {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--jy-space-3xs, 0.25rem) var(--jy-space-xs, 0.75rem);
      min-block-size: var(--jy-target-min, 2.75rem);
      padding-inline: var(--jy-space-xs, 0.75rem);
      border-radius: var(--jy-radius-s, 0.5rem);
      background: color-mix(in oklch, currentColor 6%, transparent);
      counter-increment: seat;
      &::before {
        content: counter(seat);
        min-inline-size: 1.5em;
        font-family: var(--jy-font-mono, ui-monospace, monospace);
        opacity: 0.7;
      }
      &[data-open='yes'] .seat-name {
        font-style: italic;
        opacity: 0.8;
      }
      &[data-ready='yes']::after {
        content: '✓' / '';
        color: var(--launcher-accent);
        font-weight: 700;
      }
    }
    .seat-name {
      font-weight: 600;
    }
    .seat-tags {
      flex: 1;
      opacity: 0.85;
    }
    .small {
      min-block-size: var(--jy-target-min, 2.75rem);
      padding: 0.3em 0.9em;
      font-size: var(--jy-step--1, 0.9rem);
    }
    .ready[aria-pressed='true'] {
      background: color-mix(in oklch, var(--launcher-accent) 25%, transparent);
    }
    .room-status:empty {
      display: none;
    }
    .timer {
      font-family: var(--jy-font-mono, ui-monospace, monospace);
      font-variant-numeric: tabular-nums;
      &[data-low='yes'] {
        color: var(--jy-danger, red);
        font-weight: 700;
      }
    }
    .offer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--jy-space-3xs, 0.25rem) var(--jy-space-xs, 0.75rem);
      flex-basis: 100%;
    }
    .visually-hidden {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    /* Reduced motion removes the frame's decorative motion: the player's choice wins over the system's. */
    :host(:state(reduce-motion)) *,
    :host(:state(reduce-motion)) *::backdrop {
      transition: none !important;
      animation: none !important;
    }
    @media (prefers-reduced-motion: reduce) {
      :host(:not(:state(allow-motion))) *,
      :host(:not(:state(allow-motion))) *::backdrop {
        transition: none !important;
        animation: none !important;
      }
    }
    @media (forced-colors: active) {
      button,
      .back {
        border-color: ButtonText;
      }
    }
  }
`;

export const Launcher = define<LauncherState, LauncherMsg, LauncherProps>()('jy-launcher', {
  props,
  init: (p) => [freshState(p.game), [reportSafePoint({ safe: true, gameId: p.game.id })]],
  states: (s) => ({
    live: s.live,
    playing: s.phase._tag === 'Playing',
    'reduce-motion': s.preferences?.reducedMotion === 'reduce',
    'allow-motion': s.preferences?.reducedMotion === 'no-preference',
  }),
  intent: {
    PickGameOption: ({ target, value, checked }) => {
      const key = (target as HTMLInputElement | HTMLSelectElement).name;
      return /^[a-z][A-Za-z0-9]{0,49}$/.test(key) && value !== undefined
        ? { _tag: 'PickGameOption', key, value, checked }
        : undefined;
    },
    PickMode: ({ value }) =>
      value !== undefined &&
      (['solo', 'ai', 'pass-and-play', 'p2p', 'server', 'daily'] as const).some((m) => m === value)
        ? { _tag: 'PickMode', mode: value as Mode }
        : undefined,
    PickLevel: ({ value }) => (value === undefined || value === '' ? undefined : { _tag: 'PickLevel', level: value }),
    PickPlayers: ({ value }) => {
      const players = Number(value);
      return Number.isInteger(players) && players > 0 ? { _tag: 'PickPlayers', players } : undefined;
    },
    Rename: ({ value, target }) => {
      const match = /^seat-(\d+)$/.exec((target as HTMLInputElement).name);
      return match?.[1] === undefined
        ? undefined
        : { _tag: 'Rename', seat: Number(match[1]), name: (value ?? '').slice(0, 40) };
    },
    Start: () => ({ _tag: 'Start' }),
    StageOut: ({ detail }) => {
      const out = parseStageOutput(detail);
      return out === undefined ? undefined : { _tag: 'StageOut', out };
    },
    AcceptAiNotice: () => ({ _tag: 'AcceptAiNotice' }),
    Resume: () => ({ _tag: 'Resume' }),
    ChooseSave: ({ value }) => (value === undefined ? undefined : { _tag: 'ChooseSave', slot: value }),
    NewGame: () => ({ _tag: 'NewGame' }),
    Reveal: () => ({ _tag: 'Reveal' }),
    OpenMenu: () => ({ _tag: 'OpenMenu' }),
    CloseMenu: () => ({ _tag: 'CloseMenu' }),
    MenuClosed: () => ({ _tag: 'MenuClosed' }),
    SetPreference: ({ value, checked, target }) => {
      const changes = parsePreferenceChange((target as HTMLInputElement).name, value, checked);
      return changes === undefined ? undefined : { _tag: 'SetPreference', changes };
    },
    Exit: () => ({ _tag: 'Exit' }),
    PlayAgain: () => ({ _tag: 'PlayAgain' }),
    ChangeMode: () => ({ _tag: 'ChangeMode' }),
    // A click on "Review the board", or Escape anywhere in the results dialog.
    HideResults: ({ key }) => (key === undefined || key === 'Escape' ? { _tag: 'HideResults' } : undefined),
    ShowResults: () => ({ _tag: 'ShowResults' }),
    TypeCode: ({ value }) => ({ _tag: 'TypeCode', code: (value ?? '').slice(0, 200) }),
    ToggleWatch: ({ checked }) => (checked === undefined ? undefined : { _tag: 'ToggleWatch', watch: checked }),
    JoinRoom: () => ({ _tag: 'JoinRoom' }),
    ToggleReady: ({ value }) =>
      value === 'yes' || value === 'no'
        ? { _tag: 'RoomRequest', request: { kind: 'ready', ready: value === 'yes' } }
        : undefined,
    StartMatch: () => ({ _tag: 'RoomRequest', request: { kind: 'start' } }),
    PickClock: ({ value }) => {
      const setting = parseClockValue(value);
      return setting === undefined ? undefined : { _tag: 'RoomRequest', request: { kind: 'clock', setting } };
    },
    PickRoomLevel: ({ value }) =>
      value === undefined || value === ''
        ? undefined
        : { _tag: 'RoomRequest', request: { kind: 'ai-level', level: value } },
    FillSeat: ({ value }) => {
      const seat = seatOf(value);
      return seat === undefined ? undefined : { _tag: 'RoomRequest', request: { kind: 'fill-with-ai', seat } };
    },
    RemoveSeat: ({ value }) => {
      const seat = seatOf(value);
      return seat === undefined ? undefined : { _tag: 'RoomRequest', request: { kind: 'remove-seat', seat } };
    },
    RoomAction: ({ value }) =>
      value === 'leave' || value === 'reconnect' ? { _tag: 'RoomRequest', request: { kind: value } } : undefined,
    OfferEnd: () => ({ _tag: 'OfferEnd' }),
    AnswerOffer: ({ value }) =>
      value === 'accept' || value === 'decline' || value === 'withdraw'
        ? { _tag: 'AnswerOffer', answer: value }
        : undefined,
    Copy: ({ value }) => (value === 'link' || value === 'code' ? { _tag: 'Copy', what: value } : undefined),
    Share: ({ value }) => (value === 'symbols' || value === 'words' ? { _tag: 'Share', form: value } : undefined),
  },
  update: {
    PickGameOption: (s, m, { props: { game } }) => {
      if (s.phase._tag !== 'Setup') return s;
      const option = optionsForMode(game.options ?? [], s.setup.mode ?? 'solo').find((o) => o.key === m.key);
      const value =
        option?.kind === 'toggle' ? m.checked : option?.choices.find((c) => String(c.value) === m.value)?.value;
      return value === undefined ? s : { ...s, setup: { ...s.setup, options: { ...s.setup.options, [m.key]: value } } };
    },
    PickMode: (s, m, { props: { game } }) =>
      s.phase._tag === 'Setup' && optionsOf(s, game).some((o) => o.mode === m.mode && o.playable)
        ? { ...s, setup: pickMode(game, s.setup, m.mode) }
        : s,
    PickLevel: (s, m, { props: { game } }) =>
      game.aiLevels.includes(m.level) ? { ...s, setup: { ...s.setup, aiLevel: m.level } } : s,
    PickPlayers: (s, m, { props: { game } }) =>
      playerCounts(game, s.setup.mode).includes(m.players)
        ? { ...s, setup: { ...s.setup, players: m.players, errors: [] } }
        : s,
    Rename: (s, m) => {
      if (m.seat < 0 || m.seat >= s.setup.players) return s;
      const names = Array.from({ length: s.setup.players }, (_, seat) =>
        seat === m.seat ? m.name : (s.setup.names[seat] ?? ''),
      );
      const errors = s.setup.errors.map((e, seat) => (seat === m.seat ? null : e));
      return { ...s, setup: { ...s.setup, names, errors } };
    },
    Start: (s, _m, { props: { game } }) => {
      if (!s.live || s.phase._tag !== 'Setup') return s;
      if (!optionsOf(s, game).some((o) => o.mode === s.setup.mode && o.playable)) return s;
      if (s.setup.mode === 'server') return startRound(s, game, [], null, { action: 'create' });
      const seats = seatsFor(game, s.setup);
      if (!seats.ok)
        return [{ ...s, setup: { ...s.setup, errors: seats.errors } }, [focus('input[aria-invalid="true"]')]];
      return startRound(s, game, seats.seats, null);
    },
    StageLoaded: (s) => ({ ...s, stageReady: true }),
    StageOut: (s, m, { props: { game } }) => fromStage(s, m.out, game),
    AcceptAiNotice: (s, _m, { props: { game } }) =>
      s.phase._tag === 'AiNotice' && s.preferences !== null
        ? proceed({ ...s, preferences: { ...s.preferences, aiContentAccepted: true } }, game, s.phase.save)
        : s,
    Resume: (s, _m, { props: { game } }) => (s.phase._tag === 'Resume' ? beginPlay(s, game, 'resume') : s),
    ChooseSave: (s, m) => {
      if (s.phase._tag !== 'Resume') return s;
      const choice = s.phase.save.choices?.find((c) => c.slot === m.slot);
      return choice === undefined ? s : { ...s, phase: { _tag: 'Resume', save: { ...s.phase.save, ...choice } } };
    },
    NewGame: (s, _m, { props: { game } }) => (s.phase._tag === 'Resume' ? beginPlay(s, game, 'new') : s),
    Reveal: (s) =>
      s.phase._tag === 'Playing' && s.phase.frame?.handoff != null
        ? [{ ...s, reveals: s.reveals + 1 }, [focus(STAGE)]]
        : s,
    OpenMenu: (s, _m, { props: { game } }) =>
      s.phase._tag === 'Playing' && s.phase.frame?.handoff == null
        ? settle({ ...s, phase: { ...s.phase, menu: true } }, game)
        : s,
    CloseMenu: (s) => (s.phase._tag === 'Playing' && s.phase.menu ? { ...s, phase: { ...s.phase, menu: false } } : s),
    MenuClosed: (s) => (s.phase._tag === 'Playing' && s.phase.menu ? { ...s, phase: { ...s.phase, menu: false } } : s),
    SetPreference: (s, m) => (s.preferences === null ? s : { ...s, preferences: { ...s.preferences, ...m.changes } }),
    Exit: (s, _m, { props: { game } }) => {
      // Leaving a room goes through the stage, which gives the seat up before it closes.
      if (inRoom(s) && s.room !== null && (s.phase._tag === 'Playing' || s.phase._tag === 'Lobby'))
        return ask(s, { kind: 'leave' });
      return s.phase._tag === 'Playing' ||
        s.phase._tag === 'Resume' ||
        s.phase._tag === 'Loading' ||
        s.phase._tag === 'AiNotice'
        ? toSetup(s, game)
        : s;
    },
    PlayAgain: (s, _m, { props: { game } }) => {
      if (s.phase._tag !== 'Results') return s;
      // In a room this offers a rematch; offering one that is already open accepts it.
      return inRoom(s) ? askRoom(s, { kind: 'offer', offer: 'rematch' }) : startRound(s, game, s.seats, s.rematch);
    },
    ChangeMode: (s, _m, { props: { game } }) => {
      if (inRoom(s) && s.room !== null && s.phase._tag === 'Results') return ask(s, { kind: 'leave' });
      return s.phase._tag === 'Results' || s.phase._tag === 'Failed' ? toSetup(s, game) : s;
    },
    // The results close to the final board, which can be read but no longer played; the
    // session stays until the player picks Play again, Change mode or leaves the page.
    HideResults: (s) =>
      s.phase._tag === 'Results' && s.phase.shown && s.daily?.earlier == null
        ? [{ ...s, phase: { ...s.phase, shown: false } }, [focus(STAGE)]]
        : s,
    ShowResults: (s) =>
      s.phase._tag === 'Results' && !s.phase.shown
        ? [{ ...s, phase: { ...s.phase, shown: true } }, [focus('#results-title')]]
        : s,
    // A game that lists online play asks the room server first, and reads an invite once it
    // knows whether rooms are open; any other game reads it at once (and ignores it).
    Hydrated: (s, _m, { props: { game } }) => [
      { ...s, live: true },
      [
        asksOnline(game, s.online)
          ? checkOnline<LauncherMsg>((online) => ({ _tag: 'OnlineChecked', online }))
          : readInvite<LauncherMsg>((code) => ({ _tag: 'InviteFound', code })),
      ],
    ],
    OnlineChecked: (s, m, { props: { game } }) => {
      const next = { ...s, online: m.online };
      // A setup whose mode the answer made unplayable (or that had none) moves to the first playable mode.
      const options = optionsOf(next, game);
      const first = options.find((o) => o.playable)?.mode;
      const keep = s.setup.mode !== null && options.some((o) => o.mode === s.setup.mode && o.playable);
      const setup = s.phase._tag !== 'Setup' || keep || first === undefined ? s.setup : pickMode(game, s.setup, first);
      return [{ ...next, setup }, [readInvite<LauncherMsg>((code) => ({ _tag: 'InviteFound', code }))]];
    },
    TypeCode: (s, m) => (s.phase._tag === 'Setup' ? { ...s, setup: { ...s.setup, code: m.code, codeError: null } } : s),
    ToggleWatch: (s, m) => (s.phase._tag === 'Setup' ? { ...s, setup: { ...s.setup, watch: m.watch } } : s),
    JoinRoom: (s, _m, { props: { game } }) => {
      if (!s.live || s.phase._tag !== 'Setup' || s.setup.mode !== 'server') return s;
      if (!optionsOf(s, game).some((o) => o.mode === 'server' && o.playable)) return s;
      const code = parseRoomCode(s.setup.code);
      if (code === null) {
        return [
          {
            ...s,
            setup: { ...s.setup, codeError: 'Enter the six-character code from the invite, or paste the invite link.' },
          },
          [focus('#room-code')],
        ];
      }
      return startRound({ ...s, setup: { ...s.setup, code, codeError: null } }, game, [], null, {
        action: 'join',
        code,
        watch: s.setup.watch,
      });
    },
    InviteFound: (s, m, { props: { game } }) => {
      if (s.phase._tag !== 'Setup' || !optionsOf(s, game).some((o) => o.mode === 'server' && o.playable)) return s;
      return [
        { ...s, setup: { ...pickMode(game, s.setup, 'server'), code: m.code, codeError: null } },
        [focus('.join-room')],
      ];
    },
    RoomRequest: (s, m) =>
      m.request.kind === 'ai-level' && s.room?.aiLevels.includes(m.request.level) !== true ? s : askRoom(s, m.request),
    // The menu closes on the way: the offer then shows in the bar.
    OfferEnd: (s) =>
      s.phase._tag === 'Playing' && canOfferEnd(s.room)
        ? askRoom({ ...s, phase: { ...s.phase, menu: false } }, { kind: 'offer', offer: 'end' })
        : s,
    AnswerOffer: (s, m) => {
      const offer = s.room?.offer ?? null;
      return offer?.status === 'open' ? askRoom(s, { kind: 'answer', offer: offer.id, answer: m.answer }) : s;
    },
    Copy: (s, m) =>
      s.room === null
        ? s
        : [
            s,
            [
              copyText<LauncherMsg>(m.what === 'link' ? s.room.link : s.room.code, (ok) => ({
                _tag: 'Copied',
                what: m.what,
                ok,
              })),
            ],
          ],
    Copied: (s, m) => ({
      ...s,
      polite: say(
        s.polite,
        m.ok
          ? m.what === 'link'
            ? 'Invite link copied.'
            : 'Room code copied.'
          : 'Copying didn’t work here. Select the link and copy it yourself.',
      ),
    }),
    Share: (s, m) => {
      const d = s.daily;
      if (d === null || d.share === '' || s.phase._tag !== 'Results') return s;
      return m.form === 'symbols'
        ? [s, [shareText<LauncherMsg>(d.share, (how) => ({ _tag: 'Shared', form: 'symbols', how }))]]
        : [
            s,
            [
              copyText<LauncherMsg>(d.shareWords, (ok) => ({
                _tag: 'Shared',
                form: 'words',
                how: ok ? 'copied' : 'failed',
              })),
            ],
          ];
    },
    Shared: (s, m) => {
      const line =
        m.how === 'shared'
          ? 'Shared.'
          : m.how === 'copied'
            ? m.form === 'words'
              ? 'Result copied as text.'
              : 'Result copied. Paste it anywhere.'
            : m.how === 'cancelled'
              ? null
              : 'Copying didn’t work here. Select the result and copy it yourself.';
      return line === null ? s : { ...s, polite: say(s.polite, line) };
    },
    // Client navigation between game pages reuses this element with a new game. The room
    // server's answer holds for every game; a page that never asked asks now.
    PropsChanged: (s, { props: p, prev }) => {
      if (p.game.id === prev.game.id) return s;
      const fresh = freshState(p.game, s.live, s.online);
      return s.live && asksOnline(p.game, s.online)
        ? [fresh, [checkOnline<LauncherMsg>((online) => ({ _tag: 'OnlineChecked', online }))]]
        : fresh;
    },
  },
  view: (s, _i, { props: { game } }): ChildValue => html`<div class="launcher" data-phase=${s.phase._tag}>
    ${mainView(s, game)}
    <p class="visually-hidden" aria-live="polite">${s.polite}</p>
    <p class="visually-hidden" aria-live="assertive">${s.assertive}</p>
  </div>`,
  styles,
});

declare global {
  interface HTMLElementTagNameMap {
    'jy-launcher': InstanceType<typeof Launcher>;
  }
}
