// The common solitaire frame inside a game's canvas. Games supply pure adapters; this
// component owns only card-table controls, preferences, records and their effect drivers.
import {
  child,
  command,
  css,
  define,
  defineDriver,
  focus,
  html,
  intentsOf,
  nothing,
  subscription,
  type ChildValue,
  type Command,
} from '@gyral/core';
import {
  isJson,
  type AnyGameSession,
  type Json,
  type Mounted,
  type PlatformApi,
  type Preferences,
  type Validator,
} from '@joystyk/contracts';
import { CardTable } from './table.ts';
import { DEFAULT_OPTIONS, type Back, type TableLayout, type TableOptions } from './layout.ts';
import type { TableOut } from './controller.ts';

export type SetupField = {
  readonly name: string;
  readonly label: string;
  readonly value: string;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
};
export type SolitaireData = {
  readonly title: string;
  readonly theme: 'noon' | 'dawn' | 'dusk';
  readonly back: Back;
  readonly layout: TableLayout;
  readonly status: string;
  readonly line: string;
  readonly meters: readonly { readonly label: string; readonly value: string }[];
  readonly fields: readonly SetupField[];
  readonly setupAllowed: boolean;
  readonly actions: readonly { readonly label: string; readonly command: Json; readonly disabled: boolean }[];
  readonly scorecard?: readonly {
    readonly hole: number;
    readonly strokes: number | null;
    readonly total: number | null;
    readonly par: number;
    readonly cleared: boolean;
  }[];
  readonly recordGroup: string;
  readonly moves: number;
  readonly score: number;
  readonly bestRun: number;
  readonly cleared: number;
  readonly keys: string;
  readonly history?: readonly string[];
  readonly round?: { readonly strokes: number; readonly bestHole: number; readonly par: number };
};
export type SolitaireAdapter<V, E> = {
  readonly view: Validator<V>;
  readonly event: Validator<E>;
  readonly describe: (view: V, events: readonly E[], revision: number) => SolitaireData;
  readonly table: (view: V, out: TableOut) => Json | null;
  readonly shortcut: (view: V, key: string) => Json | null;
  readonly setup: (view: V, values: Readonly<Record<string, string>>) => Json | null;
  /** Optional worker validation/certification before a setup command is sent. */
  readonly prepareSetup?: (command: Json) => Promise<Json>;
  readonly dispose?: () => void;
};
type Snapshot = {
  readonly data: SolitaireData;
  readonly revision: number;
  readonly canUndo: boolean;
  readonly result: string | null;
  readonly summary: string;
  readonly notice: string;
  readonly elapsedMs: number;
  readonly undosUsed: number;
  readonly assisted: boolean;
  readonly paused: boolean;
};
export type RecordRow = {
  readonly played: number;
  readonly won: number;
  readonly bestScore: number | null;
  readonly fewestMoves: number | null;
  readonly bestMs: number | null;
  readonly bestRun: number;
  readonly cleared: number;
  readonly cleanWins: number;
  readonly streak: number;
  readonly longestStreak: number;
  readonly completed: number;
  readonly totalStrokes: number;
  readonly bestRound: number | null;
  readonly bestHole: number | null;
  readonly underPar: number;
};
type Records = Readonly<Record<string, RecordRow>>;
const EMPTY_ROW: RecordRow = {
  played: 0,
  won: 0,
  bestScore: null,
  fewestMoves: null,
  bestMs: null,
  bestRun: 0,
  cleared: 0,
  cleanWins: 0,
  streak: 0,
  longestStreak: 0,
  completed: 0,
  totalStrokes: 0,
  bestRound: null,
  bestHole: null,
  underPar: 0,
};
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const recordSchema: Validator<Records> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (v) => {
      if (!record(v)) return { issues: [{ message: 'Expected solitaire records.' }] };
      const rows: Record<string, RecordRow> = {};
      for (const [key, raw] of Object.entries(v)) {
        if (
          !record(raw) ||
          ![
            'played',
            'won',
            'bestRun',
            'cleared',
            'cleanWins',
            'streak',
            'longestStreak',
            'completed',
            'underPar',
          ].every((field) => count(raw[field])) ||
          typeof raw['totalStrokes'] !== 'number' ||
          !Number.isFinite(raw['totalStrokes']) ||
          !['bestScore', 'fewestMoves', 'bestMs', 'bestRound', 'bestHole'].every(
            (field) => raw[field] === null || (typeof raw[field] === 'number' && Number.isFinite(raw[field])),
          )
        )
          return { issues: [{ message: 'Invalid solitaire record.' }] };
        rows[key] = raw as RecordRow;
      }
      return { value: rows };
    },
  },
};
export const decode = <T>(schema: Validator<T>, raw: unknown): T | null => {
  const result = schema['~standard'].validate(raw);
  return result instanceof Promise || result.issues !== undefined ? null : result.value;
};
type Meta = {
  readonly revision: number;
  readonly result: string | null;
  readonly summary: string;
  readonly notice: string;
  readonly elapsedMs: number;
  readonly undosUsed: number;
  readonly assisted: boolean;
  readonly canUndo: boolean;
  readonly paused: boolean;
};
const metaSchema: Validator<Meta> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) => {
      if (!record(raw) || !record(raw['meta']) || !count(raw['meta']['revision']))
        return { issues: [{ message: 'Invalid solitaire snapshot.' }] };
      const m = raw['meta'];
      const outcome = m['outcome'];
      const notice = m['notice'];
      if (
        outcome !== null &&
        (!record(outcome) ||
          typeof outcome['result'] !== 'string' ||
          !['won', 'lost', 'draw', 'completed', 'abandoned'].includes(outcome['result']) ||
          typeof outcome['summary'] !== 'string')
      )
        return { issues: [{ message: 'Invalid result.' }] };
      return {
        value: {
          revision: m['revision'] as number,
          result: record(outcome) ? String(outcome['result']) : null,
          summary: record(outcome) ? String(outcome['summary']) : '',
          notice: record(notice) && typeof notice['message'] === 'string' ? notice['message'] : '',
          elapsedMs: count(raw['elapsedMs'])
            ? raw['elapsedMs']
            : record(outcome) && count(outcome['elapsedMs'])
              ? outcome['elapsedMs']
              : 0,
          undosUsed: count(m['undosUsed'])
            ? m['undosUsed']
            : record(outcome) && count(outcome['undosUsed'])
              ? outcome['undosUsed']
              : 0,
          assisted: record(outcome) && Array.isArray(outcome['assists']) && outcome['assists'].length > 0,
          canUndo: record(raw['undo']) && raw['undo']['available'] === true,
          paused: raw['paused'] === true,
        },
      };
    },
  },
};
type Action =
  | { readonly kind: 'command'; readonly command: Json }
  | { readonly kind: 'undo' | 'resign' }
  | { readonly kind: 'table'; readonly out: TableOut }
  | { readonly kind: 'key'; readonly key: string }
  | { readonly kind: 'setup'; readonly values: Readonly<Record<string, string>> };
