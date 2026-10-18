import type { AnyFixedStepSimulation, GameStorage, Json, SimulationReplay } from '@joystyk/contracts';
import { restoreRng } from '@joystyk/kit/rng';
import { replaySimulation } from '@joystyk/session';
import { z } from 'zod';
export const PACES = ['standard', 'gentle'] as const;
export type Pace = (typeof PACES)[number];
const rng = z.object({ algorithm: z.string(), words: z.array(z.number().int()) });
const replaySchema = z.object({
  layer: z.literal(3),
  gameId: z.string(),
  rulesVersion: z.number().int(),
  config: z.json(),
  seed: rng,
  inputs: z.array(z.object({ tick: z.number().int().nonnegative(), input: z.json() })).max(200000),
  endTick: z.number().int().nonnegative().max(2160000),
});
const recordSchema = z.object({ score: z.number().nonnegative(), replay: replaySchema.nullable() });
export type BestRun = {
  readonly score: number;
  readonly replay: SimulationReplay | null;
};
export function createRecords(storage: GameStorage, gameId: string, simulation: AnyFixedStepSimulation) {
  let chain = Promise.resolve();
  const best = async (pace: Pace): Promise<BestRun> => {
    const parsed = recordSchema.safeParse(await storage.get(`arcade.best.${pace}`).catch(() => null));
    if (!parsed.success) return { score: 0, replay: null };
    const value = parsed.data;
    if (
      value.replay !== null &&
      (value.replay.gameId !== gameId || value.replay.rulesVersion !== simulation.rulesVersion)
    ) {
      await storage.set(`arcade.best.${pace}`, { score: value.score, replay: null }).catch(() => {});
      return { score: value.score, replay: null };
    }
    return value;
  };
  return {
    best,
    async pace(): Promise<Pace> {
      const value = await storage.get('arcade.pace').catch(() => null);
      return value === 'gentle' ? value : 'standard';
    },
    remember(pace: Pace): Promise<void> {
      return storage.set('arcade.pace', pace);
    },
    record(pace: Pace, score: number, replay: SimulationReplay | null): Promise<void> {
      chain = chain
        .catch(() => {})
        .then(async () => {
          const old = await best(pace);
          if (score > old.score || (score === old.score && old.replay === null))
            await storage.set(`arcade.best.${pace}`, { score, replay });
        });
      return chain;
    },
  };
}
/** Independent simulation state and RNG: the ghost never dispatches to the live runner. */
export function createGhost(simulation: AnyFixedStepSimulation, record: unknown) {
  const parsed = replaySchema.safeParse(record);
  if (!parsed.success || parsed.data.rulesVersion !== simulation.rulesVersion) return null;
  const replay = parsed.data;
  const config = simulation.schemas.config['~standard'].validate(replay.config);
  if (config instanceof Promise || config.issues !== undefined) return null;
  let previous = -1;
  for (const entry of replay.inputs) {
    const checked = simulation.schemas.input['~standard'].validate(entry.input);
    if (
      checked instanceof Promise ||
      checked.issues !== undefined ||
      entry.tick < previous ||
      entry.tick >= replay.endTick
    )
      return null;
    previous = entry.tick;
  }
  try {
    const checked = replaySimulation(simulation, replay, restoreRng);
    if (!checked.ok) return null;
    const rng = restoreRng(replay.seed),
      initial = simulation.init(replay.config, rng);
    if (!initial.ok) return null;
    let state: Json = initial.value,
      tick = 0,
      index = 0;
    return {
      config: replay.config,
      advance(to: number): unknown {
        while (tick < Math.min(to, replay.endTick)) {
          const inputs: Json[] = [];
          while (replay.inputs[index]?.tick === tick) inputs.push(replay.inputs[index++]!.input);
          state = simulation.step(state, inputs, rng).state;
          tick++;
        }
        return simulation.view(state);
      },
    };
  } catch {
    return null;
  }
}
