// <jy-report-problem> and the puzzle the launcher hands it, as models: no DOM.
import { inputsFor, resolve, step } from '@gyral/testing';
import { describe, expect, it } from 'vitest';
import { tallyManifest } from './fixture/index.ts';
import { freshState, Launcher, type LauncherState } from './launcher.ts';
import { launcherGame, parseStageOutput } from './model.ts';
import { cleanNote, NOT_SENT, reportDriver, ReportProblem, type ReportState } from './report-problem.ts';
import { isReportPuzzleId, REPORT_NOTE_MAX } from './report.ts';

const { spec } = ReportProblem;
const props = { gameId: 'word-of-the-day', puzzleId: 'word-of-the-day:2026-10-09' };
const idle: ReportState = { phase: 'idle', problem: null };

describe('<jy-report-problem>', () => {
  it('sends the game, the puzzle, the reason and the note, once', () => {
    const sent = step(spec, idle, { _tag: 'Send', reason: 'wrong-answer', note: 'Spelled wrong.' }, props);
    expect(sent.state).toEqual({ phase: 'sending', problem: null });
    expect(inputsFor(sent.commands, reportDriver)).toEqual([
      { game: 'word-of-the-day', puzzle: 'word-of-the-day:2026-10-09', reason: 'wrong-answer', note: 'Spelled wrong.' },
    ]);
    // A second press while one is out does nothing.
    expect(step(spec, sent.state, { _tag: 'Send', reason: 'confusing', note: '' }, props).commands).toEqual([]);
    const [command] = sent.commands;
    if (command === undefined) throw new Error('expected the request');
    expect(resolve(command, { ok: true })).toEqual({ _tag: 'Answered', answer: { ok: true } });
  });

  it('thanks the player once the site takes it, and says why when it doesn’t', () => {
    const sending: ReportState = { phase: 'sending', problem: null };
    expect(step(spec, sending, { _tag: 'Answered', answer: { ok: true } }, props).state).toEqual({
      phase: 'sent',
      problem: null,
    });
    expect(step(spec, sending, { _tag: 'Answered', answer: { ok: false, message: NOT_SENT } }, props).state).toEqual({
      phase: 'idle',
      problem: NOT_SENT,
    });
  });

  it('sends the note as one trimmed line, cut to the limit', () => {
    expect(cleanNote('  two\n lines  ')).toBe('two lines');
    expect(cleanNote('x'.repeat(REPORT_NOTE_MAX + 5))).toHaveLength(REPORT_NOTE_MAX);
    expect(cleanNote(null)).toBe('');
  });

  it('accepts only a puzzle ID of the same game', () => {
    expect(isReportPuzzleId('crossword', 'crossword:2026-10-09')).toBe(true);
    expect(isReportPuzzleId('letter-drop', 'letter-drop:pack:fruit')).toBe(true);
    expect(isReportPuzzleId('crossword', 'hangman:2026-10-09')).toBe(false);
    expect(isReportPuzzleId('crossword', 'crossword:<b>')).toBe(false);
  });
});

describe('the launcher’s puzzle for a report', () => {
  const game = launcherGame({ ...tallyManifest, aiContent: true });
  const live: LauncherState = { ...freshState(game), live: true };

  it('takes the puzzle the stage names, checked at the boundary', () => {
    expect(parseStageOutput({ _tag: 'Puzzle', puzzleId: 'test-tally:2026-10-09' })).toEqual({
      _tag: 'Puzzle',
      puzzleId: 'test-tally:2026-10-09',
    });
    expect(parseStageOutput({ _tag: 'Puzzle', puzzleId: 'not an id' })).toBeUndefined();
    const next = step(
      Launcher.spec,
      live,
      { _tag: 'StageOut', out: { _tag: 'Puzzle', puzzleId: 'test-tally:2026-10-09' } },
      { game },
    );
    expect(next.state.puzzle).toBe('test-tally:2026-10-09');
  });

  it('forgets it when a new round starts', () => {
    const named: LauncherState = { ...live, puzzle: 'test-tally:2026-10-09' };
    const started = step(Launcher.spec, named, { _tag: 'Start' }, { game });
    expect(started.state.puzzle).toBeNull();
  });
});
