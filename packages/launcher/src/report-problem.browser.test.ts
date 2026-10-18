// <jy-report-problem> in real Chromium, with the report driver faked: the closed disclosure,
// the required reason, the note, the thanks, and a refusal shown as an alert.
import { defineDriver, settled } from '@gyral/core';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '@joystyk/ui/tokens.css';
import { ReportProblem, type ReportAnswer, type ReportRequest } from './report-problem.ts';

afterEach(() => {
  document.body.replaceChildren();
});

const mount = async (answer: ReportAnswer, puzzleId = 'test-tally:2026-10-09') => {
  const sent: ReportRequest[] = [];
  const el = new ReportProblem();
  el.setAttribute('game-id', 'test-tally');
  el.setAttribute('puzzle-id', puzzleId);
  el.drivers = {
    'launcher-report': defineDriver<ReportRequest, ReportAnswer>({
      name: 'launcher-report',
      run: (request) => {
        sent.push(request);
        return answer;
      },
    }),
  };
  document.body.append(el);
  await settled();
  return { el, sent };
};

it('opens from one line, needs a reason, sends the note and thanks the player', async () => {
  const { el, sent } = await mount({ ok: true });
  const summary = page.getByText('Report a problem', { exact: true });
  await expect.element(summary).toBeVisible();
  expect(el.shadowRoot?.querySelector('details')?.open).toBe(false);
  await summary.click();
  // The browser asks for a reason first: nothing is sent.
  await page.getByRole('button', { name: 'Send report' }).click();
  expect(sent).toEqual([]);
  await page.getByRole('radio', { name: 'The answer is wrong' }).click();
  await page.getByRole('textbox', { name: 'Anything to add? (optional)' }).fill('  The word is spelled\nwrong. ');
  await expect
    .element(page.getByText('We get the game and the puzzle, the reason and your note, and nothing about you.'))
    .toBeVisible();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect.element(page.getByRole('status')).toHaveTextContent('Thank you. We’ll take a look.');
  expect(sent).toEqual([
    { game: 'test-tally', puzzle: 'test-tally:2026-10-09', reason: 'wrong-answer', note: 'The word is spelled wrong.' },
  ]);
  await expect.element(page.getByRole('button', { name: 'Send report' })).not.toBeInTheDocument();
});

it('shows why the site refused, and lets the player try again', async () => {
  const { sent } = await mount({ ok: false, message: 'Leave out email addresses, links and phone numbers.' }, '');
  await page.getByText('Report a problem', { exact: true }).click();
  await expect
    .element(page.getByText('We get the game, the reason and your note, and nothing about you.'))
    .toBeVisible();
  await page.getByRole('radio', { name: 'Something else' }).click();
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect
    .element(page.getByRole('alert'))
    .toHaveTextContent('Leave out email addresses, links and phone numbers.');
  await expect.element(page.getByRole('button', { name: 'Send report' })).toBeEnabled();
  expect(sent).toHaveLength(1);
});
