import type { GameOption } from './options.ts';
import type { GameVersions } from './versions.ts';

/** How a game can be played. */
export type Mode = 'solo' | 'ai' | 'pass-and-play' | 'p2p' | 'server' | 'daily';

/**
 * One undo rule (D-32). The platform implements undo by replay, back to the start of the
 * human's previous decision, and never past an input whose transition was an undo barrier.
 * `limited` is the most undos allowed per game.
 */
export type UndoPolicy = 'none' | 'unlimited' | { readonly limited: number };

/**
 * Undo rules per local mode. A mode left out uses `default`, and `default` left out is
 * 'none'. Pass-and-play never falls back to `default`: a game names it to allow undo there.
 * Rooms (`p2p`, `server`) never have undo.
 */
export type UndoByMode = {
  readonly default?: UndoPolicy;
  readonly solo?: UndoPolicy;
  readonly vsAi?: UndoPolicy;
  readonly daily?: UndoPolicy;
  readonly passAndPlay?: UndoPolicy;
};

/** The manifest's `undo`: one rule for solo, vs-AI and daily play, or rules per mode. */
export type UndoSetting = UndoPolicy | UndoByMode;

const isUndoPolicy = (undo: UndoSetting): undo is UndoPolicy => typeof undo === 'string' || 'limited' in undo;

/**
 * The undo rule for one mode. A single rule applies to solo, vs-AI and daily play;
 * pass-and-play gets undo only when the per-mode form names it; rooms never get it.
 */
export const undoPolicyFor = (undo: UndoSetting, mode: Mode): UndoPolicy => {
  if (mode === 'p2p' || mode === 'server') return 'none';
  if (isUndoPolicy(undo)) return mode === 'pass-and-play' ? 'none' : undo;
  switch (mode) {
    case 'pass-and-play':
      return undo.passAndPlay ?? 'none';
    case 'solo':
      return undo.solo ?? undo.default ?? 'none';
    case 'ai':
      return undo.vsAi ?? undo.default ?? 'none';
    case 'daily':
      return undo.daily ?? undo.default ?? 'none';
  }
};

/**
 * A per-move clock (D-34), in seconds per decision: each decision gets the full preset. The
 * room creator picks a preset; solo and vs-AI play never run a clock. `default` should be
 * one of `presets`. `mode` may be left out. Private rooms also offer Off (D-42): the
 * platform adds it to every clock's presets, so a manifest never lists it, and it is never
 * the default.
 */
export type TurnClock = {
  readonly mode?: 'move';
  readonly default: number;
  readonly presets: readonly number[];
};

/** One time-bank setting: the starting bank and what each move adds back (Fischer increment). */
export type BankClockPreset = {
  readonly initialMs: number;
  readonly incrementMs: number;
};

/**
 * A time bank with increment, as chess clocks keep: each seat starts with `initialMs`, its
 * bank runs down while it is pending, and each of its moves adds `incrementMs`. An empty
 * bank is a timeout. `default` should equal one of `presets`.
 */
export type BankClock = {
  readonly mode: 'bank';
  readonly default: BankClockPreset;
  readonly presets: readonly BankClockPreset[];
};

/** The manifest's `clock`: per move (the default mode) or a time bank. */
export type GameClock = TurnClock | BankClock;

/**
 * The manifest's `ai`: the levels, and whether choosing is heavy. A heavy AI (a deep Chess
 * or Go search) never runs on the UI thread or the room's event loop: local runners call it
 * in a Web Worker and the room server on its worker pool. Default: not heavy.
 */
export type AiDeclaration = {
  readonly levels: readonly string[];
  readonly heavy?: boolean;
};

/**
 * Per-game room defaults that aren't engine hooks (the room server's `RoomPolicy`). Seat
 * counts come from `players`, the clock from `clock`, and the allowed transports from
 * `privateState` and `modes`; the platform fills everything left out.
 */
export type RoomDefaults = {
  /** 'host': a lobby, then the host starts. 'immediate': the match starts at creation with AI in every seat. */
  readonly start?: 'host' | 'immediate';
  /** Someone arriving mid-match watches, or takes over an AI seat. */
  readonly lateJoin?: 'spectate' | 'take-ai-seat';
  /** After the grace period, an absent player's seat goes to the AI, has its turns expired, or waits. */
  readonly absent?: 'ai' | 'timeout' | 'wait';
  /** How long an absent player has to return, in milliseconds. */
  readonly graceMs?: number;
  /** Spectators allowed at once (D-33); 0 disables watching. */
  readonly maxSpectators?: number;
};

/**
 * The manifest's `players`: the fewest and most seats a table can have. `default`, a whole
 * number from `min` to `max`, is the table size the launcher's player-count picker starts at
 * against the computer; left out, the picker starts at its lowest count. Rooms ignore it: the
 * lobby's filled seats are the table (D-58). The catalog rejects a default out of range.
 */
