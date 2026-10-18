// Tally's canvas: what a game's module looks like to the launcher. It draws into the slot it
// is given and nothing else, reads the theme tokens the frame hands the canvas, talks to the
// platform only through PlatformApi, and records what it saw in `tallyProbe` for tests.
import type { GameModule, GameSession, Json, Preferences, SeatId } from '@joystyk/contracts';
import type { LocalInput, LocalSnapshot } from '@joystyk/session';
import { tallyEngine, type TallyCommand, type TallyEvent, type TallyView } from './engine.ts';
import { tallyProbe } from './probe.ts';

type TallySession = GameSession<LocalSnapshot<TallyView, TallyEvent>, LocalInput<TallyCommand>>;

const STYLES = `
  :host { display: block; }
  section {
    display: grid;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: 0.75rem;
    background: var(--game-surface, Canvas);
    color: var(--game-ink, CanvasText);
    font: inherit;
  }
  h3 { margin: 0; color: var(--game-accent, currentColor); }
  p, ul { margin: 0; }
  .moves { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button {
    min-block-size: 2.75rem;
    padding-inline: 1rem;
    border: 2px solid var(--game-accent, currentColor);
    border-radius: 0.5rem;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .scores li { transition: color 300ms ease-out; }
  :host([data-reduced-motion]) .scores li { transition: none; }
`;

// The site's two-release test needs genuinely different lazy game bytes, rather
// than relying on incidental changes in the shell's shared dependency hashes.
declare const __JOYSTYK_RELEASE__: string;

const describeTurn = (view: TallyView, snapshot: LocalSnapshot<TallyView, TallyEvent>): string => {
  if (view.winner !== null) return `${view.names[view.winner] ?? 'Someone'} reached ${String(view.target)}.`;
  if (snapshot.meta.outcome !== null) return 'Game over.';
  return `${view.names[view.turn] ?? 'Someone'} to play.`;
};

export const tallyModule: GameModule<HTMLElement> = {
  engine: tallyEngine,
  migrations: [],
  mount(slot, anySession, platform) {
    // The launcher built this session from Tally's own engine, so its types are Tally's.
    const session = anySession as unknown as TallySession;
    tallyProbe.mounts += 1;

    const host = document.createElement('div');
    host.className = 'tally-board';
    host.dataset['fixtureRelease'] = typeof __JOYSTYK_RELEASE__ === 'string' ? __JOYSTYK_RELEASE__ : 'unversioned';
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `<section aria-labelledby="tally-title">
      <h3 id="tally-title"></h3>
      <ul class="scores"></ul>
      <p class="secret"></p>
      <p class="turn"></p>
      <div class="moves">
        <button type="button" data-amount="1">Add 1</button>
        <button type="button" data-amount="2">Add 2</button>
        <button type="button" data-hint>Hint</button>
        <button type="button" data-quit>Quit</button>
      </div>
    </section>`;
    slot.append(host);

    const q = <E extends Element>(selector: string): E => root.querySelector(selector) as E;
    let preferences = platform.preferences.get();
    let mySeat: SeatId | null = null;
    let canMove = false;

    const add = (amount: 1 | 2): void => {
      if (canMove) session.dispatch({ kind: 'command', command: { type: 'add', amount } });
    };

    const render = (snapshot: LocalSnapshot<TallyView, TallyEvent>): void => {
      const view = snapshot.view;
      mySeat = snapshot.meta.seat;
      canMove =
        mySeat !== null && snapshot.pending.includes(mySeat) && snapshot.meta.outcome === null && !snapshot.paused;
      q('h3').textContent = `First to ${String(view.target)}`;
      const scores = q('.scores');
      scores.replaceChildren(
        ...view.scores.map((score, seat) => {
          const li = document.createElement('li');
          li.textContent = `${view.names[seat] ?? `Seat ${String(seat + 1)}`}: ${String(score)}`;
          return li;
        }),
      );
      q('.secret').textContent = view.secret === null ? '' : `Your secret number is ${String(view.secret)}.`;
      q('.turn').textContent = describeTurn(view, snapshot);
      for (const button of root.querySelectorAll<HTMLButtonElement>('[data-amount], [data-hint]'))
        button.disabled = !canMove;
      for (const beat of snapshot.beats) {
        if (beat.event.type === 'added') {
          platform.announce(`${view.names[beat.event.seat] ?? 'Someone'} adds ${String(beat.event.amount)}.`, 'polite');
        }
      }
    };

    const applyPreferences = (next: Preferences): void => {
      preferences = next;
      tallyProbe.preferences.push(next);
      host.toggleAttribute('data-reduced-motion', next.reducedMotion);
    };
    applyPreferences(preferences);

    const onClick = (event: Event): void => {
      const button = (event.target as Element).closest('button');
      if (button === null) return;
      if (button.dataset['amount'] !== undefined) add(button.dataset['amount'] === '2' ? 2 : 1);
      else if (button.hasAttribute('data-hint')) session.dispatch({ kind: 'command', command: { type: 'hint' } });
      else if (button.hasAttribute('data-quit')) platform.requestExit();
    };
    const onKey = (event: KeyboardEvent): void => {
      // Single-key shortcuts honor the player's preference (WCAG 2.1.4).
      if (!preferences.singleKeyShortcuts || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '1' || event.key === '2') add(event.key === '2' ? 2 : 1);
    };
    root.addEventListener('click', onClick);
    host.addEventListener('keydown', onKey);
    const stopSession = session.subscribe(render);
    const stopPreferences = platform.preferences.subscribe(applyPreferences);

    void platform.storage.get('plays').then(async (stored: Json | null) => {
      const plays = (typeof stored === 'number' ? stored : 0) + 1;
      tallyProbe.plays.push(plays);
      await platform.storage.set('plays', plays);
    });

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        tallyProbe.disposals += 1;
        stopSession();
        stopPreferences();
        root.removeEventListener('click', onClick);
        host.removeEventListener('keydown', onKey);
        host.remove();
      },
    };
  },
};
