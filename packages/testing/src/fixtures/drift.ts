// Drift: a tiny fixed-step simulation. A puck slides along a track, bouncing off both ends;
// the player nudges it left or right, and a wind gust from the seeded generator changes every
// 30 ticks. Touching the target scores a point and moves the target. The run ends after the
// configured number of ticks. Integer arithmetic only, so replays match in every engine.

import { defineSimulation, ok, type Rng } from '@joystyk/contracts';
import { guardSchema } from '../builders.ts';
import type { SimulationConformanceOptions } from '../simulation-conformance.ts';
import { isInt, isRecord } from './guards.ts';

export type DriftState = {
  readonly tick: number;
  readonly length: number;
  readonly limit: number;
  readonly pos: number;
  readonly vel: number;
  readonly wind: number;
  readonly target: number;
  readonly score: number;
};
export type DriftInput = { readonly type: 'nudge'; readonly dir: -1 | 1 };
export type DriftEvent = { readonly type: 'scored'; readonly score: number } | { readonly type: 'bounced' };
export type DriftConfig = { readonly length: number; readonly limit: number };
export type DriftView = { readonly x: number; readonly target: number; readonly score: number };

export const MAX_SPEED = 3;

const isState = (v: unknown): v is DriftState =>
  isRecord(v) &&
  ['tick', 'length', 'limit', 'pos', 'target', 'score'].every((k) => isInt(v[k], 0)) &&
  isInt(v['vel'], -MAX_SPEED, MAX_SPEED) &&
  isInt(v['wind'], -1, 1);
const isInput = (v: unknown): v is DriftInput =>
  isRecord(v) && v['type'] === 'nudge' && (v['dir'] === -1 || v['dir'] === 1);
const isEvent = (v: unknown): v is DriftEvent =>
  isRecord(v) && ((v['type'] === 'scored' && isInt(v['score'], 0)) || v['type'] === 'bounced');
const isConfig = (v: unknown): v is DriftConfig => isRecord(v) && isInt(v['length'], 4, 1000) && isInt(v['limit'], 1);

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export const drift = defineSimulation<DriftState, DriftInput, DriftView, DriftEvent, DriftConfig>({
  rulesVersion: 1,
  stepHz: 60,
  schemas: {
    config: guardSchema(isConfig, 'Expected { length, limit }.'),
    input: guardSchema(isInput, 'Expected { type: "nudge", dir: -1 | 1 }.'),
    state: guardSchema(isState, 'Not a Drift state.'),
    event: guardSchema(isEvent, 'Not a Drift event.'),
  },
  init: (config: DriftConfig, rng) =>
    ok({
      tick: 0,
      length: config.length,
      limit: config.limit,
      pos: rng.int(0, config.length + 1),
      vel: 0,
      wind: 0,
      target: rng.int(0, config.length + 1),
      score: 0,
    }),
  step: (state: DriftState, inputs: readonly DriftInput[], rng: Rng) => {
    let vel = state.vel;
    for (const input of inputs) vel = clamp(vel + input.dir, -MAX_SPEED, MAX_SPEED);
    const wind = state.tick % 30 === 0 ? rng.int(-1, 2) : state.wind;
    let pos = state.pos + vel + wind;
    const events: DriftEvent[] = [];
    if (pos < 0) {
      pos = 0 - pos;
      vel = Math.abs(vel);
      events.push({ type: 'bounced' });
    } else if (pos > state.length) {
      pos = 2 * state.length - pos;
      vel = 0 - Math.abs(vel);
      events.push({ type: 'bounced' });
    }
    let { target, score } = state;
    if (Math.abs(pos - target) <= 1) {
      score += 1;
      target = rng.int(0, state.length + 1);
      events.push({ type: 'scored', score });
    }
    return { state: { ...state, tick: state.tick + 1, pos, vel, wind, target, score }, events };
  },
  view: (state): DriftView => ({ x: state.pos, target: state.target, score: state.score }),
  outcome: (state) =>
    state.tick >= state.limit
      ? {
          result: 'completed',
          placements: [{ seat: 0, place: 1, score: state.score }],
          summary: `${state.score} points.`,
          stats: { score: state.score },
        }
      : null,
});

/** Conformance options for the Drift fixture. */
export const driftConformance: SimulationConformanceOptions<DriftState, DriftInput, DriftConfig> = {
  name: 'drift',
  configs: [{ length: 40, limit: 600 }],
  runs: 3,
  ticks: 1000,
  requireOutcome: true,
  inputs: (_state, _tick, rng) => (rng.int(0, 5) === 0 ? [{ type: 'nudge', dir: rng.int(0, 2) === 0 ? -1 : 1 }] : []),
  invariants: (s) => (s.pos >= 0 && s.pos <= s.length ? true : `the puck left the track at ${s.pos}`),
};
