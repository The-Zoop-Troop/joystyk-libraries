// What the stage needs from the page: the games it can load, the player's storage, the
// system settings preferences resolve against, the session runners' ports and fresh seeds.
// The app provides them once, above the launcher, with `provideLauncherServices`; tests
// provide their own (memory storage, fast AI). Platform packages never import a game, so the
// game list always comes from the app (ARCHITECTURE.md).
import type { GameEntry, RngState } from '@joystyk/contracts';
import { seedState } from '@joystyk/kit/rng';
import type { Clock, FrameScheduler, Reporter, SocketFactory, TokenStore, Visibility } from '@joystyk/session';
import { browserPorts } from '@joystyk/session/browser';
import type { PlayerStorage, Storage, StorageNotice, SystemEnvironment } from '@joystyk/storage';

/** How the app loads one game: its entry, and a worker for heavy AI if the game has one. */
export type GameLoader = {
  /** The game's `entry.ts` (manifest plus lazy loaders), usually a dynamic import. */
  readonly entry: () => Promise<GameEntry<HTMLElement>>;
  /**
   * For a manifest with `ai.heavy`: a worker running the game's `jobs/ai.worker.ts`
   * (`new Worker(new URL(…, import.meta.url), { type: 'module' })`). Without it the runner
   * plays heavy AI inline and reports it.
   */
  readonly aiWorker?: () => Worker;
  /**
   * For an engine that requests jobs a local game may run (`where: 'either'`, such as Greed's
   * throws): a fresh worker for one job of `kind`, running the game's `jobs/<kind>.worker.ts`.
   * Without it the runner fails those jobs, and the engine decides what that means.
   */
  readonly jobWorker?: (kind: string) => Worker;
};

/** The games a page can launch, by id. */
export type GameLoaders = Readonly<Record<string, GameLoader>>;

/** The guest, with their storage. */
export type PlayerContext = {
  readonly playerId: string;
  readonly displayName: string;
  readonly storage: PlayerStorage;
  /** The device's storage, which the daily puzzle's content cache and results use (`@joystyk/daily/browser`). */
  readonly device?: Storage;
};

/**
 * Where the daily mode finds published puzzles, and the wall clock that says which UTC day it
 * is (D-46). Tests pass a fake `fetch` and a fixed clock.
 */
export type DailyServices = {
  /** Default "/daily", the site's published-content path (content-pipeline.md, "Delivery"). */
  readonly baseUrl?: string;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
};

/** The system settings `resolvePreferences` falls back on, now and on change. */
export interface SystemSource {
  get(): SystemEnvironment;
  subscribe(listener: (environment: SystemEnvironment) => void): () => void;
}

/** A room server answer: the value, or why not, worded for players. */
export type RoomAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/**
 * How the stage reaches the room server (D-48). The default (`browser/rooms.ts`, loaded with
 * the stage) uses this page's origin, where Traefik routes `/api/rooms` and `/ws` to the room
 * service; tests pass their own.
 */
export interface RoomServices {
  /** `POST /api/rooms`: a new room with the creator in seat 0, and a notice when the name was replaced. */
  create(
    gameId: string,
    name: string,
  ): Promise<RoomAnswer<{ readonly room: string; readonly token: string; readonly notice: string | null }>>;
  /** `GET /api/rooms/:code`: which game the room plays. */
  find(code: string): Promise<RoomAnswer<{ readonly gameId: string }>>;
  readonly connect: SocketFactory;
  readonly tokens: TokenStore;
  /** A fresh action ID: 8–40 URL-safe characters. */
  actionId(): string;
  /** The invite link: this game page with `?room=CODE`. */
  inviteLink(code: string): string;
}

export type RunnerPorts = {
  readonly clock: Clock;
  readonly visibility: Visibility;
  readonly frames: FrameScheduler;
  readonly report: Reporter;
};

