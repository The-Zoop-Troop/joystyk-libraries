// "Report a problem" (content-pipeline.md, "Moderation in /admin"): what the frame's report
// form sends and what the site accepts, shared so the two can't drift. The AI-content notice
// (D-52) points players here. A report names the game, the puzzle when the frame knows it, one
// reason from a fixed list and an optional short note; nothing about the player (D-26).
// Plain data only: the site's server imports it as `@joystyk/launcher/report`.

/** Where the form posts (apps/site/src/server/reports/handler.ts). */
export const REPORT_PATH = '/api/reports';

export const REPORT_REASONS = ['wrong-answer', 'confusing', 'offensive', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** The choices as players read them, in the order the form lists them. */
export const REPORT_REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  'wrong-answer': 'The answer is wrong',
  confusing: 'A clue or hint is confusing',
  offensive: 'Something is unkind or not suitable',
  other: 'Something else',
};

/** The note's longest length, in characters. */
export const REPORT_NOTE_MAX = 200;

/** The form's field names. */
export const REPORT_FIELDS = { game: 'game', puzzle: 'puzzle', reason: 'reason', note: 'note' } as const;

/** A puzzle ID the site accepts: `<game>:<date>`, `<game>:pack:<slug>` and the like. */
export const isReportPuzzleId = (gameId: string, value: string): boolean =>
  value.length <= 120 && value.startsWith(`${gameId}:`) && /^[a-z0-9-]+(:[a-z0-9-]+)+$/.test(value);

export const isReportReason = (value: unknown): value is ReportReason =>
  typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
