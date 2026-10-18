// <jy-report-problem>: the frame's "Report a problem" control for AI-content games (D-52,
// content-pipeline.md, "Moderation in /admin"). The launcher puts it in the results and in the
// pause menu, outside the game's canvas (D-07). Closed, it is one disclosure line; open, a
// short form: a reason from a fixed list and an optional note. It sends the game, the puzzle
// ID when the launcher knows it, the reason and the note to the site (report.ts), and nothing
// about the player (D-26). The request is a command for the `launcher-report` driver, so tests
// substitute it by name.
import { command, css, define, defineDriver, html, nothing, prop, type Command, type PropsOf } from '@gyral/core';
import {
  isReportReason,
  REPORT_FIELDS,
  REPORT_NOTE_MAX,
  REPORT_PATH,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  type ReportReason,
} from './report.ts';

export interface ReportRequest {
  readonly game: string;
  /** '' when the launcher knows no puzzle. */
  readonly puzzle: string;
  readonly reason: ReportReason;
  readonly note: string;
}

export type ReportAnswer = { readonly ok: true } | { readonly ok: false; readonly message: string };

export const NOT_SENT = 'Your report didn’t send. Check your connection, then try again.';

const answerOf = (status: number, body: unknown): ReportAnswer => {
  if (status === 201) return { ok: true };
  const issues =
    typeof body === 'object' && body !== null && Array.isArray((body as { issues?: unknown }).issues)
      ? (body as { issues: unknown[] }).issues
      : [];
  const first = issues.find((i): i is string => typeof i === 'string');
  return { ok: false, message: first ?? NOT_SENT };
};

/** POST /api/reports on this page's origin, as a web form; the answer is JSON. */
export const reportDriver = defineDriver<ReportRequest, ReportAnswer>({
  name: 'launcher-report',
  run: async (input, { signal }) => {
    const body = new URLSearchParams({
      [REPORT_FIELDS.game]: input.game,
      [REPORT_FIELDS.puzzle]: input.puzzle,
      [REPORT_FIELDS.reason]: input.reason,
      [REPORT_FIELDS.note]: input.note,
    });
    try {
      const response = await fetch(new URL(REPORT_PATH, location.origin), {
        method: 'POST',
        body,
        headers: { accept: 'application/json' },
        credentials: 'omit',
        signal,
      });
      let parsed: unknown = null;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      return answerOf(response.status, parsed);
    } catch {
      return { ok: false, message: NOT_SENT };
    }
  },
  // One report at a time: a second press while one is out is dropped.
  concurrency: 'exhaust',
});

const sendReport = <M>(request: ReportRequest, toMsg: (answer: ReportAnswer) => M): Command<M> =>
  command<ReportRequest, ReportAnswer, unknown, M>(reportDriver, request, {
    onSuccess: toMsg,
    onFailure: () => toMsg({ ok: false, message: NOT_SENT }),
  });

export type ReportPhase = 'idle' | 'sending' | 'sent';

export interface ReportState {
  readonly phase: ReportPhase;
  /** Why the last attempt failed, worded for players; null otherwise. */
  readonly problem: string | null;
}

export type ReportMsg =
  | { readonly _tag: 'Send'; readonly reason: ReportReason; readonly note: string }
  | { readonly _tag: 'Answered'; readonly answer: ReportAnswer };

const props = {
  gameId: prop.string({ required: true }),
  /** The puzzle the player is on, when the launcher knows it ('' otherwise). */
  puzzleId: prop.string({ default: '' }),
};
type Props = PropsOf<typeof props>;

/** The note as sent: one line of plain text, trimmed, at most REPORT_NOTE_MAX characters. */
export const cleanNote = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, REPORT_NOTE_MAX) : '';

