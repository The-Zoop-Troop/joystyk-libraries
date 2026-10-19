import type { AnyFixedStepSimulation, AnyGameSession, Json, PlatformApi, SoundCue } from '@joystyk/contracts';
import type { FixedStepRunner } from '@joystyk/session';
import { bindHold, bindInput, type InputAction } from './input.ts';
import { bindPause } from './pause.ts';
import { createGhost, createRecords, type BestRun, type Pace } from './records.ts';
import { ArcadePanel, panelDrivers, type Hud, type PanelAction } from './panel.ts';
export type ArcadeView = {
  phase: string;
  pace: Pace;
  daily: boolean;
  course: number;
};
export type ArcadeDrawing<View> = {
  draw(view: View, alpha: number, ghost?: View | null): void;
  graphics(value: 'auto' | 'low' | 'medium' | 'high'): void;
  dispose(): void;
  available?: boolean;
};
export type ArcadeGameOptions<View extends ArcadeView> = {
  gameId: string;
  title: string;
  help: string;
  simulation: AnyFixedStepSimulation;
  score(view: View): number;
  status(view: View): string;
  action(action: InputAction, on: boolean, view: View): readonly Json[];
  drag?(x: number, y: number): Json;
  gesture: 'swipe' | 'tap' | 'drag';
  ghost?: boolean;
  alignment?: boolean;
  eventLine?(event: Json, view: View): string | null;
  render(host: HTMLElement, pause: () => void, announce: (text: string) => void): Promise<ArcadeDrawing<View>>;
};
const CSS = `:host{display:block;font:1rem/1.5 system-ui;color:var(--game-ink,CanvasText);container-type:inline-size}*{box-sizing:border-box}[hidden]{display:none!important}.layout{display:grid;gap:1rem;padding:clamp(.75rem,2cqi,1.5rem);max-inline-size:72rem;margin-inline:auto}.viewport{position:relative;block-size:clamp(18rem,65svh,42rem);background:#10232b;border-radius:1rem;overflow:hidden;touch-action:none;outline-offset:4px}.viewport>canvas{display:block;inline-size:100%;block-size:100%}.viewport>p,.viewport>button{position:absolute;inset-inline:1rem;inset-block-start:35%;background:Canvas;color:CanvasText;padding:1rem}.viewport>p:empty{display:none}.viewport>button{inset-block-start:60%}.viewport>output{position:absolute;inset:0 auto auto 0;background:#000c;color:white;font:12px monospace;padding:.25rem;pointer-events:none}.actions,.pad{display:flex;gap:.5rem;flex-wrap:wrap}.pad{margin-block-start:1rem}.pad[hidden]{display:none}button,select,summary{font:inherit;min-block-size:44px;padding:.55rem .8rem}button,select{border:1px solid currentColor;border-radius:.45rem;color:inherit;background:var(--game-surface,Canvas)}button{cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible,.viewport:focus-visible{outline:3px solid var(--game-accent,currentColor);outline-offset:3px}h2{margin:0;font-size:clamp(1.4rem,4cqi,2rem)}.status{font-variant-numeric:tabular-nums}fieldset{border:0;padding:0;margin-block:1rem}label{display:flex;align-items:center;gap:.5rem;min-block-size:44px}input{inline-size:1.25rem;block-size:1.25rem}summary{cursor:pointer}.pad button{flex:1;touch-action:none;user-select:none}.help{max-inline-size:65ch}@container(width>=52rem){.layout{grid-template-columns:minmax(14rem,.7fr) minmax(0,1.5fr);align-items:start}}`;
export function mountArcade<View extends ArcadeView>(
  slot: HTMLElement,
  anySession: AnyGameSession,
  platform: PlatformApi,
  o: ArcadeGameOptions<View>,
) {
  const session = anySession as unknown as FixedStepRunner<
    Json,
    View,
    {
      type: string;
    }
  >;
  const host = document.createElement('div'),
    root = host.attachShadow({ mode: 'open' }),
    sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML =
    '<div class="layout"><div class="controls"></div><section><div class="viewport" tabindex="0" role="group" aria-roledescription="game board"></div><div class="pad"></div><p class="help"></p></section></div>';
  slot.append(host);
  const viewport = root.querySelector<HTMLElement>('.viewport')!,
    pad = root.querySelector<HTMLElement>('.pad')!;
  viewport.setAttribute('aria-label', o.title);
  root.querySelector('.help')!.textContent = o.help;
  const controls = new ArcadePanel();
  const records = createRecords(platform.storage, o.gameId, o.simulation),
    listeners = new Set<(hud: Hud) => void>();
  let best: BestRun = { score: 0, replay: null },
    drawing: ArcadeDrawing<View> | null = null,
    ghost: ReturnType<typeof createGhost> = null,
    disposed = false,
    loaded = false,
    resuming = false,
    lastTick = -1,
    lastPhase = 'ready',
    lastPace: Pace = session.get().view.pace,
    lastHud = '',
    padShown = o.gameId === 'tower-stacker' || matchMedia('(pointer:coarse)').matches,
    tone = false,
    autoFire = o.gesture === 'drag' && matchMedia('(pointer:coarse)').matches,
    graphics: 'auto' | 'low' | 'medium' | 'high' = 'auto';
  const send = (input: Json): void => session.dispatch({ kind: 'input', input });
  const announce = (text: string): void => platform.announce(text, 'polite');
  const pause = bindPause({
    pause: () => {
      for (const action of ['left', 'right', 'up', 'main'] as const)
        for (const input of o.action(action, false, session.get().view)) send(input);
      if (o.drag !== undefined) send(o.drag(0, 0));
      session.dispatch({ kind: 'pause' });
    },
    resume: () => {
      session.dispatch({ kind: 'resume' });
      if (o.gesture === 'drag') send({ type: 'fire', on: autoFire });
    },
    announce,
    changed: (value) => {
      resuming = value;
      publish();
    },
  });
  const publish = (): void => {
    if (disposed) return;
    const snapshot = session.get(),
      v = snapshot.view;
    const hud: Hud = {
      title: o.title,
      status: resuming ? 'Resuming in one second.' : snapshot.paused ? 'Paused' : o.status(v),
      phase: v.phase,
      paused: snapshot.paused,
      resuming,
      pace: v.pace,
      daily: v.daily,
      best: Math.max(best.score, o.score(v)),
      race: o.ghost === true && best.replay !== null,
      pad: padShown,
      tone,
      autoFire,
      graphics,
      loaded,
      alignment: o.alignment === true,
      shooter: o.gesture === 'drag',
    };
    const key = JSON.stringify(hud);
    if (key !== lastHud) {
      lastHud = key;
      for (const listener of listeners) listener(hud);
    }
    pad.hidden = !padShown && !(o.gesture === 'drag' && !autoFire);
    if (drawing !== null) {
      const g = ghost?.advance(snapshot.tick) as View | undefined;
      drawing.draw(v, session.alpha(), g ?? null);
    }
  };
  const chooseBest = async (pace: Pace): Promise<void> => {
    const found = await records.best(pace);
    if (!disposed && session.get().view.pace === pace) {
      best = found;
      publish();
    }
  };
  const emit = (action: InputAction, on: boolean): void => {
    if (disposed || !loaded || drawing === null || drawing.available === false) return;
    const snap = session.get();
    if (action === 'auxiliary') {
      if (on && o.gesture === 'drag') {
        autoFire = !autoFire;
        send({ type: 'fire', on: autoFire });
        announce(`Automatic fire ${autoFire ? 'on' : 'off'}.`);
        publish();
      }
      return;
    }
    if (action === 'pause') {
      if (on) {
        if (snap.paused) pause.resume();
        else pause.pause();
      }
      return;
    }
    if (snap.paused) {
      if (snap.view.phase === 'ready') session.dispatch({ kind: 'resume' });
      else return;
    }
    if (o.gesture === 'drag' && action === 'main' && snap.view.phase !== 'ready' && autoFire) {
      send({ type: 'fire', on: true });
      return;
    }
    for (const input of o.action(action, on, snap.view)) send(input);
  };
  const stops: (() => void)[] = [];
  const perform = (a: PanelAction): void => {
    const snap = session.get(),
      v = snap.view;
    switch (a.type) {
      case 'primary':
        if (v.phase === 'ready') {
          emit('main', true);
          emit('main', false);
        } else if (snap.paused) pause.resume();
        else pause.pause();
        break;
      case 'pace':
        if (v.phase === 'ready' && !v.daily) {
          send({ type: 'pace', pace: a.pace });
          best = { score: 0, replay: null };
          ghost = null;
          void records.remember(a.pace).catch(() => {});
          void chooseBest(a.pace);
        }
        break;
      case 'race':
        if (v.phase === 'ready' && !v.daily && best.replay !== null) {
          ghost = createGhost(o.simulation, best.replay);
          const initial = ghost?.advance(0) as View | undefined;
          if (initial !== undefined) {
            send({ type: 'course', course: initial.course });
            emit('main', true);
          }
        }
        break;
      case 'graphics':
        graphics = a.value;
        drawing?.graphics(graphics);
        void platform.storage.set('arcade.graphics', graphics).catch(() => {});
        break;
      case 'pad':
        padShown = !padShown;
        void platform.storage.set('arcade.pad', padShown).catch(() => {});
        break;
      case 'tone':
        tone = !tone;
        break;
      case 'fire':
        autoFire = !autoFire;
        send({ type: 'fire', on: autoFire });
        break;
    }
    publish();
  };
  controls.drivers = panelDrivers((emit) => {
    listeners.add(emit);
    lastHud = '';
    publish();
    return () => listeners.delete(emit);
  }, perform);
  root.querySelector('.controls')!.append(controls);
  for (const [action, label] of [
    ['left', 'Left'],
    ['up', 'Forward / Thrust'],
    ['right', 'Right'],
    ['down', 'Back'],
    ['main', o.gameId === 'tower-stacker' ? 'Drop' : o.gesture === 'drag' ? 'Fire' : 'Hop'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    pad.append(button);
    stops.push(bindHold(button, (on) => emit(action, on)));
    button.addEventListener('click', (e) => {
      if (e.detail === 0) {
        emit(action, true);
        emit(action, false);
      }
    });
  }
  stops.push(
    bindInput({
      surface: viewport,
      keys: {
        arrowup: 'up',
        arrowdown: 'down',
        arrowleft: 'left',
        arrowright: 'right',
        w: 'up',
        s: 'down',
        a: 'left',
        d: 'right',
        ' ': 'main',
        enter: 'main',
        f: 'auxiliary',
        p: 'pause',
        escape: 'pause',
      },
      shortcuts: () => platform.preferences.get().singleKeyShortcuts,
      emit,
      announce,
      gesture: o.gesture,
      drag: (x, y) => {
        if (loaded && !session.get().paused && o.drag !== undefined) send(o.drag(x, y));
      },
    }),
  );
  stops.push(
    session.subscribe((snap) => {
      const v = snap.view;
      if (v.pace !== lastPace) {
        lastPace = v.pace;
        void chooseBest(v.pace);
      }
      if (lastPhase === 'ready' && v.phase !== 'ready') {
        viewport.focus({ preventScroll: true });
        if (autoFire) send({ type: 'fire', on: true });
      }
      if (v.phase === 'over' && lastPhase !== 'over' && !v.daily) {
        void records
          .record(v.pace, o.score(v), o.ghost === true ? session.replay() : null)
          .then(() => chooseBest(v.pace))
          .catch(() => {});
        announce(o.status(v));
      }
      lastPhase = v.phase;
      if (lastTick !== snap.tick) {
        lastTick = snap.tick;
        for (const e of snap.events) {
          const cue: SoundCue | undefined = (
            {
              began: 'start',
              hopped: 'move',
              signal: 'warning',
              milestone: 'level',
              placed: 'hit',
              regrew: 'power',
              missed: 'lose',
              wave: 'level',
              lifeLost: 'life',
              extraLife: 'life',
              droneIn: 'warning',
              ended: 'lose',
            } as Record<string, SoundCue>
          )[e.type];
          if (cue !== undefined) platform.audio?.play(cue);
          if (o.alignment && tone && e.type === 'aligned') platform.audio?.play('tick');
          const line = o.eventLine?.(e as Json, v);
          if (line !== undefined && line !== null) announce(line);
          else if (['wave', 'lifeLost', 'extraLife', 'droneIn', 'regrew', 'milestone', 'signal'].includes(e.type))
            announce(o.status(v));
        }
      }
      publish();
    }),
  );
  void Promise.all([
    records.pace(),
    platform.storage.get('arcade.pad').catch(() => null),
    platform.storage.get('arcade.graphics').catch(() => null),
  ])
    .then(async ([pace, padValue, quality]) => {
      if (disposed) return;
      if (typeof padValue === 'boolean') padShown = padValue;
      if (['auto', 'low', 'medium', 'high'].includes(String(quality))) graphics = quality as typeof graphics;
      const v = session.get().view;
      if (!v.daily && v.phase === 'ready') send({ type: 'pace', pace });
      await chooseBest(v.daily ? 'standard' : pace);
      if (disposed) return;
      drawing = await o.render(viewport, pause.pause, announce);
      if (disposed) {
        drawing.dispose();
        return;
      }
      drawing.graphics(graphics);
      loaded = true;
      publish();
    })
    .catch(() => {
      if (!disposed) announce('Game settings could not be loaded.');
    });
  if (session.get().view.phase !== 'ready' && session.get().view.phase !== 'over') pause.pause();
  publish();
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const stop of stops) stop();
      pause.dispose();
      drawing?.dispose();
      host.remove();
    },
  };
}
