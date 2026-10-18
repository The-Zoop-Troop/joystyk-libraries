import { command, define, defineDriver, html, subscription, type DriverOverrides } from '@gyral/core';
import type { Pace } from './records.ts';
export type Hud = {
  title: string;
  status: string;
  phase: string;
  paused: boolean;
  resuming: boolean;
  pace: Pace;
  daily: boolean;
  best: number;
  race: boolean;
  pad: boolean;
  tone: boolean;
  autoFire: boolean;
  graphics: string;
  loaded: boolean;
  alignment: boolean;
  shooter: boolean;
};
export type PanelAction =
  | {
      type: 'primary' | 'race' | 'pad' | 'tone' | 'fire';
    }
  | {
      type: 'pace';
      pace: Pace;
    }
  | {
      type: 'graphics';
      value: 'auto' | 'low' | 'medium' | 'high';
    };
const feed = defineDriver<void, Hud, never>('arcade-hud'),
  action = defineDriver<PanelAction, void>('arcade-action');
type Msg =
  | {
      _tag: 'Changed';
      hud: Hud;
    }
  | {
      _tag: 'Action';
      action: PanelAction;
    };
const initial: Hud = {
  title: '',
  status: 'Loading settings…',
  phase: 'ready',
  paused: false,
  resuming: false,
  pace: 'standard',
  daily: false,
  best: 0,
  race: false,
  pad: false,
  tone: false,
  autoFire: false,
  graphics: 'auto',
  loaded: false,
  alignment: false,
  shooter: false,
};
export const ArcadePanel = define<
  {
    hud: Hud;
  },
  Msg
>()('jy-arcade-panel', {
  shadow: false,
  init: () => ({ hud: initial }),
  subscriptions: () => [command(feed, undefined, { onSuccess: (hud) => ({ _tag: 'Changed', hud }) })],
  intent: {
    Primary: () => ({ _tag: 'Action', action: { type: 'primary' } }),
    Race: () => ({ _tag: 'Action', action: { type: 'race' } }),
    Pad: () => ({ _tag: 'Action', action: { type: 'pad' } }),
    Tone: () => ({ _tag: 'Action', action: { type: 'tone' } }),
    Fire: () => ({ _tag: 'Action', action: { type: 'fire' } }),
    Pace: ({ value }) =>
      value === 'standard' || value === 'gentle'
        ? { _tag: 'Action', action: { type: 'pace', pace: value } }
        : undefined,
    Graphics: ({ value }) =>
      value === 'auto' || value === 'low' || value === 'medium' || value === 'high'
        ? { _tag: 'Action', action: { type: 'graphics', value } }
        : undefined,
  },
  update: {
    Changed: (_s, m) => ({ hud: m.hud }),
    Action: (s, m) => [s, [command(action, m.action, { concurrency: 'queue' })]],
  },
  view: (
    { hud: h },
    i,
  ) => html`<header><h2>${h.title}</h2><p class="status">${h.status}</p><p>Best (${h.pace}): <strong>${h.best}</strong></p></header>
 <div class="actions"><button type="button" data-intent=${i.Primary} ?disabled=${!h.loaded || h.resuming || h.phase === 'over'}>${h.phase === 'ready' ? 'Start' : h.resuming ? 'Resuming…' : h.paused ? 'Resume' : 'Pause'}</button>
 <button type="button" data-intent=${i.Race} ?hidden=${!h.race || h.daily || h.phase !== 'ready'}>Race your best</button></div>
 <fieldset ?disabled=${h.phase !== 'ready' || h.daily || !h.loaded}><legend>Run settings</legend><label>Pace <select data-intent=${i.Pace} value=${h.pace}><option value="standard">Standard</option><option value="gentle">Gentle</option></select></label></fieldset>
 <details><summary>Controls and graphics</summary><label>Graphics <select data-intent=${i.Graphics} value=${h.graphics}><option value="auto">Auto</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
 <label><input type="checkbox" ?checked=${h.pad} data-intent=${i.Pad}> Show control pad</label><label ?hidden=${!h.alignment}><input type="checkbox" ?checked=${h.tone} data-intent=${i.Tone}> Alignment tone</label><label ?hidden=${!h.shooter}><input type="checkbox" ?checked=${h.autoFire} data-intent=${i.Fire}> Automatic fire</label></details>`,
});
export const panelDrivers = (
  listen: (emit: (hud: Hud) => void) => () => void,
  perform: (action: PanelAction) => void,
): DriverOverrides => ({
  'arcade-hud': subscription<Hud>('arcade-hud', listen),
  'arcade-action': defineDriver<PanelAction, void>({ name: 'arcade-action', run: perform }),
});
