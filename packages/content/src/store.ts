// content.db: the pipeline's records on node:sqlite (content-pipeline.md, "The lifecycle of one
// item"). One row per item, with its status, provenance and validator reports; run records;
// an event log of every status change and staff action; and the overlap lock that keeps two
// runs (the scheduler's and a manual one) from working at once (D-56). WAL mode, so the site
// can read it while the job writes, once /admin needs to.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isJson, type Json } from '@joystyk/contracts';
import * as z from 'zod/mini';

export type ItemStatus = 'scheduled' | 'generating' | 'failed' | 'validated' | 'published' | 'withdrawn';
export type ItemSource = 'generated' | 'bank' | 'staff';
/** Reason codes for a takedown (content-pipeline.md, "Moderation in /admin"). */
export const WITHDRAW_REASONS = ['inaccurate', 'unfair', 'unsafe', 'dull', 'other'] as const;
export type WithdrawReason = (typeof WITHDRAW_REASONS)[number];

export interface ItemRow {
  readonly id: number;
  readonly gameId: string;
  readonly puzzleId: string;
  readonly date: string;
  readonly status: ItemStatus;
  readonly source: ItemSource | null;
  readonly inputs: Json | null;
  readonly seed: string | null;
  readonly model: string | null;
  readonly promptVersion: string | null;
  /** The answer key used for duplicate checks, e.g. the day's word. */
  readonly answer: string | null;
  readonly config: Json | null;
  readonly contentHash: string | null;
  readonly size: number | null;
  readonly attempts: number;
  /** Every attempt's report: calls, validator issues, filter and screen outcomes. */
  readonly report: Json | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly withdrawnReason: string | null;
  readonly withdrawnBy: string | null;
}

export type ItemPatch = Partial<
  Pick<
    ItemRow,
    | 'status'
    | 'source'
    | 'inputs'
    | 'seed'
    | 'model'
    | 'promptVersion'
    | 'answer'
    | 'config'
    | 'contentHash'
    | 'size'
    | 'attempts'
    | 'report'
    | 'publishedAt'
  >
>;

export interface BankChange {
  readonly gameId: string;
  readonly key: string;
  readonly config: Json | null;
  readonly retired: boolean;
  readonly actor: string;
  readonly changedAt: string;
}

export interface RunRow {
  readonly id: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly trigger: string;
  readonly status: 'running' | 'ok' | 'partial' | 'failed' | 'aborted';
  readonly summary: Json | null;
}

