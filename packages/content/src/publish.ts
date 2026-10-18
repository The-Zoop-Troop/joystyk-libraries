// Publishing: the daily files and each game's index, in exactly the format @joystyk/daily
// decodes (content-pipeline.md, "Delivery"):
//
//   <dir>/<game>/index.json              { schemaVersion: 1, gameId, dates: [{ date, hash, size }] }
//   <dir>/<game>/<date>.<hash>.json      { schemaVersion: 1, puzzleId, date, contentHash, config }
//
// The site serves the folder: the index `no-cache`, puzzle files immutable. A puzzle file is
// never rewritten (its name is its hash); every write goes to a temporary file first and is
// renamed into place, so the site never serves half a file.
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '@joystyk/contracts';
import { DAILY_SCHEMA_VERSION, puzzleId, type DailyFile, type DailyIndex, type DailyIndexEntry } from '@joystyk/daily';
import { contentHash } from './hash.ts';

export interface PublishedFile {
  readonly hash: string;
  readonly size: number;
  /** Relative to the publish directory: "<game>/<date>.<hash>.json". */
  readonly file: string;
}

export interface Publisher {
  readonly dir: string;
  /** Writes one day's puzzle file (if it isn't there already) and returns its hash and size. */
  writePuzzle(gameId: string, date: string, config: Json): PublishedFile;
  /** Replaces a game's index. */
  writeIndex(gameId: string, dates: readonly DailyIndexEntry[]): void;
}

/** The puzzle file body for a config: the envelope, as compact JSON. */
export const puzzleFileBody = (gameId: string, date: string, config: Json): { body: string; hash: string } => {
  const hash = contentHash(config);
  const file: DailyFile = {
    schemaVersion: DAILY_SCHEMA_VERSION,
    puzzleId: puzzleId(gameId, date),
    date,
    contentHash: hash,
    config,
  };
  return { body: JSON.stringify(file), hash };
};

let counter = 0;
const writeAtomic = (path: string, body: string): void => {
  const temporary = `${path}.${String(process.pid)}.${String(++counter)}.tmp`;
  writeFileSync(temporary, body);
  renameSync(temporary, path);
};

export const createPublisher = (dir: string): Publisher => ({
  dir,
  writePuzzle: (gameId, date, config) => {
    const { body, hash } = puzzleFileBody(gameId, date, config);
    const folder = join(dir, gameId);
    mkdirSync(folder, { recursive: true });
    const name = `${date}.${hash}.json`;
    const path = join(folder, name);
    if (!existsSync(path)) writeAtomic(path, body);
    return { hash, size: Buffer.byteLength(body), file: `${gameId}/${name}` };
  },
  writeIndex: (gameId, dates) => {
    const folder = join(dir, gameId);
    mkdirSync(folder, { recursive: true });
    const index: DailyIndex = {
      schemaVersion: DAILY_SCHEMA_VERSION,
      gameId,
      dates: [...dates].sort((a, b) => (a.date < b.date ? -1 : 1)),
    };
    writeAtomic(join(folder, 'index.json'), `${JSON.stringify(index)}\n`);
  },
});
