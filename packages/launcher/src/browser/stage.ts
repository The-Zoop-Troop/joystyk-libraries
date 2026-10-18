// <jy-game-stage>: the part of the launcher with a lifecycle. `<jy-launcher>` renders it with
// a `control` property (plain data, model.ts `StageControl`) and listens to its outputs.
// When connected it loads the game through the app's loaders, opens the player's storage and
// looks for a save; when told to begin it creates the local session (or the fixed-step
// runner, or the game's own Layer 1 session), mounts the canvas with a PlatformApi, and
// reports what the frame needs from each snapshot. Disconnecting it disposes everything; the
// session writes its last save on the way out.
//
// The daily puzzle (D-46) is a local session on today's published config: after the
// AI-content notice, the stage downloads today's puzzle through `@joystyk/daily/browser`
// (cached for offline play), or reports today's earlier result when the player has already
// finished it; at the outcome it records the result and reports the streaks and share text.
//
// Online with friends, it opens a server room instead: it creates the room (or checks the
// code it was given), opens the remote session, reports the room after every change, performs
// the lobby's requests, and mounts the game when the match starts (again at each rematch).
//
// The canvas is a `<div>` in the stage's own shadow root, so the frame's styles never reach
// the game. It carries the game's theme tokens (`--game-accent`, `--game-surface`,
// `--game-ink`; see ../theme.ts) and the player's color scheme, which resolves any
// `light-dark()` pair in them; the frame keeps Joystyk's tokens (D-07).
import { OUTPUT_EVENT } from '@gyral/core';
import {
  err,
  setupOptions,
  gameError,
  ok,
  type AnyGameSession,
  type GameEntry,
  type GameError,
  type GameModule,
  type Json,
  type Mounted,
  type Outcome,
  type PlatformApi,
  type Preferences,
  type Result,
  type SaveEnvelope,
  type OutcomeResult,
  type SeatInfo,
  type SessionSnapshot,
  type ShareSummary,
  type Validator,
} from '@joystyk/contracts';
import {
  dailyWordStats,
  type DailyWordStats,
  creditDate,
  parsePuzzleId,
  shareText,
  utcDate,
  type DailyOutcome,
  type DailyResult,
  type ShareRow,
  type Streaks,
} from '@joystyk/daily';
import {
  contentHashOf,
  createDailyClient,
  createDailyResults,
  nextReleaseLocal,
  type DailyResults,
} from '@joystyk/daily/browser';
import { restoreRng } from '@joystyk/kit/rng';
import {
  createFixedStepRunner,
  createLocalSession,
  createRemoteSession,
  restoreFixedStepRunner,
  restoreLocalSession,
  type LocalMode,
  type LocalSession,
  type RemoteSession,
  type RemoteSnapshot,
  type SaveStore as RunnerSaveStore,
} from '@joystyk/session';
import { createGameAudio, watchGameAudio, workerAiRunner, workerJobRunner } from '@joystyk/session/browser';
import { DEFAULT_PREFERENCES, resolvePreferences, type SavedGame, type StoredPreferences } from '@joystyk/storage';
import {
  accessGate,
  clockOptions,
  GUEST_NAME,
  type ClockSetting,
  type DailyFrame,
  type FrameState,
  type RoomFrame,
  type RoomOfferFrame,
  type RoomRequest,
  type RoomSeat,
  type RoomTimer,
  type StageControl,
  type StageOutput,
} from '../model.ts';
import { SAVE_REQUEST_EVENT, type SaveRequestDetail } from '../safe-point.ts';
import { canvasTheme } from '../theme.ts';
import { saveDescription } from '../save-slots.ts';
import { pageRooms } from './rooms.ts';
import {
  findLauncherServices,
  type GameLoader,
  type LauncherServices,
  type PlayerContext,
  type RoomServices,
} from './services.ts';

export const STAGE_TAG = 'jy-game-stage';

const STAGE_STYLES = `
  :host { display: block; }
  :host([hidden]) { display: none; }
  .canvas {
    display: block;
    min-block-size: inherit;
    border-radius: inherit;
    background: var(--game-surface, transparent);
    color: var(--game-ink, inherit);
    color-scheme: inherit;
  }
`;

let sheet: CSSStyleSheet | null = null;
const stageSheet = (): CSSStyleSheet => {
  if (sheet === null) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(STAGE_STYLES);
  }
  return sheet;
};

type Inputs = (input: { readonly kind: 'pause' | 'resume' | 'reveal' }) => void;

type Running = {
  readonly session: AnyGameSession;
  readonly inputs: Inputs | null;
  /** The engine's config for a rematch, read at the outcome, or null. */
  readonly rematch: () => Json | null;
  /** The engine's state now (a local engine session), for the daily share summary; null otherwise. */
  readonly state: () => Json | null;
  /** The save envelope for the position now (local and fixed-step sessions); null for rooms and Layer 1 games. */
  readonly checkpoint: (() => SaveEnvelope) | null;
};

const noRematch = (): null => null;
const noState = (): null => null;

type Loaded = {
  readonly loader: GameLoader;
  readonly entry: GameEntry<HTMLElement>;
  readonly module: GameModule<HTMLElement>;
  readonly player: PlayerContext;
  readonly preferences: StoredPreferences;
  save: SavedGame | null;
};

const json = (value: unknown): string => JSON.stringify(value);

/** Runs a synchronous Standard Schema; an async one is refused. */
const decodeSync = <T>(schema: Validator<T>, value: unknown): Result<T, GameError> => {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) return err(gameError('AsyncSchema', 'The game setup could not be checked.'));
  return result.issues === undefined
    ? ok(result.value)
    : err(gameError('InvalidSetup', 'The game setup is not valid.', { issues: result.issues.map((i) => i.message) }));
};

const describeSave = (describe: (state: Json) => unknown, state: Json) => {
  try {
    return decodeSync(saveDescription, describe(state));
  } catch {
    return err(gameError('InvalidSaveSlot', 'The saved game could not be grouped.'));
  }
};

/**
 * A save slot per local mode, adapted to the runner's port. After the game ends, writes are
 * dropped and the slot is cleared, so a finished game is never offered for resuming. The
 * runner clears it too while the game isn't worth saving (the engine's `worthSaving`).
 */
