// The flag file (offline-and-updates.md, Rules 2 and 5): a small `no-cache` JSON file the site
// serves at /pwa-control.json, which operators change without a deploy. It carries two flags.
//
// - The kill switch. When it says the worker is disabled, pages stop registering it, and
//   every installed worker unregisters itself and deletes the PWA's caches. Saves and other
//   IndexedDB data are never touched.
// - The minimum release, for forced security updates. A page whose release is older shows a
//   blocking notice, saves the game and reloads into the current release.
//
// Releases are ordered by their release time: the UTC time of the commit a release is built
// from (apps/site/vite.config.ts). Release IDs are commit hashes, which have no order.
import { decodeSync, isRecord, validator } from './validate.ts';

export type Control = {
  readonly schemaVersion: 1;
  readonly serviceWorker: 'enabled' | 'disabled';
  /**
   * The release time of the oldest release that may keep running, as an RFC 3339 date-time
   * such as "2026-10-09T14:03:12Z". An open page from an older release must update.
   */
  readonly minimumRelease?: string;
};

/** An RFC 3339 date-time with seconds and a zone: what `git show -s --format=%cI` prints, or UTC. */
const RELEASE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A release time in milliseconds since the epoch, or null when it isn't a valid date-time. */
export const releaseTimeMs = (value: unknown): number | null => {
  if (typeof value !== 'string' || !RELEASE_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** A release time in its canonical form: UTC, whole seconds, e.g. "2026-10-09T14:03:12Z". */
export const canonicalReleaseTime = (value: string): string | null => {
  const ms = releaseTimeMs(value);
  return ms === null ? null : `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
};

export const ControlSchema = validator<Control>((value, issues) => {
  if (!isRecord(value)) {
    issues.push('Expected an object');
    return undefined;
  }
  const { schemaVersion, serviceWorker, minimumRelease } = value;
  if (schemaVersion !== 1) issues.push('schemaVersion: expected 1');
  if (serviceWorker !== 'enabled' && serviceWorker !== 'disabled')
    issues.push('serviceWorker: expected "enabled" or "disabled"');
  if (minimumRelease !== undefined && releaseTimeMs(minimumRelease) === null) {
    issues.push('minimumRelease: expected a date-time such as "2026-10-09T14:03:12Z"');
  }
  if (issues.length > 0) return undefined;
  const control: Control = { schemaVersion: 1, serviceWorker: serviceWorker as Control['serviceWorker'] };
  return minimumRelease === undefined ? control : { ...control, minimumRelease: minimumRelease as string };
});

export const DEFAULT_CONTROL: Control = { schemaVersion: 1, serviceWorker: 'enabled' };

/**
 * What the flag file says. Anything unreadable, a network failure included, reads as "no
 * instruction": a broken flag file must not wipe every player's offline games, and a page
 * that can't reach the server keeps playing.
 */
export const parseControl = (value: unknown): Control | null => decodeSync(ControlSchema, value);

export const isDisabled = (control: Control | null): boolean => control?.serviceWorker === 'disabled';

/**
 * True when a page running the release built at `releaseTime` must update now: the flag
 * file names a minimum release, and this one is older. An unreadable time on either side
 * never forces anything.
 */
export const mustUpdate = (control: Control | null, releaseTime: string): boolean => {
  const minimum = releaseTimeMs(control?.minimumRelease);
  const own = releaseTimeMs(releaseTime);
  return minimum !== null && own !== null && own < minimum;
};

/**
 * The flag file as the server running `releaseTime` serves it: a minimum later than that
 * release comes down to it. Raising the minimum past what the site serves would otherwise
 * send every page into a reload that can never reach a new enough release.
 */
export const capMinimumRelease = (control: Control, releaseTime: string): Control => {
  const minimum = releaseTimeMs(control.minimumRelease);
  const own = releaseTimeMs(releaseTime);
  if (minimum === null || own === null || minimum <= own) return control;
  return { ...control, minimumRelease: releaseTime };
};

/**
 * The build's record of its release, written beside `sw.js` as `release.json` and never
 * served: the site reads it to cap the minimum release it serves.
 */
export type ReleaseRecord = {
  readonly release: string;
  /** Canonical: UTC, whole seconds. */
  readonly releaseTime: string;
};

export const RELEASE_RECORD_FILE = 'release.json';

export const ReleaseRecordSchema = validator<ReleaseRecord>((value, issues) => {
  if (!isRecord(value)) {
    issues.push('Expected an object');
    return undefined;
  }
  const { release, releaseTime } = value;
  if (typeof release !== 'string' || release === '') issues.push('release: expected text');
  if (releaseTimeMs(releaseTime) === null) issues.push('releaseTime: expected a date-time');
  return issues.length === 0 ? { release: release as string, releaseTime: releaseTime as string } : undefined;
});

export const parseReleaseRecord = (value: unknown): ReleaseRecord | null => decodeSync(ReleaseRecordSchema, value);
