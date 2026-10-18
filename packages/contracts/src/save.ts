import type { Json } from './json.ts';
import type { AssistCounts, AssistKind } from './outcome.ts';
import type { Replay } from './replay.ts';
import { err, gameError, ok, type Result } from './result.ts';
import type { RngState } from './rng.ts';
import type { SeatInfo } from './seats.ts';

/** One saved game, as the `storage` package writes it. */
export type SaveEnvelope = {
  readonly gameId: string;
  /** Published puzzle identity, independent of a game’s config shape. */
  readonly daily?: { readonly puzzleId: string; readonly contentHash: string };
  readonly build: string;
  readonly rulesVersion: number;
  /** The version of `state`'s shape; migrations bring it up to date. */
  readonly saveVersion: number;
  readonly rng: RngState;
  readonly seats: readonly SeatInfo[];
  readonly state: Json;
  /** Layer 3 only: the tick of this checkpoint. */
  readonly tick?: number;
  /**
   * Active play time in milliseconds, measured by the platform from the input that starts
   * the clock (the first accepted one, or the engine's `startsClock` transition) and paused
   * while the page is hidden or the game is paused.
   */
  readonly elapsedMs?: number;
  /**
   * Whether the play clock has started, so a resumed game neither starts it early nor
   * restarts it. A save without it (written before it existed) infers it from `elapsedMs`
   * and the replay.
   */
  readonly clockStarted?: boolean;
  /** The replay log so far, for undo and bug reports. */
  readonly replay?: Replay;
  /**
   * The random state of the AI's own stream (runner-driven AI), so a restored vs-AI game
   * continues with the choices it would have made. Never in a view.
   */
  readonly aiRng?: RngState;
  /** Undos used so far, so a `{ limited: n }` allowance survives a reload. */
  readonly undosUsed?: number;
  /**
   * The kinds of assistance used so far, in `ASSIST_KINDS` order. Kept here because undo
   * leaves no trace in the replay, and a save may lose its replay.
   */
  readonly assists?: readonly AssistKind[];
  /** Counts survive undo; optional for older saves. */
  readonly assistCounts?: AssistCounts;
};

/** One step of a game's save migration chain. */
export interface Migration {
  /** The save version this step reads. */
  readonly from: number;
  /** Always `from + 1`. */
  readonly to: number;
  migrate(old: Json): Result<Json>;
}

/**
 * Runs a game's migrations on saved state, from save version `from` up to `to`, one step at
 * a time. Fails with `SaveFromFuture` when the save is newer than this build, with
 * `MigrationMissing` when a step is absent, or with the step's own error. The caller then
 * validates the result with `schemas.state` and archives the save on any failure.
 */
export const runMigrations = (
  migrations: readonly Migration[],
  state: Json,
  from: number,
  to: number,
): Result<Json> => {
  if (from > to) {
    return err(gameError('SaveFromFuture', 'This saved game comes from a newer version of the game.', { from, to }));
  }
  let current = state;
  for (let version = from; version < to; version += 1) {
    const step = migrations.find((m) => m.from === version && m.to === version + 1);
    if (step === undefined) {
      return err(
        gameError('MigrationMissing', 'This saved game can no longer be opened.', { from: version, to: version + 1 }),
      );
    }
    const migrated = step.migrate(current);
    if (!migrated.ok) return migrated;
    current = migrated.value;
  }
  return ok(current);
};