const saveSlot = (
  player: PlayerContext,
  gameId: string,
  slot: string,
  groupOf?: (save: SaveEnvelope) => string | null,
  initialGroup: string | null = null,
) => {
  let finished = false;
  let group = initialGroup;
  let chain: Promise<void> = Promise.resolve();
  const port: RunnerSaveStore = {
    write: (save: SaveEnvelope) => {
      if (finished) return Promise.resolve();
      const write = chain.then(async () => {
        group = groupOf?.(save) ?? null;
        if (group !== null) {
          const grouped = await player.storage.saves.write(gameId, group, save);
          if (!grouped.ok) throw new Error(grouped.error.message);
        }
        const written = await player.storage.saves.write(gameId, slot, save);
        if (!written.ok) throw new Error(written.error.message);
      });
      chain = write.catch(() => {});
      return write;
    },
    clear: () => {
      if (finished) return Promise.resolve();
      const cleared = chain.then(async () => {
        if (group !== null) {
          await player.storage.saves.delete(gameId, group);
          group = null;
        }
        const deleted = await player.storage.saves.delete(gameId, slot);
        if (!deleted.ok) throw new Error(deleted.error.message);
      });
      chain = cleared.catch(() => {});
      return cleared;
    },
  };
  return {
    port,
    clear: (): Promise<void> => {
      chain = chain.then(async () => {
        if (group !== null) {
          await player.storage.saves.delete(gameId, group);
          group = null;
        }
        await player.storage.saves.delete(gameId, slot);
      });
      return chain;
    },
    finish: (): Promise<void> => {
      finished = true;
      chain = chain.then(async () => {
        if (group !== null) {
          await player.storage.saves.delete(gameId, group);
          group = null;
        }
        await player.storage.saves.delete(gameId, slot);
      });
      return chain;
    },
  };
};

const handoffOf = (snapshot: SessionSnapshot): FrameState['handoff'] => {
  const handoff = (snapshot as { readonly handoff?: unknown }).handoff;
  if (typeof handoff !== 'object' || handoff === null) return null;
  const { seat, name } = handoff as { readonly seat?: unknown; readonly name?: unknown };
  return typeof seat === 'number' && typeof name === 'string' ? { seat, name } : null;
};

/** What the frame needs from a snapshot, as plain data. */
export const frameOf = (snapshot: SessionSnapshot): FrameState => ({
  seats: snapshot.meta.seats.map((seat) => ({ ...seat })),
  handoff: handoffOf(snapshot),
  outcome: snapshot.meta.outcome === null ? null : (JSON.parse(JSON.stringify(snapshot.meta.outcome)) as Outcome),
  safePoint: snapshot.meta.safePoint,
  notice: snapshot.meta.notice?.message ?? null,
});

/** The room's clock setting, as the lobby shows it. */
const clockOf = (settings: {
  readonly decisionMs: number | null;
  readonly bank: { readonly initialMs: number; readonly incrementMs: number } | null;
}): ClockSetting =>
  settings.bank !== null
    ? { kind: 'bank', initialMs: settings.bank.initialMs, incrementMs: settings.bank.incrementMs }
    : settings.decisionMs !== null
      ? { kind: 'move', ms: settings.decisionMs }
      : { kind: 'off' };

const seatName = (seats: readonly RoomSeat[], seat: number): string =>
  seats.find((s) => s.id === seat)?.name ?? `Seat ${String(seat + 1)}`;

/**
 * The decision clock that is running, counted down from when the room reported it; or, on a
 * paused table (D-58), the clock that waits, holding its time.
 */
const timerOf = (snapshot: RemoteSnapshot<Json, Json>, seats: readonly RoomSeat[], now: number): RoomTimer | null => {
  const room = snapshot.room;
  const clocks = snapshot.meta.clocks ?? [];
  const shown = clocks.find((clock) => clock.running) ?? clocks.find((clock) => clock.paused === true);
  if (room === null || shown === undefined || room.phase !== 'playing') return null;
  const left = shown.running ? Math.max(0, shown.remainingMs - (now - room.clocksReadAt)) : shown.remainingMs;
  return {
    seat: shown.seat,
    name: seatName(seats, shown.seat),
    seconds: Math.ceil(left / 1000),
    paused: !shown.running,
  };
};

/** The room's offer, with the players it waits for and an end offer's seconds left. */
const offerOf = (
  snapshot: RemoteSnapshot<Json, Json>,
  seats: readonly RoomSeat[],
  now: number,
): RoomOfferFrame | null => {
  const room = snapshot.room;
  const offer = room?.offer ?? null;
  if (room === null || offer === null) return null;
  // A rematch waits for every seated player; an end offer for the other players who are here.
  const voters = seats.filter(
    (s) => s.claimed && s.controller === 'human' && (offer.kind === 'rematch' || (s.id !== offer.by && s.connected)),
  );
  const elapsed = room.paused ? 0 : Math.max(0, now - room.clocksReadAt);
  return {
    id: offer.id,
    kind: offer.kind,
    by: offer.by,
    byName: seatName(seats, offer.by),
    status: offer.status,
    accepted: [...offer.accepted],
    declinedBy: offer.declinedBy,
    declinedName: offer.declinedBy === null ? null : seatName(seats, offer.declinedBy),
    waiting: offer.status === 'open' ? voters.filter((s) => !offer.accepted.includes(s.id)).map((s) => s.name) : [],
    seconds: offer.endsInMs === null ? null : Math.ceil(Math.max(0, offer.endsInMs - elapsed) / 1000),
  };
};

/** What the lobby and the bar need from a room snapshot, as plain data. */
export const roomFrameOf = (
  snapshot: RemoteSnapshot<Json, Json>,
  context: {
    readonly code: string;
    readonly link: string;
    readonly manifest: GameEntry['manifest'];
    readonly now: number;
  },
): RoomFrame => {
  const room = snapshot.room;
  const seats: RoomSeat[] = (room?.seats ?? []).map((seat) => ({
    id: seat.id,
    name: seat.name,
    controller: seat.controller,
    aiLevel: seat.aiLevel,
    claimed: seat.claimed,
    ready: seat.ready,
    connected: room?.connected[seat.id] ?? false,
  }));
  const { manifest } = context;
  return {
    code: context.code,
    link: context.link,
    phase: room?.phase ?? (snapshot.meta.connection === 'closed' ? 'closed' : 'connecting'),
    connection: snapshot.meta.connection === 'local' ? 'online' : snapshot.meta.connection,
    seat: snapshot.meta.seat,
    host: room?.host ?? null,
    seats,
    minSeats: Math.max(2, manifest.players.min),
    clock: room === null ? { kind: 'off' } : clockOf(room.settings),
    clockOptions: clockOptions(manifest.clock),
    aiLevel: room?.settings.aiLevel ?? null,
    aiLevels: manifest.ai === null ? [] : [...manifest.ai.levels],
    spectators: room?.spectators ?? 0,
    timer: timerOf(snapshot, seats, context.now),
    notice: snapshot.meta.notice?.message ?? null,
    noticeCode: snapshot.meta.notice?.code ?? null,
    match: room?.match ?? 0,
    offer: offerOf(snapshot, seats, context.now),
  };
};

