// What a pinned cache keeps beside the files, at PIN_RECORD_PATH: enough to list the pin on
// the offline page, refresh it and remove it. Read back from Cache Storage, so decoded.
import { isGameId } from '@joystyk/contracts';
import { decodeSync, isPath, isRecord, validator } from './validate.ts';

export type PinRecord = {
  readonly id: string;
  readonly name: string;
  /** The game build the cache holds. */
  readonly version: string;
  /** The platform release that built it. */
  readonly release: string;
  readonly page: string;
  /** Where the asset manifest came from (the game manifest's `assets`). */
  readonly assets: string;
  readonly totalBytes: number;
};

export const PinRecordSchema = validator<PinRecord>((value, issues) => {
  if (!isRecord(value)) {
    issues.push('Expected an object');
    return undefined;
  }
  const { id, name, version, release, page, assets, totalBytes } = value;
  if (!isGameId(id)) issues.push('id: expected a kebab-case game id');
  for (const [key, field] of [
    ['name', name],
    ['version', version],
    ['release', release],
  ] as const) {
    if (typeof field !== 'string' || field === '') issues.push(`${key}: expected text`);
  }
  if (!isPath(page)) issues.push('page: expected a site path');
  if (!isPath(assets)) issues.push('assets: expected a site path');
  if (typeof totalBytes !== 'number' || !Number.isInteger(totalBytes) || totalBytes < 0)
    issues.push('totalBytes: expected a whole number');
  return issues.length === 0 ? (value as PinRecord) : undefined;
});

export const parsePinRecord = (value: unknown): PinRecord | null => {
  const record = decodeSync(PinRecordSchema, value);
  return record === null
    ? null
    : {
        id: record.id,
        name: record.name,
        version: record.version,
        release: record.release,
        page: record.page,
        assets: record.assets,
        totalBytes: record.totalBytes,
      };
};