export interface LauncherServices {
  readonly games: GameLoaders;
  /** Opens storage and the guest identity; the same promise every time. */
  openPlayer(): Promise<PlayerContext>;
  readonly system: SystemSource;
  readonly ports: RunnerPorts;
  /** A fresh, unpredictable seed for a new game (and, separately, its AI). */
  newSeed(): RngState;
  /** Storage problems worded for players (a full disk, private browsing). Returns how to stop. */
  onNotice(listener: (message: string) => void): () => void;
  /** The pause before an inline AI moves, so players can follow. Default 500 ms. */
  readonly aiDelayMs?: number;
  /** Deep-freeze snapshots (development). Default true. */
  readonly freeze?: boolean;
  /** The room server for Online with friends. Default: this page's origin. */
  readonly rooms?: RoomServices;
  /** The daily puzzle's content and clock. Default: this page's `/daily/` and the device clock. */
  readonly daily?: DailyServices;
}

// --- Providing and finding them ------------------------------------------------------------------

const provided = new WeakMap<Node, LauncherServices>();

/** Makes `services` available to every launcher below `target` (the document, or a test container). */
export const provideLauncherServices = (target: Node, services: LauncherServices): (() => void) => {
  provided.set(target, services);
  return () => {
    if (provided.get(target) === services) provided.delete(target);
  };
};

/** The services of the nearest provider above `from`, crossing shadow roots, or null. */
export const findLauncherServices = (from: Node): LauncherServices | null => {
  let node: Node | null = from;
  while (node !== null) {
    const found = provided.get(node);
    if (found !== undefined) return found;
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
  }
  return null;
};

// --- Building them -------------------------------------------------------------------------------

/** The system settings from media queries, following changes. */
export const mediaSystem = (view: Window = window): SystemSource => {
  const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const dark = view.matchMedia('(prefers-color-scheme: dark)');
  const get = (): SystemEnvironment => ({
    prefersReducedMotion: motion.matches,
    prefersDark: dark.matches,
    locale: view.navigator.language,
  });
  return {
    get,
    subscribe: (listener) => {
      const onChange = (): void => listener(get());
      motion.addEventListener('change', onChange);
      dark.addEventListener('change', onChange);
      return () => {
        motion.removeEventListener('change', onChange);
        dark.removeEventListener('change', onChange);
      };
    },
  };
};

/** A seed from 128 bits of the browser's cryptographic randomness. */
export const cryptoSeed = (): RngState => seedState(crypto.randomUUID());

export type LauncherServiceOptions = {
  readonly games: GameLoaders;
  /** Opens storage. Default: IndexedDB (`openBrowserStorage`), falling back to memory. */
  readonly openStorage?: (onNotice: (notice: StorageNotice) => void) => Promise<Storage>;
  readonly system?: SystemSource;
  readonly ports?: Partial<RunnerPorts>;
  readonly newSeed?: () => RngState;
  readonly aiDelayMs?: number;
  readonly freeze?: boolean;
  readonly rooms?: RoomServices;
  readonly daily?: DailyServices;
};

/**
 * The page's services. Storage and identity open on the first game, not on page load, and
 * their code loads then too.
 */
export const createLauncherServices = (options: LauncherServiceOptions): LauncherServices => {
  const listeners = new Set<(message: string) => void>();
  const notify = (notice: StorageNotice): void => {
    for (const listener of [...listeners]) listener(notice.message);
  };
  let player: Promise<PlayerContext> | null = null;
  const openPlayer = async (): Promise<PlayerContext> => {
    const storage = await (
      options.openStorage ??
      (async (onNotice) => (await import('@joystyk/storage/browser')).openBrowserStorage({ onNotice }))
    )(notify);
    const { createBrowserIdentity } = await import('@joystyk/identity/browser');
    const profile = await createBrowserIdentity(storage).current();
    return {
      playerId: profile.id,
      displayName: profile.displayName,
      storage: storage.player(profile.id),
      device: storage,
    };
  };
  return {
    games: options.games,
    openPlayer: () => {
      player ??= openPlayer().catch((error: unknown) => {
        player = null;
        throw error;
      });
      return player;
    },
    system: options.system ?? mediaSystem(),
    ports: { ...browserPorts(), ...options.ports },
    newSeed: options.newSeed ?? cryptoSeed,
    onNotice: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(options.aiDelayMs === undefined ? {} : { aiDelayMs: options.aiDelayMs }),
    ...(options.freeze === undefined ? {} : { freeze: options.freeze }),
    ...(options.rooms === undefined ? {} : { rooms: options.rooms }),
    ...(options.daily === undefined ? {} : { daily: options.daily }),
  };
};