/** The schema, one migration per `user_version`. Append; never edit a shipped entry. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE items (
     id INTEGER PRIMARY KEY,
     game_id TEXT NOT NULL,
     puzzle_id TEXT NOT NULL,
     date TEXT NOT NULL,
     status TEXT NOT NULL,
     source TEXT,
     inputs TEXT,
     seed TEXT,
     model TEXT,
     prompt_version TEXT,
     answer TEXT,
     reserved TEXT,
     config TEXT,
     content_hash TEXT,
     size INTEGER,
     attempts INTEGER NOT NULL DEFAULT 0,
     report TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     published_at TEXT,
     withdrawn_at TEXT,
     withdrawn_reason TEXT,
     withdrawn_by TEXT
   );
   CREATE UNIQUE INDEX items_current ON items (puzzle_id) WHERE status <> 'withdrawn';
   CREATE INDEX items_game_date ON items (game_id, date);
   CREATE TABLE runs (
     id INTEGER PRIMARY KEY,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     trigger TEXT NOT NULL,
     status TEXT NOT NULL,
     summary TEXT
   );
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     item_id INTEGER REFERENCES items (id),
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     actor TEXT NOT NULL,
     detail TEXT
   );
   CREATE INDEX events_item ON events (item_id);
   CREATE TABLE locks (
     name TEXT PRIMARY KEY,
     owner TEXT NOT NULL,
     acquired_at TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
  `CREATE TABLE bank_changes (
    game_id TEXT NOT NULL,
    bank_key TEXT NOT NULL,
    config TEXT,
    retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
    actor TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    PRIMARY KEY (game_id, bank_key)
  );`,
];

const iso = (ms: number): string => new Date(ms).toISOString();
const json = (value: Json | null | undefined): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);
const storedJson = z.custom<Json>(isJson);
const parse = (text: unknown): Json | null =>
  typeof text === 'string' ? storedJson.parse(JSON.parse(text) as unknown) : null;
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const toItem = (row: Record<string, unknown>): ItemRow => ({
  id: Number(row['id']),
  gameId: String(row['game_id']),
  puzzleId: String(row['puzzle_id']),
  date: String(row['date']),
  status: String(row['status']) as ItemStatus,
  source: str(row['source']) as ItemSource | null,
  inputs: parse(row['inputs']),
  seed: str(row['seed']),
  model: str(row['model']),
  promptVersion: str(row['prompt_version']),
  answer: str(row['answer']),
  config: parse(row['config']),
  contentHash: str(row['content_hash']),
  size: row['size'] === null || row['size'] === undefined ? null : Number(row['size']),
  attempts: Number(row['attempts']),
  report: parse(row['report']),
  createdAt: String(row['created_at']),
  updatedAt: String(row['updated_at']),
  publishedAt: str(row['published_at']),
  withdrawnAt: str(row['withdrawn_at']),
  withdrawnReason: str(row['withdrawn_reason']),
  withdrawnBy: str(row['withdrawn_by']),
});

const COLUMNS: Readonly<Record<keyof ItemPatch, string>> = {
  status: 'status',
  source: 'source',
  inputs: 'inputs',
  seed: 'seed',
  model: 'model',
  promptVersion: 'prompt_version',
  answer: 'answer',
  config: 'config',
  contentHash: 'content_hash',
  size: 'size',
  attempts: 'attempts',
  report: 'report',
  publishedAt: 'published_at',
};
const JSON_FIELDS = new Set<keyof ItemPatch>(['inputs', 'config', 'report']);

export interface ContentStore {
  readonly path: string;
  bankChanges(gameId: string): readonly BankChange[];
  changeBank(input: {
    readonly gameId: string;
    readonly key: string;
    readonly config: Json | null;
    readonly retired: boolean;
    readonly actor: string;
    readonly now: number;
  }): void;
  /** Atomically archives the prior version and creates a validated staff replacement. */
  replaceItem(input: {
    readonly expectedId: number;
    readonly actor: string;
    readonly note: string;
    readonly now: number;
    readonly source: 'staff' | 'bank';
    readonly inputs?: Json | null;
    readonly status: 'validated' | 'published';
    readonly config: Json;
    readonly answer: string | null;
    readonly hash: string;
    readonly size: number;
  }): ItemRow | null;
  /** The item that currently holds a puzzle id (any status but withdrawn), or null. */
  current(puzzleId: string): ItemRow | null;
  item(id: number): ItemRow | null;
  /** Every item for a puzzle id, oldest first, withdrawn ones included. */
  history(puzzleId: string): ItemRow[];
  createItem(input: {
    gameId: string;
    puzzleId: string;
    date: string;
    inputs: Json;
    seed: string;
    answer: string | null;
    now: number;
  }): ItemRow;
  updateItem(
    id: number,
    patch: ItemPatch,
    now: number,
    event?: { kind: string; actor?: string; detail?: Json },
  ): ItemRow;
  /**
   * Answers used by a game's items dated in [from, to], withdrawn ones included (they count as
   * used), and the answers their schedules reserved, even where a bank item took the slot: a
   * word that failed on one day isn't tried again the next.
   */
  usedAnswers(gameId: string, from: string, to: string): { date: string; answer: string; status: ItemStatus }[];
  /** Published (not withdrawn) items of a game dated in [from, to], by date. */
  published(gameId: string, from: string, to: string): ItemRow[];
  /** Validated items waiting to publish, dated up to `through`. */
  validatedThrough(gameId: string, through: string): ItemRow[];
  /** Items of a game in [from, to] with any status, current ones only, by date. */
  items(gameId: string, from: string, to: string): ItemRow[];
  /** All versions in the date range, including withdrawn content, for repeat checks. */
  versions(gameId: string, from: string, to: string): ItemRow[];
  /** Takes an item down (content-pipeline.md, "Corrections"). Returns the withdrawn row, or null if none held the id. */
  withdraw(puzzleId: string, reason: WithdrawReason, actor: string, now: number, note?: string): ItemRow | null;
  addEvent(itemId: number | null, kind: string, actor: string, now: number, detail?: Json): void;
  events(itemId: number): { at: string; kind: string; actor: string; detail: Json | null }[];
  startRun(trigger: string, now: number): number;
  finishRun(id: number, status: RunRow['status'], summary: Json, now: number): void;
  recentRuns(limit: number): RunRow[];
  /**
   * Takes the named lock for `owner` until `now + ttlMs`, or refreshes it if `owner` holds it.
   * False when someone else holds an unexpired lock. A crashed holder's lock expires.
   */
  tryLock(name: string, owner: string, now: number, ttlMs: number): boolean;
  releaseLock(name: string, owner: string): void;
  lockHolder(name: string, now: number): { owner: string; acquiredAt: string } | null;
  close(): void;
}