type State = {
  readonly snapshot: Snapshot | null;
  readonly options: TableOptions;
  readonly dark: boolean;
  readonly message: string;
  readonly dialog: 'none' | 'keys' | 'confirm';
  readonly elapsedMs: number;
  readonly records: Records;
  readonly sound: boolean;
};
type Msg =
  | { readonly _tag: 'Snapshot'; readonly snapshot: Snapshot }
  | { readonly _tag: 'Preferences'; readonly p: Preferences }
  | { readonly _tag: 'Records'; readonly records: Records }
  | { readonly _tag: 'Tick'; readonly ms: number }
  | { readonly _tag: 'Action'; readonly action: Action }
  | { readonly _tag: 'Table'; readonly out: TableOut }
  | { readonly _tag: 'Key'; readonly key: string; readonly ctrl: boolean }
  | { readonly _tag: 'Dialog'; readonly dialog: State['dialog'] }
  | { readonly _tag: 'Color'; readonly on: boolean }
  | { readonly _tag: 'Sound'; readonly on: boolean }
  | { readonly _tag: 'Message'; readonly message: string };
const feed = defineDriver<void, Snapshot, never>('solitaire-session');
const prefs = defineDriver<void, Preferences, never>('solitaire-preferences');
const timer = defineDriver<void, number, never>('solitaire-timer');
const sending = defineDriver<Action, string>('solitaire-send');
const speaking = defineDriver<string, void>('solitaire-speak');
const reading = defineDriver<string, Json | null>('solitaire-read');
const writing = defineDriver<Records, void>('solitaire-write');
const color = defineDriver<boolean, void>('solitaire-color');
const sounding = defineDriver<'card' | 'clear', void>('solitaire-sound');
const jsonSchema: Validator<Json> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) => (isJson(raw) ? { value: raw } : { issues: [{ message: 'Expected JSON.' }] }),
  },
};
const booleanSchema: Validator<boolean> = {
  '~standard': {
    version: 1,
    vendor: 'joystyk',
    validate: (raw) => (typeof raw === 'boolean' ? { value: raw } : { issues: [{ message: 'Expected a boolean.' }] }),
  },
};
const say = (line: string) => command(speaking, line);
const send = (action: Action): Command<Msg> =>
  command(sending, action, {
    concurrency: 'queue',
    onSuccess: (message) => (message === '' ? undefined : { _tag: 'Message', message }),
    onFailure: () => ({ _tag: 'Message', message: 'The deal could not be prepared. Try again.' }),
  });
