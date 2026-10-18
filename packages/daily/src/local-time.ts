// Release times in the player's own time (D-46). The puzzle day is the UTC day, but players
// read times in their own zone: "New puzzle at 8:00 PM", "in 6 hours". These format a
// supplied instant or duration with Intl and read no clock. Leaving out `locale` or
// `timeZone` uses the runtime's own, which in a browser is the device's.

const MINUTE = 60_000;

export type LocalTimeOptions = {
  /** A BCP 47 locale such as "en-US". Defaults to the runtime's locale. */
  readonly locale?: string;
  /** An IANA time zone such as "America/New_York". Defaults to the runtime's zone. */
  readonly timeZone?: string;
};

/**
 * The wall-clock time of `instant` in the player's zone, such as "8:00 PM" or "20:00",
 * following the locale's 12- or 24-hour habit.
 */
export const localTimeText = (instant: number, options: LocalTimeOptions = {}): string => {
  if (!Number.isFinite(instant)) throw new RangeError(`Expected an instant in epoch milliseconds, got ${instant}.`);
  return new Intl.DateTimeFormat(options.locale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  }).format(instant);
};

/**
 * A plain countdown such as "in 6 hours" or "in 45 minutes". From an hour up it counts whole
 * hours, rounded down; below an hour it counts minutes, rounded up, so it never says "in 0
 * minutes" before the release. Information, never pressure (audience-and-age.md).
 */
export const countdownText = (ms: number, locale?: string): string => {
  if (!Number.isFinite(ms)) throw new RangeError(`Expected a duration in milliseconds, got ${ms}.`);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.max(0, Math.ceil(ms / MINUTE));
  return minutes < 60 ? format.format(minutes, 'minute') : format.format(Math.floor(minutes / 60), 'hour');
};