export const openStore = (path: string): ContentStore => {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (version > MIGRATIONS.length) {
    db.close();
    throw new Error(
      `content.db has schema version ${String(version)}, newer than this build (${String(MIGRATIONS.length)}). Roll forward, or restore an older backup.`,
    );
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v] ?? '');
      db.exec(`PRAGMA user_version = ${String(v + 1)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Record<string, unknown>[];
  const one = (sql: string, ...params: SQLInputValue[]) =>
    db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const addEvent = (itemId: number | null, kind: string, actor: string, now: number, detail?: Json) => {
    run(
      'INSERT INTO events (item_id, at, kind, actor, detail) VALUES (?, ?, ?, ?, ?)',
      itemId,
      iso(now),
      kind,
      actor,
      json(detail),
    );
  };
  const item = (id: number) => {
    const row = one('SELECT * FROM items WHERE id = ?', id);
    return row === undefined ? null : toItem(row);
  };

  return {
    path,
    current: (puzzleId) => {
      const row = one("SELECT * FROM items WHERE puzzle_id = ? AND status <> 'withdrawn'", puzzleId);
      return row === undefined ? null : toItem(row);
    },
    item,
    history: (puzzleId) => all('SELECT * FROM items WHERE puzzle_id = ? ORDER BY id', puzzleId).map(toItem),
    bankChanges: (gameId) =>
      all('SELECT * FROM bank_changes WHERE game_id = ? ORDER BY bank_key', gameId).map((row) => ({
        gameId: String(row['game_id']),
        key: String(row['bank_key']),
        config: parse(row['config']),
        retired: row['retired'] === 1,
        actor: String(row['actor']),
        changedAt: String(row['changed_at']),
      })),
    changeBank: ({ gameId, key, config, retired, actor, now }) =>
      transaction(() => {
        run(
          'INSERT INTO bank_changes (game_id, bank_key, config, retired, actor, changed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (game_id, bank_key) DO UPDATE SET config = excluded.config, retired = excluded.retired, actor = excluded.actor, changed_at = excluded.changed_at',
          gameId,
          key,
          json(config),
          retired ? 1 : 0,
          actor,
          iso(now),
        );
        addEvent(null, 'bank.changed', actor, now, { gameId, key, retired });
      }),
    replaceItem: (input) =>
      transaction(() => {
        const previous = item(input.expectedId);
        if (previous === null || previous.status === 'withdrawn') return null;
        const at = iso(input.now);
        run(
          "UPDATE items SET status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = 'other', withdrawn_by = ?, updated_at = ? WHERE id = ?",
          at,
          input.actor,
          at,
          previous.id,
        );
        addEvent(previous.id, 'withdrawn', input.actor, input.now, {
          reason: 'other',
          from: previous.status,
          note: input.note || 'Staff correction.',
        });
        const report: Json = [
          {
            checks: {
              staff: {
                schema: true,
                gameValidators: true,
                allAgesFilter: true,
                modelChecks: 'not rerun; human correction',
                previousItem: previous.id,
              },
            },
          },
        ];
        const result = run(
          `INSERT INTO items (game_id, puzzle_id, date, status, source, inputs, seed, answer, reserved, config, content_hash, size, prompt_version, report, created_at, updated_at, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          previous.gameId,
          previous.puzzleId,
          previous.date,
          input.status,
          input.source,
          json(input.inputs === undefined ? previous.inputs : input.inputs),
          previous.seed,
          input.answer,
          input.answer,
          json(input.config),
          input.hash,
          input.size,
          'staff-validated-v1',
          json(report),
          at,
          at,
          input.status === 'published' ? at : null,
        );
        const id = Number(result.lastInsertRowid);
        addEvent(id, input.source === 'bank' ? 'bank.selected' : 'staff.edited', input.actor, input.now, {
          previousItem: previous.id,
          note: input.note,
          hash: input.hash,
        });
        return item(id);
      }),
    createItem: ({ gameId, puzzleId, date, inputs, seed, answer, now }) =>
      transaction(() => {
        const result = run(
          `INSERT INTO items (game_id, puzzle_id, date, status, inputs, seed, answer, reserved, created_at, updated_at)
           VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`,
          gameId,
          puzzleId,
          date,
          json(inputs),
          seed,
          answer,
          answer,
          iso(now),
          iso(now),
        );
        const id = Number(result.lastInsertRowid);
        addEvent(id, 'scheduled', 'content', now, { inputs });
        return item(id) as ItemRow;
      }),
    updateItem: (id, patch, now, event) =>
      transaction(() => {
        const sets: string[] = ['updated_at = ?'];
        const values: SQLInputValue[] = [iso(now)];
        for (const [key, value] of Object.entries(patch) as [keyof ItemPatch, unknown][]) {
          if (value === undefined) continue;
          sets.push(`${COLUMNS[key]} = ?`);
          values.push(JSON_FIELDS.has(key) ? json(value as Json) : (value as SQLInputValue));
        }
        const changed = run(
          `UPDATE items SET ${sets.join(', ')} WHERE id = ? AND status <> 'withdrawn'`,
          ...values,
          id,
        );
        if (changed.changes !== 0 && event !== undefined)
          addEvent(id, event.kind, event.actor ?? 'content', now, event.detail);
        return item(id) as ItemRow;
      }),
    usedAnswers: (gameId, from, to) =>
      all(
        `SELECT date, answer, status FROM items WHERE game_id = ? AND date >= ? AND date <= ? AND answer IS NOT NULL
         UNION SELECT date, reserved, status FROM items WHERE game_id = ? AND date >= ? AND date <= ? AND reserved IS NOT NULL
         ORDER BY date`,
        gameId,
        from,
        to,
        gameId,
        from,
        to,
      ).map((row) => ({
        date: String(row['date']),
        answer: String(row['answer']),
        status: String(row['status']) as ItemStatus,
      })),
    published: (gameId, from, to) =>
      all(
        "SELECT * FROM items WHERE game_id = ? AND status = 'published' AND date >= ? AND date <= ? ORDER BY date",
        gameId,
        from,
        to,
      ).map(toItem),
    validatedThrough: (gameId, through) =>
      all(
        "SELECT * FROM items WHERE game_id = ? AND status = 'validated' AND date <= ? ORDER BY date",
        gameId,
        through,
      ).map(toItem),
    items: (gameId, from, to) =>
      all(
        "SELECT * FROM items WHERE game_id = ? AND status <> 'withdrawn' AND date >= ? AND date <= ? ORDER BY date",
        gameId,
        from,
        to,
      ).map(toItem),
    versions: (gameId, from, to) =>
      all('SELECT * FROM items WHERE game_id = ? AND date >= ? AND date <= ? ORDER BY date, id', gameId, from, to).map(
        toItem,
      ),
    withdraw: (puzzleId, reason, actor, now, note) =>
      transaction(() => {
        const row = one("SELECT * FROM items WHERE puzzle_id = ? AND status <> 'withdrawn'", puzzleId);
        if (row === undefined) return null;
        const before = toItem(row);
        run(
          "UPDATE items SET status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = ?, withdrawn_by = ?, updated_at = ? WHERE id = ?",
          iso(now),
          reason,
          actor,
          iso(now),
          before.id,
        );
        addEvent(before.id, 'withdrawn', actor, now, {
          reason,
          from: before.status,
          ...(note === undefined ? {} : { note }),
        });
        return item(before.id);
      }),
    addEvent,
    events: (itemId) =>
      all('SELECT at, kind, actor, detail FROM events WHERE item_id = ? ORDER BY id', itemId).map((row) => ({
        at: String(row['at']),
        kind: String(row['kind']),
        actor: String(row['actor']),
        detail: parse(row['detail']),
      })),
    startRun: (trigger, now) =>
      Number(
        run("INSERT INTO runs (started_at, trigger, status) VALUES (?, ?, 'running')", iso(now), trigger)
          .lastInsertRowid,
      ),
    finishRun: (id, status, summary, now) => {
      run('UPDATE runs SET finished_at = ?, status = ?, summary = ? WHERE id = ?', iso(now), status, json(summary), id);
    },
    recentRuns: (limit) =>
      all('SELECT * FROM runs ORDER BY id DESC LIMIT ?', limit).map((row) => ({
        id: Number(row['id']),
        startedAt: String(row['started_at']),
        finishedAt: str(row['finished_at']),
        trigger: String(row['trigger']),
        status: String(row['status']) as RunRow['status'],
        summary: parse(row['summary']),
      })),
    tryLock: (name, owner, now, ttlMs) =>
      transaction(() => {
        const row = one('SELECT owner, expires_at FROM locks WHERE name = ?', name);
        if (row !== undefined && row['owner'] !== owner && Number(row['expires_at']) > now) return false;
        run(
          `INSERT INTO locks (name, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at,
             acquired_at = CASE WHEN locks.owner = excluded.owner THEN locks.acquired_at ELSE excluded.acquired_at END`,
          name,
          owner,
          iso(now),
          now + ttlMs,
        );
        return true;
      }),
    releaseLock: (name, owner) => {
      run('DELETE FROM locks WHERE name = ? AND owner = ?', name, owner);
    },
    lockHolder: (name, now) => {
      const row = one('SELECT owner, acquired_at, expires_at FROM locks WHERE name = ?', name);
      return row === undefined || Number(row['expires_at']) <= now
        ? null
        : { owner: String(row['owner']), acquiredAt: String(row['acquired_at']) };
    },
    close: () => {
      if (db.isOpen) db.close();
    },
  };
};