const i = intentsOf<typeof SolitaireBoard>();
const timeText = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
export const SolitaireBoard = define<State, Msg>()('jy-solitaire-board', {
  init: () => [
    {
      snapshot: null,
      options: DEFAULT_OPTIONS,
      dark: true,
      message: '',
      dialog: 'none',
      elapsedMs: 0,
      records: {},
      sound: false,
    },
    [
      command(reading, 'records', { onSuccess: (v) => ({ _tag: 'Records', records: decode(recordSchema, v) ?? {} }) }),
      command(reading, 'fourColor', {
        key: 'four-color',
        onSuccess: (v) => ({ _tag: 'Color', on: decode(booleanSchema, v) ?? false }),
      }),
    ],
  ],
  subscriptions: () => [
    command(feed, undefined, { onSuccess: (snapshot) => ({ _tag: 'Snapshot', snapshot }) }),
    command(prefs, undefined, { onSuccess: (p) => ({ _tag: 'Preferences', p }) }),
    command(timer, undefined, { onSuccess: (ms) => ({ _tag: 'Tick', ms }) }),
  ],
  intent: {
    Table: child(CardTable, (out) => ({ _tag: 'Table', out })),
    Action: ({ value }) => {
      if (value === undefined) return undefined;
      try {
        const c = decode(jsonSchema, JSON.parse(value));
        return c === null ? undefined : { _tag: 'Action', action: { kind: 'command', command: c } };
      } catch {
        return undefined;
      }
    },
    Undo: () => ({ _tag: 'Action', action: { kind: 'undo' } }),
    Hint: () => ({ _tag: 'Action', action: { kind: 'command', command: { type: 'hint' } } }),
    New: () => ({ _tag: 'Dialog', dialog: 'confirm' }),
    Keys: () => ({ _tag: 'Dialog', dialog: 'keys' }),
    Cancel: ({ key, event }) =>
      event instanceof KeyboardEvent && key !== 'Escape' ? undefined : { _tag: 'Dialog', dialog: 'none' },
    Confirm: () => ({ _tag: 'Action', action: { kind: 'resign' } }),
    Color: ({ checked }) => ({ _tag: 'Color', on: checked === true }),
    Sound: ({ checked }) => ({ _tag: 'Sound', on: checked === true }),
    Setup: ({ formData }) =>
      formData === undefined
        ? undefined
        : {
            _tag: 'Action',
            action: {
              kind: 'setup',
              values: Object.fromEntries(Array.from(formData.entries(), ([key, v]) => [key, String(v)])),
            },
          },
    Key: ({ key, event }) => {
      if (
        !(event instanceof KeyboardEvent) ||
        event.defaultPrevented ||
        event.repeat ||
        key === undefined ||
        event.altKey ||
        (event.target instanceof Element && event.target.closest('input,select,textarea,dialog') !== null)
      )
        return undefined;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && key.toLowerCase() !== 'z') return undefined;
      if (['u', 'd', 'h', 'n', 't', 'w', '?'].includes(key.toLowerCase()) || ctrl) event.preventDefault();
      return { _tag: 'Key', key, ctrl };
    },
  },
  update: {
    Snapshot: (s, { snapshot: next }) => {
      const changed = s.snapshot?.revision !== next.revision;
      const commands: Command<Msg>[] = [];
      if (changed && next.data.line !== '') commands.push(say(next.data.line));
      if (changed && s.snapshot !== null && s.sound && next.data.line !== '')
        commands.push(
          command(
            sounding,
            next.result === 'won' || (next.data.round !== undefined && next.data.round.bestHole < 0) ? 'clear' : 'card',
          ),
        );
      if (s.snapshot === null) commands.push(say(next.data.status));
      if (next.notice !== '' && next.notice !== s.snapshot?.notice) commands.push(say(next.notice));
      if (
        next.data.actions.some((a) => a.label === 'Next hole' || a.label === 'Finish round') &&
        !s.snapshot?.data.actions.some((a) => a.label === 'Next hole' || a.label === 'Finish round')
      )
        commands.push(focus('.advance'));
      let records = s.records;
      if (s.snapshot !== null && s.snapshot.result === null && next.result !== null) {
        const old = records[next.data.recordGroup] ?? EMPTY_ROW;
        const won = next.result === 'won';
        const streak = won ? old.streak + 1 : 0;
        const round = next.result === 'completed' ? next.data.round : undefined;
        const row: RecordRow = {
          played: old.played + 1,
          won: old.won + Number(won),
          bestScore: Math.max(old.bestScore ?? -Infinity, next.data.score),
          fewestMoves: won ? Math.min(old.fewestMoves ?? Infinity, next.data.moves) : old.fewestMoves,
          bestMs: won ? Math.min(old.bestMs ?? Infinity, next.elapsedMs) : old.bestMs,
          bestRun: Math.max(old.bestRun, next.data.bestRun),
          cleared: old.cleared + next.data.cleared,
          cleanWins: old.cleanWins + Number(won && next.undosUsed === 0 && !next.assisted),
          streak,
          longestStreak: Math.max(old.longestStreak, streak),
          completed: old.completed + Number(round !== undefined),
          totalStrokes: old.totalStrokes + (round?.strokes ?? 0),
          bestRound: round === undefined ? old.bestRound : Math.min(old.bestRound ?? Infinity, round.strokes),
          bestHole: round === undefined ? old.bestHole : Math.min(old.bestHole ?? Infinity, round.bestHole),
          underPar: old.underPar + Number(round !== undefined && round.strokes <= round.par),
        };
        records = { ...records, [next.data.recordGroup]: row };
        commands.push(command(writing, records));
        commands.push(say(next.summary));
      }
      return [
        {
          ...s,
          snapshot: next,
          records,
          options: { ...s.options, back: next.data.back },
          message: next.notice || (changed ? next.data.line : s.message),
          dialog: next.result !== null ? 'none' : s.dialog,
        },
        commands,
      ];
    },
    Preferences: (s, { p }) => ({
      ...s,
      dark: p.colorScheme === 'dark',
      options: { ...s.options, calm: p.reducedMotion, singleKeys: p.singleKeyShortcuts },
    }),
    Records: (s, m) => ({ ...s, records: m.records }),
    Tick: (s, m) => ({ ...s, elapsedMs: m.ms }),
    Message: (s, m) => [{ ...s, message: m.message }, [say(m.message)]],
    Table: (s, { out }) =>
      out._tag === 'Announce'
        ? [s, [say(out.message)]]
        : s.snapshot?.result === null && !s.snapshot.paused
          ? [s, [send({ kind: 'table', out })]]
          : s,
    Action: (s, m) =>
      s.snapshot?.result === null && !s.snapshot.paused ? [{ ...s, dialog: 'none' }, [send(m.action)]] : s,
    Dialog: (s, m) => [
      { ...s, dialog: m.dialog },
      m.dialog === 'none' ? [focus('.actions button')] : [focus('.panel button')],
    ],
    Color: (s, m) => [{ ...s, options: { ...s.options, fourColor: m.on } }, [command(color, m.on)]],
    Sound: (s, m) => ({ ...s, sound: m.on }),
    Key: (s, m) => {
      if (m.key === '?') return s.options.singleKeys ? [{ ...s, dialog: 'keys' }, [focus('.panel button')]] : s;
      if ((m.ctrl && m.key.toLowerCase() === 'z') || (s.options.singleKeys && m.key.toLowerCase() === 'u'))
        return s.snapshot?.canUndo ? [s, [send({ kind: 'undo' })]] : s;
      return s.options.singleKeys && s.snapshot?.result === null
        ? [s, [send({ kind: 'key', key: m.key.toLowerCase() })]]
        : s;
    },
  },
  view: (s): ChildValue => {
    const snap = s.snapshot;
    if (snap === null) return html`<p>Dealing the cards…</p>`;
    const d = snap.data;
    const records = s.records[d.recordGroup] ?? EMPTY_ROW;
    return html`<section class="slate ${d.theme} ${s.dark ? 'dark' : 'light'}" aria-label=${d.title} data-intent-keydown=${i.Key}>
      <div ?inert=${s.dialog !== 'none'}>
        <header><h2>${d.title}</h2><dl>${d.meters.map((meter) => html`<div><dt>${meter.label}</dt><dd>${meter.value}</dd></div>`)}<div><dt>Time</dt><dd>${timeText(snap.result === null ? Math.max(s.elapsedMs, snap.elapsedMs) : snap.elapsedMs)}</dd></div></dl><p>${snap.summary || d.status}</p></header>
        <jy-card-table .layout=${d.layout} .options=${s.options} data-intent=${i.Table}></jy-card-table>
        <p class="message" aria-hidden="true">${s.message}</p>
        <div class="actions"><button type="button" ?disabled=${snap.result !== null} data-intent=${i.New}>New game</button><button type="button" ?disabled=${!snap.canUndo} data-intent=${i.Undo}>Undo</button><button type="button" ?disabled=${snap.result !== null} data-intent=${i.Hint}>Hint</button>${d.actions.map((a) => html`<button class=${a.label === 'Next hole' || a.label === 'Finish round' ? 'advance' : ''} type="button" ?disabled=${a.disabled || snap.result !== null} value=${JSON.stringify(a.command)} data-intent=${i.Action}>${a.label}</button>`)}<button type="button" aria-haspopup="dialog" data-intent=${i.Keys}>Keys</button></div>
        ${d.scorecard === undefined ? nothing : html`<div class="scorecard"><table><caption>Round scorecard</caption><thead><tr><th scope="col">Hole</th><th scope="col">Strokes</th><th scope="col">Running total</th><th scope="col">Par</th></tr></thead><tbody>${d.scorecard.map((row) => html`<tr><th scope="row">${row.hole}</th><td>${row.strokes ?? '–'} ${row.cleared ? '⚑ Cleared' : ''}</td><td>${row.total ?? '–'}</td><td>${row.par}</td></tr>`)}</tbody></table></div>`}
        <details><summary>Settings and deal number</summary><form data-intent=${i.Setup} aria-label="Settings"><fieldset ?disabled=${!d.setupAllowed || snap.result !== null}><legend>Choose before the first move</legend>${d.fields.map((field) => html`<label>${field.label}${field.choices === undefined ? html`<input name=${field.name} type="number" min="1" max="1000000" value=${field.value} required />` : html`<select name=${field.name}>${field.choices.map((choice) => html`<option value=${choice.value} ?selected=${field.value === choice.value}>${choice.label}</option>`)}</select>`}</label>`)}<button type="submit">Deal</button></fieldset></form><label><input type="checkbox" ?checked=${s.options.fourColor} data-intent=${i.Color} /> Four-color deck (blue diamonds, green clubs)</label><label><input type="checkbox" ?checked=${s.sound} data-intent=${i.Sound} /> Soft card sounds</label></details>
        ${d.history === undefined ? nothing : html`<details><summary>Removed cards</summary><ul>${d.history.map((card) => html`<li>${card}</li>`)}</ul></details>`}
        <details><summary>Records on this device</summary><dl>${d.round === undefined ? nothing : html`<div><dt>Rounds completed</dt><dd>${records.completed}</dd></div><div><dt>Best round</dt><dd>${records.bestRound ?? '–'}</dd></div><div><dt>Average round</dt><dd>${records.completed === 0 ? '–' : (records.totalStrokes / records.completed).toFixed(1)}</dd></div><div><dt>Best hole</dt><dd>${records.bestHole ?? '–'}</dd></div><div><dt>Rounds at or under par</dt><dd>${records.underPar}</dd></div>`}<div><dt>Played</dt><dd>${records.played}</dd></div><div><dt>Won</dt><dd>${records.won}</dd></div><div><dt>Best score</dt><dd>${records.bestScore ?? '–'}</dd></div><div><dt>Fewest moves in a win</dt><dd>${records.fewestMoves ?? '–'}</dd></div><div><dt>Best time</dt><dd>${records.bestMs === null ? '–' : timeText(records.bestMs)}</dd></div><div><dt>Best run</dt><dd>${records.bestRun}</dd></div><div><dt>Cleared</dt><dd>${records.cleared}</dd></div><div><dt>Wins without help</dt><dd>${records.cleanWins}</dd></div><div><dt>Win streak (best)</dt><dd>${records.streak} (${records.longestStreak})</dd></div></dl></details>
      </div>
      ${s.dialog === 'none' ? nothing : html`<dialog ?modal=${true} class="panel" aria-label=${s.dialog === 'keys' ? 'Keyboard controls' : 'End this deal?'} data-intent-keydown=${i.Cancel} data-intent-close=${i.Cancel}><h3>${s.dialog === 'keys' ? 'Keyboard controls' : 'End this deal?'}</h3><p>${s.dialog === 'keys' ? `${d.keys} Single-key shortcuts ${s.options.singleKeys ? 'are on' : 'are off'}.` : 'This game ends now and counts as played. Play again offers a fresh deal.'}</p>${s.dialog === 'confirm' ? html`<button type="button" data-intent=${i.Confirm}>End and start again</button>` : nothing}<button type="button" data-intent=${i.Cancel}>${s.dialog === 'keys' ? 'Close' : 'Keep playing'}</button></dialog>`}
    </section>`;
  },
  styles: css`@layer components {
    :host { display:block; container-type:inline-size; font: 1rem/1.5 system-ui; }
    .slate { --ink:oklch(23% 0.03 70); --paper:oklch(93% 0.04 80); color:var(--ink); background:var(--paper); padding:clamp(.25rem,1cqi,1rem); border-radius:1rem; }
    .noon { --paper:oklch(94% 0.04 80); --back-a:oklch(45% 0.1 65); --back-b:oklch(72% 0.08 80); --back-c:oklch(93% 0.03 85); }
    .dawn { --paper:oklch(94% 0.018 245); --back-a:oklch(38% 0.08 255); --back-b:oklch(68% 0.08 250); --back-c:oklch(88% 0.08 80); }
    .dusk { --paper:oklch(91% 0.03 110); --back-a:oklch(38% 0.035 170); --back-b:oklch(65% 0.05 130); --back-c:oklch(85% 0.07 80); }
    .dark { --paper:oklch(24% 0.035 170); --ink:oklch(95% 0.012 110); }
    .noon.dark { --paper:oklch(25% 0.035 65); } .dawn.dark { --paper:oklch(25% 0.04 260); }
    jy-card-table { --table-ink:var(--ink); --table-slot:color-mix(in oklch,var(--ink) 45%,transparent); --table-felt:var(--paper); --table-focus:oklch(68% 0.16 255); --table-target:oklch(55% 0.16 140); --table-hint:oklch(62% 0.15 45); }
    h2,p { margin-block:.35rem; } dl { display:flex; flex-wrap:wrap; gap:.4rem 1.25rem; margin-block:.4rem; } dt { font-size:.8rem; } dd { margin:0; font-variant-numeric:tabular-nums; font-weight:700; }
    button,input,select,summary { min-block-size:44px; } button,input,select { font:inherit; color:inherit; border:1px solid currentColor; border-radius:.4rem; background:var(--paper); padding:.35rem .6rem; } button { cursor:pointer; } button:disabled { opacity:.6; cursor:default; } :focus-visible { outline:3px solid var(--ink); outline-offset:3px; }
    .actions,fieldset { display:flex; flex-wrap:wrap; gap:.5rem; } label { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; } fieldset { border:0; margin:0; padding:.5rem 0; } legend { padding:0; } input[type=number] { inline-size:10ch; } input[type=checkbox] { min-inline-size:24px; }
    details { border-block-start:1px solid color-mix(in oklch,var(--ink) 35%,transparent); margin-block:.65rem; padding-block:.35rem; } summary { cursor:pointer; } .message { min-block-size:1.5em; } .scorecard { overflow:auto; } table { border-collapse:collapse; inline-size:100%; font-variant-numeric:tabular-nums; } th,td { padding:.35rem; border-block-end:1px solid currentColor; text-align:start; } caption { text-align:start; font-weight:700; }
    .panel { position:fixed; inset:0; margin:auto; max-inline-size:min(36rem,calc(100vi - 2rem)); border:2px solid var(--ink); border-radius:1rem; background:var(--paper); color:var(--ink); padding:1rem; box-shadow:0 0 0 100vmax oklch(0% 0 0 / .5); z-index:30; } .panel button { margin:.25rem; }
    @media (forced-colors:active) { .slate,.panel { background:Canvas; color:CanvasText; } button,input,select { border:1px solid ButtonText; } }
  }`,
});

