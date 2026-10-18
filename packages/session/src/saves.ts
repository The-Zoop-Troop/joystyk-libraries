// Reading a save from storage: parse the envelope, check it belongs to this game and these
// rules, run the migration chain, then validate the state (game-contract.md, "Saves").
import {
  ASSIST_KINDS,
  err,
  gameError,
  isJson,
  ok,
  runMigrations,
  type GameError,
  type GameManifest,
  type Json,
  type Migration,
  type Result,
  type RngState,
  type SaveEnvelope,
  type SeatInfo,
  type Validator,
} from '@joystyk/contracts';
import { decode, isRecord } from './values.ts';
import { assistCountsSchema } from './assistance.ts';

/** The parts of a game's manifest a runner reads. `ai` matters only for its `heavy` flag. */
export type RunnerManifest = Pick<GameManifest, 'id' | 'versions' | 'undo' | 'handoff'> & {
  readonly ai?: GameManifest['ai'];
};

const unreadable = (why: string): GameError =>
  gameError('SaveUnreadable', 'This saved game could not be read.', { why });

const isRngState = (value: unknown): value is RngState =>
  isRecord(value) &&
  typeof value['algorithm'] === 'string' &&
  Array.isArray(value['words']) &&
  value['words'].every((word) => typeof word === 'number' && Number.isFinite(word));

export const isSeatInfo = (value: unknown): value is SeatInfo =>
  isRecord(value) &&
  Number.isInteger(value['id']) &&
  typeof value['name'] === 'string' &&
  (value['controller'] === 'human' || value['controller'] === 'ai') &&
  (value['aiLevel'] === undefined || typeof value['aiLevel'] === 'string');

const isWholeNumber = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** Checks the envelope's shape. The replay is checked by the runner that understands it. */
export const parseEnvelope = (value: unknown): Result<SaveEnvelope, GameError> => {
  if (!isRecord(value) || !isJson(value)) return err(unreadable('not a JSON object'));
  if (typeof value['gameId'] !== 'string' || typeof value['build'] !== 'string')
    return err(unreadable('game id or build'));
  if (!isWholeNumber(value['rulesVersion']) || !isWholeNumber(value['saveVersion'])) return err(unreadable('versions'));
  if (!isRngState(value['rng'])) return err(unreadable('rng'));
  const seats = value['seats'];
  if (!Array.isArray(seats) || !seats.every(isSeatInfo) || seats.some((seat, i) => seat.id !== i)) {
    return err(unreadable('seats'));
  }
  if (
    value['daily'] !== undefined &&
    (!isRecord(value['daily']) ||
      typeof value['daily']['puzzleId'] !== 'string' ||
      typeof value['daily']['contentHash'] !== 'string')
  )
    return err(unreadable('daily'));
  if (!Object.hasOwn(value, 'state')) return err(unreadable('state'));
  if (value['tick'] !== undefined && !isWholeNumber(value['tick'])) return err(unreadable('tick'));
  if (value['elapsedMs'] !== undefined && !isWholeNumber(value['elapsedMs'])) return err(unreadable('elapsedMs'));
  if (value['clockStarted'] !== undefined && typeof value['clockStarted'] !== 'boolean')
    return err(unreadable('clockStarted'));
  if (value['replay'] !== undefined && !isRecord(value['replay'])) return err(unreadable('replay'));
  if (value['aiRng'] !== undefined && !isRngState(value['aiRng'])) return err(unreadable('aiRng'));
  if (value['undosUsed'] !== undefined && !isWholeNumber(value['undosUsed'])) return err(unreadable('undosUsed'));
  const assists = value['assists'];
  if (
    assists !== undefined &&
    !(Array.isArray(assists) && assists.every((kind) => (ASSIST_KINDS as readonly unknown[]).includes(kind)))
  ) {
    return err(unreadable('assists'));
  }
  if (value['assistCounts'] !== undefined && !decode(assistCountsSchema, value['assistCounts'], 'assistance counts').ok)
    return err(unreadable('assistCounts'));
  return ok(value as unknown as SaveEnvelope);
};

/**
 * Brings a save up to date and validates its state. Fails with `SaveUnreadable`,
 * `SaveWrongGame`, `RulesChanged` (the rules version differs, so the game can't continue on
 * this code), a migration error, or `InvalidInput` from the state schema. The launcher
 * archives the save on any failure.
 */
export const loadSave = <State>(
  value: unknown,
  manifest: RunnerManifest,
  rulesVersion: number,
  migrations: readonly Migration[],
  stateSchema: Validator<State>,
): Result<{ readonly envelope: SaveEnvelope; readonly state: State }, GameError> => {
  const parsed = parseEnvelope(value);
  if (!parsed.ok) return parsed;
  const envelope = parsed.value;
  if (envelope.gameId !== manifest.id) {
    return err(gameError('SaveWrongGame', 'This saved game belongs to a different game.', { gameId: envelope.gameId }));
  }
  if (envelope.rulesVersion !== rulesVersion) {
    return err(
      gameError('RulesChanged', 'This saved game was played under older rules and can no longer continue.', {
        saved: envelope.rulesVersion,
        current: rulesVersion,
      }),
    );
  }
  const migrated = runMigrations(migrations, envelope.state, envelope.saveVersion, manifest.versions.save);
  if (!migrated.ok) return migrated;
  const state = decode(stateSchema, migrated.value, 'saved state');
  if (!state.ok) return state;
  return ok({ envelope, state: state.value });
};

/** True when a value is a list of JSON inputs, the least a replay's `inputs` must be. */
export const isJsonList = (value: unknown): value is readonly Json[] => Array.isArray(value) && isJson(value);