/** A finished game's result as a daily result records it. */
const dailyOutcome = (result: OutcomeResult): DailyOutcome =>
  result === 'won' ? 'won' : result === 'lost' || result === 'abandoned' ? 'lost' : 'completed';

/** The game page's address for share text: no query string or fragment (a room's code, say). */
const pageUrl = (): string | undefined => {
  const url = `${location.origin}${location.pathname}`;
  return /^https?:\/\/[^\s?#]+$/.test(url) ? url : undefined;
};

/** The results panel's daily part: share text in both forms, streaks and the next release. */
const dailyFrame = (
  title: string,
  result: DailyResult,
  streaks: Streaks | null,
  headline: string,
  now: () => number,
  earlier: boolean,
  statistics?: DailyWordStats,
): DailyFrame => {
  const date = creditDate(result);
  const rows: ShareRow[] = result.shareRows.map((symbols, i) => ({
    symbols,
    words: result.shareWords?.[i] ?? `Row ${String(i + 1)}`,
    ...(result.shareDetails?.[i] == null ? {} : { detail: result.shareDetails[i]! }),
  }));
  const url = pageUrl();
  const input = { title, date, headline, rows, ...(url === undefined ? {} : { url }) };
  let share = '';
  let shareWords = '';
  try {
    share = shareText(input, 'symbols');
    shareWords = shareText(input, 'words');
  } catch {
    // A game whose rows break the share rules (letters in a symbol row) shares nothing rather than a spoiler.
  }
  const next = nextReleaseLocal({ now });
  const canLose = result.outcome !== 'completed';
  return {
    date,
    ...(statistics === undefined ? {} : { statistics }),
    share,
    shareWords,
    streak: streaks?.current ?? 0,
    bestStreak: streaks?.best ?? 0,
    winStreak: canLose ? (streaks?.winCurrent ?? 0) : null,
    bestWinStreak: canLose ? (streaks?.winBest ?? 0) : null,
    next: `New puzzle at ${next.time} (${next.countdown})`,
    earlier: earlier ? { result: result.outcome, summary: result.summary } : null,
  };
};

/** One game on one stage, from loading to disposal. */
const run = (host: HTMLElement, canvas: HTMLElement, first: StageControl) => {
  let control = first;
  let disposed = false;
  const preparations = new Set<{ dispose(): void }>();
  let loaded: Loaded | null = null;
  let begun = false;
  let running: Running | null = null;
  let mounted: Mounted | null = null;
  let stopAudio: (() => void) | null = null;
  let slot: ReturnType<typeof saveSlot> | null = null;
  let paused = false;
  let reveals = control.reveals;
  let lastPreferences = '';
  let lastFrame = '';
  let finished = false;
  const stops: (() => void)[] = [];
  const services: LauncherServices | null = findLauncherServices(host);
  let platform: PlatformApi | null = null;
  let saveChoices: readonly {
    slot: string;
    label: string;
    savedAt: number;
    elapsedMs: number;
    players: readonly string[];
  }[] = [];
  /** Online with friends: the room, once open. */
  let remote: {
    readonly session: RemoteSession<Json, Json, Json>;
    readonly code: string;
    readonly link: string;
    /** The match the canvas shows, or null before it mounts. */
    mountedMatch: number | null;
    lastRoom: string;
    ticker: (() => void) | null;
  } | null = null;

  const emit = (out: StageOutput): void => {
    if (!disposed) host.dispatchEvent(new CustomEvent(OUTPUT_EVENT, { detail: out, bubbles: true }));
  };
  const fail = (message: string, error?: unknown): void => {
    if (error !== undefined) services?.ports.report(error, message);
    emit({ _tag: 'Failed', message });
  };

  // --- Loading and the save check ------------------------------------------------------------

  const prepare = async (svc: LauncherServices): Promise<void> => {
    const loader = svc.games[control.gameId];
    if (loader === undefined) return fail("This game isn't available here yet.");
    const entry = await loader.entry();
    if (disposed) return;
    const { manifest } = entry;
    if (manifest.id !== control.gameId || !manifest.modes.includes(control.mode))
      return fail("This game can't be played in that mode.");
    if (control.mode === 'server' && (control.room === null || manifest.players.max < 2))
      return fail("This game can't be played online here.");
    if (accessGate(manifest.access) !== 'open') return fail('This game needs a pass to play.');
    const [module, player] = await Promise.all([entry.load(), svc.openPlayer()]);
    if (disposed) return;
    const stored = await player.storage.preferences.get();
    const preferences = stored.ok ? stored.value : DEFAULT_PREFERENCES;
    loaded = { loader, entry, module, player, preferences, save: await findSave(entry, module, player) };
    if (disposed) return;
    lastPreferences = json(preferences);
    // A preference changed in another tab: the launcher's menu and motion follow it, and
    // `lastPreferences` moves too, so `sync` doesn't write it back (gp-d4v). The game hears
    // of it through `platformFor`.
    stops.push(
      player.storage.preferences.subscribe((next, source) => {
        if (source !== 'other-tab' || json(next) === lastPreferences) return;
        lastPreferences = json(next);
        emit({ _tag: 'Preferences', preferences: next });
      }),
    );
    const save = loaded.save;
    emit({
      _tag: 'Prepared',
      preferences,
      save:
        save === null
          ? null
          : {
              savedAt: save.savedAt,
              elapsedMs: save.envelope.elapsedMs ?? 0,
              players: save.envelope.seats.map((seat) => seat.name),
              ...(saveChoices.length === 0 ? {} : { slot: save.slot, choices: saveChoices }),
            },
    });
    sync();
  };

  /** The saved game in this mode's slot, if it can still be played on. Others are cleared. */
  const findSave = async (
    entry: GameEntry<HTMLElement>,
    module: GameModule<HTMLElement>,
    player: PlayerContext,
    requested = control.mode as string,
    one = false,
  ): Promise<SavedGame | null> => {
    const { manifest } = entry;
    // A room keeps its own state on the server; there is nothing to resume on this device.
    if (control.mode === 'server') return null;
    const rules = module.engine ?? module.simulation;
    if (!one && module.engine?.saveSlot !== undefined) {
      const listed = await player.storage.saves.list(manifest.id);
      if (!listed.ok) return null;
      const groups = new Map<string, { save: SavedGame; label: string }>();
      for (const saved of listed.value) {
        if (saved.slot !== control.mode && !saved.slot.startsWith(`${control.mode}-`)) continue;
        const checked = await findSave(entry, module, player, saved.slot, true);
        if (checked === null) continue;
        const description = describeSave(module.engine.saveSlot, checked.envelope.state);
        if (!description.ok) continue;
        const key: string = `${control.mode}-${description.value.key}`;
        if (saved.slot !== control.mode && saved.slot !== key) continue;
        const old = groups.get(key);
        if (old === undefined || checked.savedAt > old.save.savedAt) {
          groups.set(key, { save: checked, label: description.value.label });
        }
      }
      const offered: { save: SavedGame; label: string }[] = [];
      for (const [key, group] of groups) {
        if (group.save.slot !== key) {
          // Migrate the validated legacy save even when an invalid grouped save exists.
          const migrated = await player.storage.saves.write(manifest.id, key, group.save.envelope);
          if (!migrated.ok) continue;
        }
        offered.push({ ...group, save: { ...group.save, slot: key } });
      }
      offered.sort((a, b) => b.save.savedAt - a.save.savedAt || a.save.slot.localeCompare(b.save.slot));
      saveChoices = offered.map(({ save, label }) => ({
        slot: save.slot,
        label,
        savedAt: save.savedAt,
        elapsedMs: save.envelope.elapsedMs ?? 0,
        players: save.envelope.seats.map((seat) => seat.name),
      }));
      return offered[0]?.save ?? null;
    }
    const found =
      rules === undefined
        ? await player.storage.saves.read(manifest.id, requested)
        : await player.storage.saves.load(manifest.id, requested, {
            saveVersion: manifest.versions.save,
            migrations: module.migrations,
            state: rules.schemas.state,
          });
    if (!found.ok || found.value === null) return null;
    const save = found.value;
    let over = false;
    if (rules !== undefined) {
      if (save.envelope.rulesVersion !== rules.rulesVersion) {
        emit({
          _tag: 'Notice',
          message: 'Your saved game was played under older rules, so it was set aside. A new game starts instead.',
        });
        over = true;
      } else {
        try {
          over =
            (module.engine?.outcome(save.envelope.state) ?? module.simulation?.outcome(save.envelope.state) ?? null) !==
            null;
          // An untouched game, saved before the engine said so, isn't offered either.
          over ||= module.engine?.worthSaving?.(save.envelope.state) === false;
        } catch (error) {
          services?.ports.report(error, 'Checking a saved game failed.');
          over = true;
        }
      }
    }
    if (!over) return save;
    await player.storage.saves.delete(manifest.id, requested);
    return null;
  };

  // --- Starting the game ---------------------------------------------------------------------

  const seatsWithNames = (player: PlayerContext): readonly SeatInfo[] =>
    control.seats.map((seat) =>
      seat.controller === 'human' && seat.name === GUEST_NAME ? { ...seat, name: player.displayName } : seat,
    );

  /**
   * The engine's Config: a rematch's, the preparer's output, or the setup itself (empty
   * until setup screens exist, so a game's config schema supplies its defaults).
   */
  const configFor = async (svc: LauncherServices, entry: GameEntry<HTMLElement>): Promise<Result<Json, GameError>> => {
    if (control.config !== null) return ok(control.config);
    const raw = control.setup ?? {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return err(gameError('InvalidSetup', 'Choose valid game options.'));
    const selected = raw as { readonly [key: string]: Json };
    const { level: aiLevel, ...options } = selected;
    if (
      control.mode === 'ai' &&
      entry.manifest.players.max === 1 &&
      aiLevel !== undefined &&
      (typeof aiLevel !== 'string' || !entry.manifest.ai?.levels.includes(aiLevel))
    )
      return err(gameError('InvalidSetup', 'Choose a valid computer level.'));
    const decodedSetup = decodeSync(
      setupOptions(entry.manifest.options ?? [], control.mode),
      control.mode === 'ai' && entry.manifest.players.max === 1 ? options : selected,
    );
    if (!decodedSetup.ok) return decodedSetup;
    const setup: Json =
      control.mode === 'ai' && entry.manifest.players.max === 1
        ? { ...decodedSetup.value, level: aiLevel ?? entry.manifest.ai?.levels[0] ?? 'medium' }
        : decodedSetup.value;
    if (loaded?.module.configFromSetup !== undefined) return loaded.module.configFromSetup(setup, control.mode);
    if (entry.loadAsyncPreparer === undefined && entry.loadPreparer === undefined) return ok(setup);
    const execution = entry.loadAsyncPreparer === undefined ? 'main' : 'worker';
    const started = performance.now();
    try {
      if (entry.loadAsyncPreparer !== undefined) {
        const bridge = await entry.loadAsyncPreparer();
        if (disposed) {
          bridge.dispose();
          return err(gameError('Disposed', 'The game was closed.'));
        }
        preparations.add(bridge);
        try {
          const decoded = decodeSync(bridge.setup, setup);
          return decoded.ok ? await bridge.prepare(decoded.value, restoreRng(svc.newSeed())) : decoded;
        } finally {
          bridge.dispose();
          preparations.delete(bridge);
        }
      }
      const preparer = await entry.loadPreparer!();
      const decoded = decodeSync(preparer.setup, setup);
      return decoded.ok ? preparer.prepare(decoded.value, restoreRng(svc.newSeed())) : decoded;
    } finally {
      const duration = performance.now() - started;
      const name = `joystyk:prepare:${entry.manifest.id}:${execution}`;
      performance.clearMeasures(name);
      performance.measure(name, { start: started, duration });
      if (import.meta.env.DEV)
        console.debug('[Joystyk preparation]', { game: entry.manifest.id, execution, durationMs: duration });
    }
  };

  const start = async (svc: LauncherServices, game: Loaded, how: 'new' | 'resume'): Promise<void> => {
    const mode = control.mode;
    if (mode === 'server') return startRoom(svc, game);
    const { entry, player, loader } = game;
    const { manifest } = entry;
    let resume = how === 'resume' ? game.save : null;
    if (how === 'resume' && control.resumeSlot !== undefined) {
      if (!saveChoices.some((choice) => choice.slot === control.resumeSlot))
        return fail('That saved game is no longer available.');
      resume = await findSave(entry, game.module, player, control.resumeSlot, true);
      if (resume === null) return fail('That saved game could not be resumed.');
    }
    const groupOf =
      game.module.engine?.saveSlot === undefined
        ? undefined
        : (save: SaveEnvelope): string | null => {
            const described = describeSave(game.module.engine!.saveSlot!, save.state);
            if (!described.ok) {
              svc.ports.report(described.error, 'The engine supplied an invalid save slot.');
              return null;
            }
            return `${mode}-${described.value.key}`;
          };
    const saves = saveSlot(
      player,
      manifest.id,
      mode,
      groupOf,
      resume !== null && game.module.engine?.saveSlot !== undefined ? resume.slot : null,
    );
    const write = saves.port.write;
    saves.port.write = (save) =>
      write(
        mode === 'daily' && daily !== null
          ? { ...save, daily: { puzzleId: daily.puzzleId, contentHash: daily.contentHash } }
          : save,
      );
    slot = saves;
    let given: Json | null = null;
    if (mode === 'daily') {
      if (resume !== null) await keepDaily(svc, game, resume);
      else {
        const today = await openDaily(svc, game);
        if (today === null || disposed) return;
        given = today;
      }
    }
    if (resume === null && game.save !== null) await saves.clear();
    if (disposed) return;
    const seats = seatsWithNames(player);
    const created = await createSession(svc, game, mode, seats, resume, loader, given);
    if (disposed) {
      if (created.ok) created.value.session.dispose();
      return;
    }
    if (!created.ok) {
      if (resume === null) return fail(created.error.message, created.error);
      // A save that can't be resumed is cleared, and a new game starts in its place.
      emit({ _tag: 'Notice', message: `${created.error.message} A new game starts instead.` });
      await saves.clear();
      game.save = null;
      return start(svc, game, 'new');
    }
    running = created.value;
    mount(svc, game, created.value.session);
  };

  const createSession = async (
    svc: LauncherServices,
    game: Loaded,
    mode: LocalMode,
    seats: readonly SeatInfo[],
    resume: SavedGame | null,
    loader: GameLoader,
    /** The daily puzzle's config, which replaces the game's own setup. */
    given: Json | null = null,
  ): Promise<Result<Running, GameError>> => {
    const { entry, module } = game;
    const { manifest } = entry;
    const storage = slot?.port;
    const common = {
      manifest,
      report: svc.ports.report,
      visibility: svc.ports.visibility,
      ...(storage === undefined ? {} : { storage }),
      freeze: svc.freeze ?? true,
    };
    if (module.engine !== undefined) {
      const heavy = manifest.ai?.heavy === true && loader.aiWorker !== undefined;
      const local = {
        ...common,
        mode,
        clock: svc.ports.clock,
        aiSeed: svc.newSeed(),
        aiDelayMs: svc.aiDelayMs ?? 500,
        ...(heavy && loader.aiWorker !== undefined ? { ai: workerAiRunner(loader.aiWorker) } : {}),
        ...(loader.jobWorker === undefined ? {} : { jobs: workerJobRunner(loader.jobWorker) }),
      };
      const engine = module.engine;
      const wrap = (session: LocalSession<Json, Json, Json>): Running => ({
        session,
        inputs: (input) => session.dispatch(input),
        state: () => session.save().state,
        checkpoint: () => session.save(),
        rematch: () => {
          const replay = session.replay();
          if (engine.rematch === undefined || replay === null) return null;
          try {
            return engine.rematch(replay.config, session.save().state);
          } catch (error) {
            svc.ports.report(error, 'The engine failed to name a rematch config.');
            return null;
          }
        },
      });
      if (resume !== null) {
        const restored = restoreLocalSession(engine, resume.envelope, { ...local, migrations: module.migrations });
        return restored.ok ? ok(wrap(restored.value)) : restored;
      }
      const choices =
        given === null ? null : decodeSync(setupOptions(manifest.options ?? [], mode), control.setup ?? {});
      if (choices !== null && !choices.ok) return choices;
      const config =
        given === null
          ? await configFor(svc, entry)
          : module.configFromSetup !== undefined && choices?.ok
            ? module.configFromSetup(choices.value, mode, given)
            : ok(given);
      if (!config.ok) return config;
      const created = createLocalSession(engine, { ...local, seats, config: config.value, seed: svc.newSeed() });
      return created.ok ? ok(wrap(created.value)) : created;
    }
    if (module.simulation !== undefined) {
      const fixed = { ...common, frames: svc.ports.frames };
      const pausable =
        (runner: { dispatch(input: { readonly kind: 'pause' | 'resume' }): void }): Inputs =>
        (input) => {
          if (input.kind !== 'reveal') runner.dispatch({ kind: input.kind });
        };
      if (resume !== null) {
        const restored = restoreFixedStepRunner(module.simulation, resume.envelope, {
          ...fixed,
          startPaused: true,
          migrations: module.migrations,
        });
        return restored.ok
          ? ok({
              session: restored.value,
              inputs: pausable(restored.value),
              rematch: noRematch,
              state: () => restored.value.save().state,
              checkpoint: () => restored.value.save(),
            })
          : restored;
      }
      const config = given === null ? await configFor(svc, entry) : ok(given);
      if (!config.ok) return config;
      const created = createFixedStepRunner(module.simulation, {
        ...fixed,
        seats,
        config: config.value,
        seed: svc.newSeed(),
      });
      return created.ok
        ? ok({
            session: created.value,
            inputs: pausable(created.value),
            rematch: noRematch,
            state: () => created.value.save().state,
            checkpoint: () => created.value.save(),
          })
        : created;
    }
    if (module.createSession !== undefined) {
      const config = await configFor(svc, entry);
      if (!config.ok) return config;
      try {
        const session = module.createSession({
          mode,
          seats,
          seat: seats.find((seat) => seat.controller === 'human')?.id ?? null,
          config: config.value,
          seed: svc.newSeed(),
          save: resume?.envelope ?? null,
        });
        return ok({ session, inputs: null, rematch: noRematch, state: noState, checkpoint: null });
      } catch (error) {
        return err(gameError('SessionFailed', "The game couldn't start.", { error: String(error) }));
      }
    }
    return err(gameError('NoSession', "This game can't be played yet."));
  };

  // --- The daily puzzle ----------------------------------------------------------------------

  /** The daily mode's content client and results, once today's puzzle is open. */
  let daily: {
    readonly results: DailyResults;
    readonly now: () => number;
    /** The puzzle being played: its id and content hash, kept with the result. */
    readonly puzzleId: string;
    readonly contentHash: string;
  } | null = null;

  /**
   * A resumed daily game finishes on the puzzle its save holds, even after the next release
   * (D-46: a puzzle started is a puzzle kept); its result counts for that puzzle's date.
   */
  const keepDaily = async (svc: LauncherServices, game: Loaded, resume: SavedGame): Promise<void> => {
    const { player } = game;
    if (player.device === undefined) return;
    if (
      resume.envelope.daily !== undefined &&
      parsePuzzleId(resume.envelope.daily.puzzleId)?.gameId === game.entry.manifest.id
    ) {
      daily = {
        results: createDailyResults(player.device, player.playerId),
        now: svc.daily?.now ?? Date.now,
        ...resume.envelope.daily,
      };
      emit({ _tag: 'Puzzle', puzzleId: daily.puzzleId });
      return;
    }
    const config = resume.envelope.replay?.config ?? null;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) return;
    const id = (config as { readonly [key: string]: Json })['puzzleId'];
    const hash = await contentHashOf(config);
    if (typeof id !== 'string' || parsePuzzleId(id) === null || hash === null) return;
    daily = {
      results: createDailyResults(player.device, player.playerId),
      now: svc.daily?.now ?? Date.now,
      puzzleId: id,
      contentHash: hash,
    };
    emit({ _tag: 'Puzzle', puzzleId: id });
  };

  /**
   * Today's puzzle for a new daily game. Returns the config to start with, or null after
   * reporting why not: no puzzle (offline with nothing cached, or not published yet), or
   * today's puzzle already finished, whose result it reports instead.
   */
  const openDaily = async (svc: LauncherServices, game: Loaded): Promise<Json | null> => {
    const { entry, module, player } = game;
    const rules = module.engine ?? module.simulation;
    if (rules === undefined || player.device === undefined) {
      fail("This game's daily puzzle can't be played here.");
      return null;
    }
    const now = svc.daily?.now ?? Date.now;
    const results = createDailyResults(player.device, player.playerId);
    const client = createDailyClient<Json>({
      baseUrl: svc.daily?.baseUrl ?? '/daily',
      gameId: entry.manifest.id,
      config: rules.schemas.config as Validator<Json>,
      storage: player.device,
      ...(svc.daily?.fetch === undefined ? {} : { fetch: svc.daily.fetch }),
    });
    const today = utcDate(now());
    const puzzle = await client.puzzle(today);
    if (disposed) return null;
    if (!puzzle.ok) {
      fail(puzzle.error.message);
      return null;
    }
    // A day is done when every puzzle it holds is: one result, or one per variant (Crossword's).
    const variants: readonly (string | null)[] = entry.manifest.dailyVariants ?? [null];
    let earlier: DailyResult | null = null;
    for (const variant of variants) {
      const found = await results.get(puzzle.value.puzzleId, variant);
      if (disposed) return null;
      earlier = found.ok ? found.value : null;
      if (earlier === null) break;
    }
    if (earlier !== null) {
      const streaks = await results.streaks(entry.manifest.id, today);
      if (disposed) return null;
      emit({
        _tag: 'Daily',
        daily: dailyFrame(
          entry.manifest.name,
          earlier,
          streaks.ok ? streaks.value : null,
          earlier.summary,
          now,
          true,
          entry.manifest.id === 'daily-word' ? await wordStatistics(results, today) : undefined,
        ),
      });
      return null;
    }
    daily = { results, now, puzzleId: puzzle.value.puzzleId, contentHash: puzzle.value.contentHash };
    emit({ _tag: 'Puzzle', puzzleId: puzzle.value.puzzleId });
    // Housekeeping: downloads older than yesterday are no longer playable (v1 has no archive).
    void client.prune(today).catch(() => {});
    return puzzle.value.config;
  };

  const wordStatistics = async (results: DailyResults, today: string): Promise<DailyWordStats | undefined> => {
    const all = await results.list('daily-word');
    return all.ok ? dailyWordStats(all.value, today) : undefined;
  };

  /** Records the finished daily puzzle, then reports its streaks and share text. */
  const recordDaily = async (svc: LauncherServices, game: Loaded, outcome: Outcome): Promise<void> => {
    const open = daily;
    const engine = game.module.engine;
    const simulation = game.module.simulation;
    if (open === null || (engine === undefined && simulation === undefined)) return;
    let summary: ShareSummary | null = null;
    try {
      const state = running?.state() ?? null;
      summary = state === null ? null : (engine?.share?.(state, outcome) ?? simulation?.share?.(state) ?? null);
    } catch (error) {
      svc.ports.report(error, 'The engine failed to summarize the daily result for sharing.');
    }
    const rows = summary?.rows ?? [];
    const today = utcDate(open.now());
    const result: DailyResult = {
      puzzleId: open.puzzleId,
      // A day with variants keeps one result per variant (`GameManifest.dailyVariants`).
      variant:
        summary?.variant !== undefined && (game.entry.manifest.dailyVariants ?? []).includes(summary.variant)
          ? summary.variant
          : null,
      contentHash: open.contentHash,
      outcome: dailyOutcome(outcome.result),
      assisted: summary?.assisted ?? ((outcome.assists?.length ?? 0) > 0 || (outcome.undosUsed ?? 0) > 0),
      summary: outcome.summary.slice(0, 200),
      stats: { ...(outcome.stats ?? {}) },
      shareRows: rows.map((row) => row.symbols),
      shareWords: rows.map((row) => row.words),
      ...(rows.some((row) => row.detail !== undefined) ? { shareDetails: rows.map((row) => row.detail ?? null) } : {}),
      finishedOn: today,
    };
    const recorded = await open.results.record(result, today);
    if (disposed) return;
    if (!recorded.ok) {
      emit({ _tag: 'Notice', message: "Your result couldn't be saved on this device." });
      return;
    }
    const kept = recorded.value.result;
    emit({
      _tag: 'Daily',
      daily: dailyFrame(
        game.entry.manifest.name,
        kept,
        recorded.value.streaks,
        recorded.value.isNew ? (summary?.headline ?? kept.summary) : kept.summary,
        open.now,
        false,
        game.entry.manifest.id === 'daily-word' ? await wordStatistics(open.results, today) : undefined,
      ),
    });
  };

  // --- Online with friends ----------------------------------------------------------------------

  /** Opens the room: creates it (the creator holds seat 0) or checks the code, then connects. */
  const startRoom = async (svc: LauncherServices, game: Loaded): Promise<void> => {
    const { entry, module, player } = game;
    const { manifest } = entry;
    const plan = control.room;
    const engine = module.engine;
    if (plan === null || engine === undefined) return fail("This game can't be played online yet.");
    const rooms: RoomServices = svc.rooms ?? pageRooms();
    let code: string;
    if (plan.action === 'create') {
      const created = await rooms.create(manifest.id, player.displayName);
      if (disposed) return;
      if (!created.ok) return fail(created.message);
      // The token goes to storage before the socket opens, so the creator joins seat 0 as host.
      rooms.tokens.set(created.value.room, created.value.token);
      code = created.value.room;
      if (created.value.notice !== null) emit({ _tag: 'Notice', message: created.value.notice });
    } else {
      const found = await rooms.find(plan.code);
      if (disposed) return;
      if (!found.ok) return fail(found.message);
      if (found.value.gameId !== manifest.id)
        return fail('That code belongs to a room for another game. Open the invite link to reach its page.');
      code = plan.code;
    }
    const session = createRemoteSession<Json, Json, Json>({
      game: {
        id: manifest.id,
        build: manifest.versions.build,
        rulesVersion: engine.rulesVersion,
        schemas: engine.schemas,
      },
      room: code,
      name: player.displayName,
      watch: plan.action === 'join' && plan.watch,
      connect: rooms.connect,
      tokens: rooms.tokens,
      clock: svc.ports.clock,
      actionId: () => rooms.actionId(),
      freeze: svc.freeze ?? true,
      report: svc.ports.report,
    });
    running = { session, inputs: null, rematch: noRematch, state: noState, checkpoint: null };
    remote = { session, code, link: rooms.inviteLink(code), mountedMatch: null, lastRoom: '', ticker: null };
    platform = platformFor(svc, game);
    stops.push(session.subscribe((snapshot) => onRoom(svc, game, snapshot)));
    sync();
  };

  /** Reports the room, ticks its clock, and mounts the game when a match is there to show. */
  const onRoom = (svc: LauncherServices, game: Loaded, snapshot: RemoteSnapshot<Json, Json>): void => {
    const open = remote;
    if (open === null || disposed) return;
    reportRoom(svc, game);
    const match = snapshot.room?.match ?? 0;
    if (snapshot.view !== null && open.mountedMatch !== match) {
      // A new match (a rematch, or the first look) gets a fresh canvas.
      try {
        mounted?.dispose();
      } finally {
        mounted = null;
        canvas.replaceChildren();
      }
      open.mountedMatch = match;
      finished = false;
      lastFrame = '';
      mountCanvas(game.module, open.session);
    }
    if (open.mountedMatch === null) return;
    const frame = frameOf(snapshot);
    if (frame.outcome !== null && !finished) {
      finished = true;
      void game.player.storage.stats.record(game.entry.manifest.id, frame.outcome);
    }
    const text = json(frame);
    if (text === lastFrame) return;
    lastFrame = text;
    emit({ _tag: 'Frame', frame });
  };

  /** Emits the room when it changed; while a clock runs, again as its seconds tick. */
  const reportRoom = (svc: LauncherServices, game: Loaded): void => {
    const open = remote;
    if (open === null || disposed) return;
    const room = roomFrameOf(open.session.get(), {
      code: open.code,
      link: open.link,
      manifest: game.entry.manifest,
      now: svc.ports.clock.now(),
    });
    const text = json(room);
    if (text !== open.lastRoom) {
      open.lastRoom = text;
      emit({ _tag: 'Room', room });
    }
    open.ticker?.();
    // A running clock, or an offer to end the match counting down, is reported as it ticks.
    const ticking =
      (room.timer !== null && !room.timer.paused) || (room.offer?.status === 'open' && room.offer.seconds !== null);
    open.ticker = ticking ? svc.ports.clock.after(250, () => reportRoom(svc, game)) : null;
  };

  /** Turns a lobby request into the room control (or session input) it stands for. */
  const perform = (session: RemoteSession<Json, Json, Json>, request: RoomRequest): void => {
    switch (request.kind) {
      case 'ready':
        return session.dispatch({ kind: 'control', control: { kind: 'ready', ready: request.ready } });
      case 'clock': {
        const { setting } = request;
        const control =
          setting.kind === 'off'
            ? { kind: 'settings' as const, decisionMs: null, bank: null }
            : setting.kind === 'move'
              ? { kind: 'settings' as const, decisionMs: setting.ms }
              : { kind: 'settings' as const, bank: { initialMs: setting.initialMs, incrementMs: setting.incrementMs } };
        return session.dispatch({ kind: 'control', control });
      }
      case 'ai-level':
        return session.dispatch({ kind: 'control', control: { kind: 'settings', aiLevel: request.level } });
      case 'fill-with-ai':
      case 'remove-seat':
        return session.dispatch({ kind: 'control', control: { kind: request.kind, seat: request.seat } });
      case 'start':
        return session.dispatch({ kind: 'control', control: { kind: 'start' } });
      case 'offer':
        return session.dispatch({ kind: 'control', control: { kind: 'offer', offer: request.offer } });
      case 'answer':
        return session.dispatch({ kind: 'control', control: { kind: request.answer, offer: request.offer } });
      case 'reconnect':
        return session.dispatch({ kind: 'reconnect' });
      case 'leave':
        // The seat is given up over the socket before the stage goes away.
        session.dispatch({ kind: 'leave' });
        emit({ _tag: 'ExitRequested' });
        return;
    }
  };

  // --- Mounting and the PlatformApi ----------------------------------------------------------

  const mount = (svc: LauncherServices, game: Loaded, session: AnyGameSession): void => {
    const { entry, player } = game;
    const { manifest } = entry;
    platform = platformFor(svc, game);
    stops.push(
      session.subscribe((snapshot) => {
        const frame = frameOf(snapshot);
        if (frame.outcome !== null && !finished) {
          finished = true;
          void slot?.finish();
          void player.storage.stats.record(manifest.id, frame.outcome);
          if (control.mode === 'daily') {
            void recordDaily(svc, game, frame.outcome).catch((error: unknown) =>
              fail("Your result couldn't be saved.", error),
            );
          } else {
            const rematch = running?.rematch() ?? null;
            if (rematch !== null) emit({ _tag: 'Rematch', config: rematch });
          }
        }
        const text = json(frame);
        if (text === lastFrame) return;
        lastFrame = text;
        emit({ _tag: 'Frame', frame });
      }),
    );
    mountCanvas(game.module, session);
  };

  /** Draws the game into the canvas with the stage's PlatformApi. */
  const mountCanvas = (module: GameModule<HTMLElement>, session: AnyGameSession): void => {
    if (platform === null) return;
    stopAudio?.();
    const audio = createGameAudio(platform.preferences, control.gameId);
    const withAudio: PlatformApi = { ...platform, audio };
    const stopSounds = watchGameAudio(session, withAudio, control.gameId);
    stopAudio = () => {
      stopSounds();
      audio.dispose();
    };
    try {
      mounted = module.mount(canvas, session, withAudio);
    } catch (error) {
      stopAudio();
      stopAudio = null;
      fail("The game couldn't start.", error);
    }
    sync();
  };

  /** The PlatformApi for this stage's game: its theme on the canvas, live preferences, storage. */
  const platformFor = (svc: LauncherServices, game: Loaded): PlatformApi => {
    const { entry, player } = game;
    const { manifest } = entry;
    const theme = canvasTheme(manifest.theme);
    canvas.style.setProperty('--game-accent', theme.accent);
    canvas.style.setProperty('--game-surface', theme.surface);
    canvas.style.setProperty('--game-ink', theme.ink);

    let stored = game.preferences;
    let resolved: Preferences = resolvePreferences(stored, svc.system.get());
    const listeners = new Set<(preferences: Preferences) => void>();
    const publish = (): void => {
      const next = resolvePreferences(stored, svc.system.get());
      canvas.style.colorScheme = next.colorScheme;
      if (json(next) === json(resolved)) return;
      resolved = next;
      for (const listener of [...listeners]) listener(next);
    };
    canvas.style.colorScheme = resolved.colorScheme;
    stops.push(
      player.storage.preferences.subscribe((next) => {
        stored = next;
        publish();
      }),
      svc.system.subscribe(publish),
    );

    return {
      storage: player.storage.gameStorage(manifest.id),
      preferences: {
        get: () => resolved,
        subscribe: (listener) => {
          const entry = (preferences: Preferences): void => listener(preferences);
          listeners.add(entry);
          return () => {
            listeners.delete(entry);
          };
        },
      },
      requestExit: () => {
        // Leaving a room from inside the canvas gives the seat up, like the frame's own button.
        if (remote !== null) remote.session.dispatch({ kind: 'leave' });
        emit({ _tag: 'ExitRequested' });
      },
      announce: (message, politeness) => emit({ _tag: 'Announce', message, politeness }),
    };
  };

  // --- Following the launcher ----------------------------------------------------------------

  /** Acts on what changed in `control`: begin, pause, reveals and preferences. */
  const sync = (): void => {
    if (disposed || services === null || loaded === null) return;
    if (control.preferences !== null && json(control.preferences) !== lastPreferences) {
      lastPreferences = json(control.preferences);
      void loaded.player.storage.preferences.update(control.preferences);
    }
    if (!begun && control.begin !== null) {
      begun = true;
      const game = loaded;
      start(services, game, control.begin).catch((error: unknown) => fail("The game couldn't start.", error));
      return;
    }
    if (running?.inputs === undefined || running.inputs === null) return;
    if (control.paused !== paused) {
      paused = control.paused;
      running.inputs({ kind: paused ? 'pause' : 'resume' });
    }
    while (reveals < control.reveals) {
      reveals += 1;
      running.inputs({ kind: 'reveal' });
    }
  };

  // --- A forced update ---------------------------------------------------------------------

  /**
   * Stops play and writes the position now, for a forced security update (`requestSave`):
   * a real-time game pauses first, which also checkpoints it. The write queues behind the
   * session's own, so whatever lands last is this position or a later one. A finished game
   * has nothing to keep; rooms keep their state on the server.
   */
  const saveNow = async (): Promise<void> => {
    const game = running;
    const saves = slot;
    if (game === null || game.checkpoint === null || saves === null || finished) return;
    game.inputs?.({ kind: 'pause' });
    await saves.port.write(game.checkpoint());
  };
  const onSaveRequest = (event: Event): void => {
    (event as CustomEvent<Partial<SaveRequestDetail> | null>).detail?.waitUntil?.(saveNow());
  };
  const doc = host.ownerDocument;
  doc.addEventListener(SAVE_REQUEST_EVENT, onSaveRequest);
  stops.push(() => doc.removeEventListener(SAVE_REQUEST_EVENT, onSaveRequest));

  if (services === null) {
    queueMicrotask(() =>
      fail("This page can't start games: the launcher has no services. Call provideLauncherServices above it."),
    );
  } else {
    stops.push(services.onNotice((message) => emit({ _tag: 'Notice', message })));
    prepare(services).catch((error: unknown) =>
      fail("The game couldn't load. Check your connection, then try again.", error),
    );
  }

  return {
    roomRequest: (request: RoomRequest): void => {
      if (disposed || remote === null) throw new Error('The room is not open.');
      perform(remote.session, request);
    },
    update: (next: StageControl): void => {
      control = next;
      sync();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      for (const bridge of preparations) bridge.dispose();
      preparations.clear();
      remote?.ticker?.();
      for (const stop of stops.splice(0)) stop();
      stopAudio?.();
      stopAudio = null;
      try {
        mounted?.dispose();
      } finally {
        running?.session.dispose();
        canvas.replaceChildren();
      }
    },
  };
};

/** The stage element. Set `control`; listen for `gyral-output` events. */
export class GameStage extends HTMLElement {
  #control: StageControl | null = null;
  #game: ReturnType<typeof run> | null = null;

  get control(): StageControl | null {
    return this.#control;
  }

  set control(value: StageControl | null) {
    this.#control = value;
    if (value === null) return;
    if (this.#game !== null) this.#game.update(value);
    else if (this.isConnected) this.#start(value);
  }

  /** A one-shot command from the launcher; the remote room is the authority. */
  roomRequest(request: RoomRequest): void {
    if (this.#game === null) throw new Error('The game stage is not running.');
    this.#game.roomRequest(request);
  }

  connectedCallback(): void {
    // A property set before the element was defined shadows the accessor; take it over.
    if (Object.hasOwn(this, 'control')) {
      const value = (this as unknown as { control: StageControl | null }).control;
      delete (this as unknown as { control?: unknown }).control;
      this.control = value;
    }
    if (this.#game === null && this.#control !== null) this.#start(this.#control);
  }

  disconnectedCallback(): void {
    this.#game?.dispose();
    this.#game = null;
  }

  #start(control: StageControl): void {
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [stageSheet()];
    const canvas = document.createElement('div');
    canvas.className = 'canvas';
    canvas.setAttribute('part', 'canvas');
    root.replaceChildren(canvas);
    this.#game = run(this, canvas, control);
  }
}

if (customElements.get(STAGE_TAG) === undefined) customElements.define(STAGE_TAG, GameStage);

declare global {
  interface HTMLElementTagNameMap {
    'jy-game-stage': GameStage;
  }
}