const styles = css`
  :host {
    display: block;
  }
  details {
    border-block-start: 1px solid var(--jy-border, currentColor);
    padding-block-start: var(--jy-space-2xs, 0.5rem);
  }
  summary {
    cursor: pointer;
    inline-size: fit-content;
    min-block-size: var(--jy-target-min, 2.75rem);
    display: flex;
    align-items: center;
    color: var(--jy-text-muted, inherit);
    font-size: var(--jy-step--1, 0.9rem);
  }
  summary:focus-visible {
    outline: 3px solid var(--jy-focus-ring, Highlight);
    outline-offset: 2px;
  }
  form {
    display: grid;
    gap: var(--jy-space-2xs, 0.5rem);
    justify-items: start;
  }
  fieldset {
    display: grid;
    gap: var(--jy-space-3xs, 0.25rem);
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    font-weight: 600;
    padding: 0;
    margin-block-end: var(--jy-space-3xs, 0.25rem);
  }
  .choice {
    display: flex;
    align-items: center;
    gap: var(--jy-space-2xs, 0.5rem);
    min-block-size: 2rem;
  }
  label[for] {
    font-weight: 600;
  }
  textarea {
    inline-size: min(100%, 28rem);
    font: inherit;
    color: var(--jy-text, CanvasText);
    background: var(--jy-surface-raised, Canvas);
    border: 1px solid var(--jy-border, currentColor);
    border-radius: var(--jy-radius-s, 0.375rem);
    padding: var(--jy-space-2xs, 0.5rem);
    resize: vertical;
  }
  .hint {
    margin: 0;
    color: var(--jy-text-muted, inherit);
    font-size: var(--jy-step--1, 0.9rem);
  }
  .problem {
    margin: 0;
    color: var(--jy-danger, inherit);
  }
  .status:empty {
    display: none;
  }
  .status {
    margin: 0;
  }
  button {
    min-block-size: var(--jy-target-min, 2.75rem);
    padding-inline: var(--jy-space-s, 1rem);
    font: inherit;
    font-weight: 600;
    color: var(--jy-text, CanvasText);
    background: transparent;
    border: 1px solid var(--jy-border, currentColor);
    border-radius: var(--jy-radius-pill, 999px);
    cursor: pointer;
  }
  button:focus-visible,
  textarea:focus-visible,
  input:focus-visible {
    outline: 3px solid var(--jy-focus-ring, Highlight);
    outline-offset: 2px;
  }
`;

const STATUS: Readonly<Record<ReportPhase, string>> = {
  idle: '',
  sending: 'Sending your report…',
  sent: 'Thank you. We’ll take a look.',
};

export const ReportProblem = define<ReportState, ReportMsg, Props>()('jy-report-problem', {
  props,
  styles,
  init: () => ({ phase: 'idle', problem: null }),
  intent: {
    // The radios are required, so the browser asks for a reason before the form submits.
    Send: ({ formData }) => {
      const reason = formData?.get(REPORT_FIELDS.reason);
      return isReportReason(reason)
        ? { _tag: 'Send', reason, note: cleanNote(formData?.get(REPORT_FIELDS.note)) }
        : undefined;
    },
  },
  update: {
    Send: (s, m, { props: p }) =>
      s.phase !== 'idle'
        ? s
        : [
            { phase: 'sending', problem: null },
            [
              sendReport<ReportMsg>(
                { game: p.gameId, puzzle: p.puzzleId, reason: m.reason, note: m.note },
                (answer) => ({ _tag: 'Answered', answer }),
              ),
            ],
          ],
    Answered: (_s, m) =>
      m.answer.ok ? { phase: 'sent', problem: null } : { phase: 'idle', problem: m.answer.message },
  },
  view: (s, i, { props: p }) => html`<details>
    <summary>Report a problem</summary>
    <p class="status" role="status">${STATUS[s.phase]}</p>
    ${
      s.phase === 'sent'
        ? nothing
        : html`<form data-intent=${i.Send} aria-label="Report a problem">
          <fieldset>
            <legend>What’s wrong?</legend>
            ${REPORT_REASONS.map(
              (reason) =>
                html`<label class="choice"><input type="radio" name=${REPORT_FIELDS.reason} value=${reason} required /> ${REPORT_REASON_LABELS[reason]}</label>`,
            )}
          </fieldset>
          <label for="report-note">Anything to add? (optional)</label>
          <p class="hint" id="report-note-hint">Up to ${REPORT_NOTE_MAX} characters. Please leave out your name and how to reach you.</p>
          <textarea id="report-note" name=${REPORT_FIELDS.note} rows="2" maxlength=${String(REPORT_NOTE_MAX)} aria-describedby="report-note-hint"></textarea>
          <p class="hint">We get the game${p.puzzleId === '' ? '' : ' and the puzzle'}, the reason and your note, and nothing about you.</p>
          ${s.problem === null ? nothing : html`<p class="problem" role="alert">${s.problem}</p>`}
          <button type="submit" ?disabled=${s.phase === 'sending'}>Send report</button>
        </form>`
    }
  </details>`,
});
