// The engine registry (room-server.md sections 4.1 and 6.1): which games and rules versions
// this build carries. A room pins its rules version for a match; frozen engines stay
// registered until no live room needs them.
import type { AnyDiscreteEngine, Rng, RngState } from '@joystyk/contracts';
import { createRoomCore } from '../core.ts';
import type { CoreLimits, GamePin, RoomCore, RoomPolicy } from '../types.ts';

export type RegisteredEngine = {
  readonly pin: GamePin;
  readonly engine: AnyDiscreteEngine;
  readonly policy: RoomPolicy;
  /** The manifest's `ai.heavy`: choose on the worker pool with the `ai` job module. */
  readonly heavyAi?: boolean;
  /** Worker entry modules by job kind (a game's `jobs/<kind>.worker.ts`; `ai` for heavy AI). */
  readonly jobs?: { readonly [kind: string]: URL };
};

export type CurrentEngine = { readonly core: RoomCore; readonly pin: GamePin; readonly policy: RoomPolicy };

export interface EngineRegistry {
  /** The core for a game at a rules version, or null if this build no longer carries it. */
  core(gameId: string, rulesVersion: number): RoomCore | null;
  /** The newest engine for a game: new rooms and rematches use it. */
  current(gameId: string): CurrentEngine | null;
  games(): readonly string[];
  /** Pinned room work uses its rules version; unversioned probes select current. */
  jobModule(gameId: string, kind: string, rulesVersion?: number): URL | null;
}

/**
 * Builds a registry. For each game, the entry with the highest rules version is current;
 * the others are frozen engines kept for rooms already playing on them.
 */
export const createEngineRegistry = (
  entries: readonly RegisteredEngine[],
  rng: (state: RngState) => Rng,
  limits?: Partial<CoreLimits>,
): EngineRegistry => {
  const cores = new Map<string, RoomCore>();
  const current = new Map<string, CurrentEngine>();
  const jobs = new Map<string, URL>();
  for (const entry of entries) {
    const key = `${entry.pin.id}@${entry.pin.rulesVersion}`;
    if (cores.has(key)) throw new Error(`${key} is registered twice.`);
    const core = createRoomCore({
      engine: entry.engine,
      pin: entry.pin,
      rng,
      heavyAi: entry.heavyAi === true,
      ...(limits ? { limits } : {}),
    });
    cores.set(key, core);
    const newest = current.get(entry.pin.id);
    if (newest === undefined || newest.pin.rulesVersion < entry.pin.rulesVersion)
      current.set(entry.pin.id, { core, pin: entry.pin, policy: entry.policy });
    for (const [kind, url] of Object.entries(entry.jobs ?? {}))
      jobs.set(`${entry.pin.id}@${entry.pin.rulesVersion}/${kind}`, url);
  }
  return {
    core: (gameId, rulesVersion) => cores.get(`${gameId}@${rulesVersion}`) ?? null,
    current: (gameId) => current.get(gameId) ?? null,
    games: () => [...current.keys()],
    jobModule: (gameId, kind, rulesVersion) => {
      const version = rulesVersion ?? current.get(gameId)?.pin.rulesVersion;
      return version === undefined ? null : (jobs.get(`${gameId}@${version}/${kind}`) ?? null);
    },
  };
};
