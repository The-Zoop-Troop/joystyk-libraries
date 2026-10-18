// The SQLite room store (room-server.md sections 6.4 to 6.6), on node:sqlite's synchronous
// DatabaseSync: a step and its write finish before the event loop delivers the next message.
import { existsSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import type { EngineInput, Json } from '@joystyk/contracts';
import { MAX_ROOM_AGE_MS } from '../policy.ts';
import { decodeRecord, RECORD_FORMAT } from '../record.ts';
import type { LoggedInput, RoomCode, RoomRecord } from '../types.ts';
import type { Logger } from './support.ts';

export interface RoomStore {
  /** The decoded record, or null when missing or quarantined. Throws on a newer record format. */
  load(code: RoomCode): RoomRecord | null;
  exists(code: RoomCode): boolean;
  /** One transaction: update the room where writes = expected, and append the inputs. */
  save(record: RoomRecord, inputs: readonly LoggedInput[], expectedWrites: number): 'saved' | 'conflict';
  insert(record: RoomRecord): void;
  /** Moves a row that can't be used to `room_archive` and deletes it. */
  quarantine(code: RoomCode, reason: string): void;
  liveVersions(): readonly { readonly gameId: string; readonly rulesVersion: number; readonly rooms: number }[];
  /** Rooms with a job outstanding: they resume at start-up, so the job re-runs at once. */
  withPendingJobs(): readonly RoomCode[];
  /** A match's input log, for replays and bug reports. */
  inputs(code: RoomCode, match: number): readonly LoggedInput[];
  /** Deletes rows past expires_at (their inputs cascade). Returns how many. */
  prune(now: number): number;
  /** True when the database accepts a write (for /readyz). */
  ping(): boolean;
  /** An online copy, checked with `PRAGMA integrity_check`. Refuses to overwrite a file. */
  backup(file: string): Promise<void>;
  /** After a restore from backup: bump every room's epoch so clients accept older revisions. */
  bumpEpochs(): number;
  close(): void;
}

type Migration = { readonly version: number; readonly name: string; readonly sql: string };

/**
 * Database migrations, applied in order inside one transaction and tracked with
 * `PRAGMA user_version`. Append; never edit a shipped entry.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE rooms (
        code           TEXT    PRIMARY KEY,
        game_id        TEXT    NOT NULL,
        rules_version  INTEGER NOT NULL,
        game_build     TEXT    NOT NULL,
        phase          TEXT    NOT NULL CHECK (phase IN ('lobby', 'playing', 'finished', 'closed')),
        revision       INTEGER NOT NULL,
        writes         INTEGER NOT NULL,
        record_format  INTEGER NOT NULL,
        record         TEXT    NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX rooms_expires ON rooms (expires_at);
      CREATE INDEX rooms_live_versions ON rooms (game_id, rules_version) WHERE phase IN ('lobby', 'playing');
      CREATE TABLE room_inputs (
        code      TEXT    NOT NULL REFERENCES rooms (code) ON DELETE CASCADE,
        match     INTEGER NOT NULL,
        revision  INTEGER NOT NULL,
        at        INTEGER NOT NULL,
        input     TEXT    NOT NULL,
        PRIMARY KEY (code, revision)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE room_archive (
        code TEXT NOT NULL, record_format INTEGER NOT NULL, record TEXT NOT NULL, reason TEXT NOT NULL, archived_at INTEGER NOT NULL,
        PRIMARY KEY (code, record_format, archived_at)
      ) STRICT;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/** When a room's row may be deleted: retainMs after its last change, at most 7 days after creation. */
export const expiresAt = (record: RoomRecord): number =>
  Math.min(record.updatedAt + record.policy.retainMs, record.createdAt + MAX_ROOM_AGE_MS);

const pinOf = (record: RoomRecord) => record.match?.game ?? record.game;

export type SqliteStoreOptions = {
  readonly log?: Logger;
  readonly now?: () => number;
};

/**
 * Opens (and migrates) the database. A database newer than this build is refused, so a
 * rollback can't corrupt newer data; before migrating an existing database, a backup is taken.
 */
export const openSqliteStore = async (file: string, options: SqliteStoreOptions = {}): Promise<RoomStore> => {
  const now = options.now ?? Date.now;
  const db = new DatabaseSync(file);
  const version = Number(db.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `The room database is at schema version ${version}, newer than this build's ${SCHEMA_VERSION}. Deploy a newer build.`,
    );
  }
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
  );
  if (version < SCHEMA_VERSION) {
    if (version > 0 && file !== ':memory:') {
      const copy = `${file}.pre-v${SCHEMA_VERSION}-${now()}.bak`;
      await backup(db, copy);
      options.log?.write('info', 'backup_written', { reason: 'migration', schema: version });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.version <= version) continue;
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
        options.log?.write('info', 'migration_applied', { version: migration.version, name: migration.name });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  return new SqliteRoomStore(db, options.log ?? null, now);
};

class SqliteRoomStore implements RoomStore {
  private readonly statements;
  private readonly db: DatabaseSync;
  private readonly log: Logger | null;
  private readonly now: () => number;