export type PlayerCounts = {
  readonly min: number;
  readonly max: number;
  readonly default?: number;
};

/** One CSS color per color scheme, for a theme color that changes with light and dark. */
export type SchemeColors = { readonly light: string; readonly dark: string };

/** A theme color: one CSS color for both schemes, or one per scheme. */
export type ThemeColor = string | SchemeColors;

/**
 * The colors the launcher hands the canvas (`--game-accent`, `--game-surface`, `--game-ink`)
 * and the frame may use around it, e.g. for the launcher card. Each is a CSS color, or a
 * `{ light, dark }` pair that follows the player's color scheme.
 *
 * `ink` is the text color on `surface`. Left out, the launcher picks a readable near-black or
 * near-white for each scheme's surface. With `surface` left out, the canvas uses the frame's
 * own surface and text colors, and `ink` is ignored. A single surface never gets a per-scheme
 * ink: the launcher ignores an ink pair there and picks one ink for that surface.
 */
export type GameTheme = {
  readonly accent: ThemeColor;
  readonly surface?: ThemeColor;
  readonly ink?: ThemeColor;
};

/** The CSS color a theme color has under one color scheme. */
export const themeColorFor = (color: ThemeColor, scheme: 'light' | 'dark'): string =>
  typeof color === 'string' ? color : color[scheme];

/**
 * A game's static description. The server-rendered index reads it without loading game
 * code, so it is plain JSON.
 */
export type GameManifest = {
  /** Kebab-case and stable forever: it appears in URLs, saves and rooms. See `isGameId`. */
  readonly id: string;
  /** Display name, e.g. "Shift 23". */
  readonly name: string;
  /**
   * The fuller name people search for, when it differs from the display name: "Klondike
   * Solitaire" for Klondike. The game page uses it for its `<title>`, Open Graph title,
   * structured-data name and main heading; cards, the launcher and results keep `name`. It
   * must contain `name` (the catalog checks). Left out, the page uses `name`.
   */
  readonly pageTitle?: string;
  /** One sentence for cards and meta descriptions. */
  readonly summary: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly modes: readonly Mode[];
  readonly players: PlayerCounts;
  readonly ai: AiDeclaration | null;
  readonly layers: { readonly engine: boolean; readonly simulation: boolean };
  /**
   * True when `viewFor` hides part of the state from some seat (other hands, face-down
   * cards, a solution). Whoever runs the engine sees everything, so online multiplayer must
   * use server rooms and P2P is not allowed (D-08).
   */
  readonly privateState: boolean;
  /**
   * True when pass-and-play needs the hand-off screen (D-31) because seats see different
   * things. Memory Match hides cards from everyone alike: `privateState` true, `handoff` false.
   */
  readonly handoff: boolean;
  /** True if motion is part of play. Reduced motion then removes only decoration. */
  readonly essentialMotion: boolean;
  /** 'premium' arrives in v2. */
  readonly access: 'free';
  readonly versions: GameVersions;
  /** D-32. Read it through `undoPolicyFor(manifest.undo, mode)`. */
  readonly undo: UndoSetting;
  /** D-34. Null for games without a turn clock. */
  readonly clock: GameClock | null;
  readonly rooms?: RoomDefaults;
  /** URL of the build-emitted asset list, used for offline pinning. */
  readonly assets: string;
  readonly theme?: GameTheme;
  /**
   * True when the game plays AI-generated content (D-44). The launcher keeps it locked until
   * the player accepts the site-wide AI-content notice, once per device. Default: false.
   */
  readonly aiContent?: boolean;
  /**
   * A daily game whose day holds several puzzles (Crossword's Quick and Standard) names them
   * here. The launcher's daily mode then keeps one result per variant, from the engine's
   * `share(state).variant`, and treats the day as done only when every variant is. Left out:
   * one puzzle a day, one result.
   */
  readonly dailyVariants?: readonly string[];
  /** Optional common setup controls; daily content and saved configs remain authoritative. */
  readonly options?: readonly GameOption[];
  /** Creator or source credit shown as a link on the game page. */
  readonly attribution?: { readonly text: string; readonly href: string };
};

const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True for a kebab-case game id such as "shift-23". */
export const isGameId = (value: unknown): value is string => typeof value === 'string' && GAME_ID.test(value);

/**
 * Returns the manifest unchanged, keeping its literal types (the `id`, the `modes` tuple).
 * It rejects keys the manifest type doesn't know, which catches a misspelled optional field.
 */
export const defineManifest = <const M extends GameManifest>(
  manifest: M & { readonly [K in Exclude<keyof M, keyof GameManifest>]: never },
): M => manifest;