export const mountSolitaire = <V, E>(
  slot: HTMLElement,
  session: AnyGameSession,
  platform: PlatformApi,
  adapter: SolitaireAdapter<V, E>,
): Mounted => {
  const board = new SolitaireBoard();
  let latest: V | null = null;
  let disposed = false;
  board.drivers = {
    'solitaire-session': subscription<Snapshot>('solitaire-session', (emit) =>
      session.subscribe((raw: unknown) => {
        const meta = decode(metaSchema, raw);
        if (meta === null || !record(raw)) return;
        const view = decode(adapter.view, raw['view']);
        if (view === null) return;
        const events: E[] = [];
        for (const beat of Array.isArray(raw['beats']) ? raw['beats'] : []) {
          const event = record(beat) ? decode(adapter.event, beat['event']) : null;
          if (event === null) return;
          events.push(event);
        }
        latest = view;
        emit({ ...meta, data: adapter.describe(view, events, meta.revision) });
      }),
    ),
    'solitaire-preferences': subscription<Preferences>('solitaire-preferences', (emit) => {
      emit(platform.preferences.get());
      return platform.preferences.subscribe(emit);
    }),
    'solitaire-timer': subscription<number>('solitaire-timer', (emit) => {
      const clock = session as AnyGameSession & { elapsedMs?: () => number };
      if (clock.elapsedMs === undefined) return () => {};
      const id = setInterval(() => emit(clock.elapsedMs!()), 250);
      return () => clearInterval(id);
    }),
    'solitaire-speak': defineDriver<string, void>({
      name: 'solitaire-speak',
      run: (line) => platform.announce(line, 'polite'),
    }),
    'solitaire-read': defineDriver<string, Json | null>({
      name: 'solitaire-read',
      run: (key) => platform.storage.get(key),
    }),
    'solitaire-write': defineDriver<Records, void>({
      name: 'solitaire-write',
      run: (rows) => platform.storage.set('records', rows),
    }),
    'solitaire-sound': defineDriver<'card' | 'clear', void>({
      name: 'solitaire-sound',
      run: (kind) => {
        if (!disposed) platform.audio?.play(kind);
      },
    }),
    'solitaire-color': defineDriver<boolean, void>({
      name: 'solitaire-color',
      run: (on) => platform.storage.set('fourColor', on),
    }),
    'solitaire-send': defineDriver<Action, string>({
      name: 'solitaire-send',
      run: async (a) => {
        if (latest === null || disposed) return '';
        if (a.kind === 'undo' || a.kind === 'resign') {
          (session.dispatch as (input: unknown) => void)({ kind: a.kind });
          return '';
        }
        if (a.kind === 'table' && a.out._tag === 'Announce') {
          platform.announce(a.out.message, 'polite');
          return '';
        }
        const c =
          a.kind === 'command'
            ? a.command
            : a.kind === 'table'
              ? adapter.table(latest, a.out)
              : a.kind === 'key'
                ? adapter.shortcut(latest, a.key)
                : a.kind === 'setup'
                  ? adapter.setup(latest, a.values)
                  : null;
        if (c === null) return a.kind === 'setup' ? 'Choose valid settings and a deal number from 1 to 1,000,000.' : '';
        const command = a.kind === 'setup' && adapter.prepareSetup !== undefined ? await adapter.prepareSetup(c) : c;
        if (!disposed) (session.dispatch as (input: unknown) => void)({ kind: 'command', command });
        return '';
      },
    }),
  };
  slot.append(board);
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      board.remove();
      adapter.dispose?.();
    },
  };
};

export { workerSetup } from './worker-setup.ts';
