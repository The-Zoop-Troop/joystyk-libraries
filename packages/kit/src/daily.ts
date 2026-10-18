// Daily seeds. There is no clock here: the caller passes the date as a "yyyy-mm-dd"
// string, which the platform's `daily` package derives from the player's calendar day.
// Everyone who plays a game on the same date gets the same seed, on every device.

import { isGameId, type Rng, type RngState } from '@joystyk/contracts';
import { restoreRng, seedState } from './rng.ts';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/** True for a real calendar date written "yyyy-mm-dd", such as "2026-10-08" (not "2026-02-30"). */
export const isIsoDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

const checkDate = (date: string): void => {
  if (!isIsoDate(date)) throw new RangeError(`Expected a "yyyy-mm-dd" date, got ${JSON.stringify(date)}.`);
};

/**
 * The daily puzzle id `<game>:<yyyy-mm-dd>`, e.g. "sudoku:2026-10-08". Throws a
 * `RangeError` for a game id that isn't kebab-case or a date that isn't real.
 */
export const dailyId = (gameId: string, date: string): string => {
  if (!isGameId(gameId)) throw new RangeError(`Expected a kebab-case game id, got ${JSON.stringify(gameId)}.`);
  checkDate(date);
  return `${gameId}:${date}`;
};

/** The RNG state for a game's daily puzzle: `seedState(dailyId(gameId, date))`. */
export const dailySeed = (gameId: string, date: string): RngState => seedState(dailyId(gameId, date));

/** A generator for a game's daily puzzle. */
export const dailyRng = (gameId: string, date: string): Rng => restoreRng(dailySeed(gameId, date));

/**
 * Days since 1970-01-01 (day 0), counted in the proleptic Gregorian calendar. Handy for
 * puzzle numbers ("Daily #412") and streaks. Integer-only (Howard Hinnant's
 * `days_from_civil`), so no time zone or clock is involved.
 */
export const dayNumber = (date: string): number => {
  checkDate(date);
  const [y0, m, d] = date.split('-').map(Number) as [number, number, number];
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

/** The "yyyy-mm-dd" date of a day number; the inverse of `dayNumber` (Hinnant's `civil_from_days`). */
export const dateOfDay = (day: number): string => {
  if (!Number.isSafeInteger(day)) throw new RangeError(`Expected an integer day number, got ${day}.`);
  const z = day + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  if (y < 0 || y > 9999) throw new RangeError(`Day ${day} falls outside years 0000–9999.`);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** The date `days` after `date` (before, when negative): `addDays('2026-12-31', 1)` is "2027-01-01". */
export const addDays = (date: string, days: number): string => dateOfDay(dayNumber(date) + days);