  constructor(db: DatabaseSync, log: Logger | null, now: () => number) {
    this.db = db;
    this.log = log;
    this.now = now;
    this.statements = {
      load: db.prepare('SELECT record FROM rooms WHERE code = ?'),
      exists: db.prepare('SELECT 1 AS found FROM rooms WHERE code = ?'),
      insert: db.prepare(
        `INSERT INTO rooms (code, game_id, rules_version, game_build, phase, revision, writes, record_format, record, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      update: db.prepare(
        `UPDATE rooms SET game_id = ?, rules_version = ?, game_build = ?, phase = ?, revision = ?, writes = ?, record_format = ?, record = ?,
           updated_at = ?, expires_at = ? WHERE code = ? AND writes = ?`,
      ),
      rewrite: db.prepare('UPDATE rooms SET record_format = ?, record = ? WHERE code = ?'),
      input: db.prepare('INSERT INTO room_inputs (code, match, revision, at, input) VALUES (?, ?, ?, ?, ?)'),
      archive: db.prepare(
        'INSERT OR REPLACE INTO room_archive (code, record_format, record, reason, archived_at) VALUES (?, ?, ?, ?, ?)',
      ),
      remove: db.prepare('DELETE FROM rooms WHERE code = ?'),
      versions: db.prepare(
        "SELECT game_id AS gameId, rules_version AS rulesVersion, COUNT(*) AS rooms FROM rooms WHERE phase IN ('lobby', 'playing') GROUP BY game_id, rules_version",
      ),
      pendingJobs: db.prepare(
        "SELECT code FROM rooms WHERE phase = 'playing' AND json_array_length(record, '$.match.jobs') > 0",
      ),
      inputs: db.prepare(
        'SELECT match, revision, at, input FROM room_inputs WHERE code = ? AND match = ? ORDER BY revision',
      ),
      prune: db.prepare('DELETE FROM rooms WHERE expires_at < ?'),
      epochs: db.prepare("UPDATE rooms SET record = json_set(record, '$.epoch', json_extract(record, '$.epoch') + 1)"),
    };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  load(code: RoomCode): RoomRecord | null {
    const row = this.statements.load.get(code);
    if (row === undefined) return null;
    const text = String(row['record']);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.quarantine(code, 'json');
      return null;
    }
    const decoded = decodeRecord(raw);
    if (!decoded.ok) {
      if (decoded.error.code === 'newer-format') throw new Error(decoded.error.message);
      this.quarantine(code, 'schema');
      return null;
    }
    const { record, migrated } = decoded.value;
    if (migrated) {
      const format = (raw as { format: number }).format;
      this.transaction(() => {
        this.statements.archive.run(code, format, text, 'migration', this.now());
        this.statements.rewrite.run(RECORD_FORMAT, JSON.stringify(record), code);
      });
    }
    return record;
  }

  exists(code: RoomCode): boolean {
    return this.statements.exists.get(code) !== undefined;
  }

  insert(record: RoomRecord): void {
    const pin = pinOf(record);
    this.statements.insert.run(
      record.code,
      pin.id,
      pin.rulesVersion,
      pin.build,
      record.phase,
      record.revision,
      record.writes,
      record.format,
      JSON.stringify(record),
      record.createdAt,
      record.updatedAt,
      expiresAt(record),
    );
  }

  save(record: RoomRecord, inputs: readonly LoggedInput[], expectedWrites: number): 'saved' | 'conflict' {
    const pin = pinOf(record);
    return this.transaction(() => {
      const result = this.statements.update.run(
        pin.id,
        pin.rulesVersion,
        pin.build,
        record.phase,
        record.revision,
        record.writes,
        record.format,
        JSON.stringify(record),
        record.updatedAt,
        expiresAt(record),
        record.code,
        expectedWrites,
      );
      if (Number(result.changes) !== 1) return 'conflict';
      for (const input of inputs)
        this.statements.input.run(record.code, input.match, input.revision, input.at, JSON.stringify(input.input));
      return 'saved';
    });
  }

  quarantine(code: RoomCode, reason: string): void {
    const row = this.statements.load.get(code);
    if (row === undefined) return;
    const text = String(row['record']);
    let format = 0;
    try {
      format = Number((JSON.parse(text) as { format?: unknown }).format) || 0;
    } catch {
      format = 0;
    }
    this.transaction(() => {
      this.statements.archive.run(code, format, text, reason, this.now());
      this.statements.remove.run(code);
    });
    this.log?.write('error', 'room_corrupt', { room: code, reason });
  }

  liveVersions() {
    return this.statements.versions.all().map((row) => ({
      gameId: String(row['gameId']),
      rulesVersion: Number(row['rulesVersion']),
      rooms: Number(row['rooms']),
    }));
  }

  withPendingJobs(): readonly RoomCode[] {
    return this.statements.pendingJobs.all().map((row) => String(row['code']));
  }

  inputs(code: RoomCode, match: number): readonly LoggedInput[] {
    return this.statements.inputs.all(code, match).map((row) => ({
      match: Number(row['match']),
      revision: Number(row['revision']),
      at: Number(row['at']),
      input: JSON.parse(String(row['input'])) as EngineInput<Json>,
    }));
  }

  prune(now: number): number {
    return Number(this.statements.prune.run(now).changes);
  }

  ping(): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE; ROLLBACK;');
      return true;
    } catch {
      return false;
    }
  }

  async backup(file: string): Promise<void> {
    if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}.`);
    await backup(this.db, file);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      const result = copy.prepare('PRAGMA integrity_check').get()?.['integrity_check'];
      if (result !== 'ok') throw new Error(`The backup failed its integrity check: ${String(result)}`);
    } finally {
      copy.close();
    }
    this.log?.write('info', 'backup_written', {});
  }

  bumpEpochs(): number {
    return Number(this.statements.epochs.run().changes);
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      this.db.close();
    }
  }
}
