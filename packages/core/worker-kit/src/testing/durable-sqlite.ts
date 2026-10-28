/**
 * In-memory SQLite-backed Durable Object storage for tests, built on Node's
 * built-in SQLite (`node:sqlite`). Mirrors the parts of `ctx.storage` that
 * `MailboxObject` (and the OutboundLedger's mail index, task A5) need: the SQL
 * API (`ctx.storage.sql`), `transactionSync`/`transaction`, the synchronous
 * and asynchronous KV API, alarms, and `deleteAll()` — closely enough to unit
 * test Durable Object code in vitest's `node` environment, without workerd.
 *
 * Style follows `./d1.ts`: build a small, honestly-typed implementation, then
 * cast it to the real ambient Cloudflare type (`@cloudflare/workers-types`,
 * already global in this package's tsconfig) at the boundary, the same way
 * `d1.ts` casts its object to `D1Database`.
 *
 * Usage:
 *
 *   const state = createSqliteDurableObjectState();
 *   const object = new MailboxObject(state, env);
 *   ...
 *   const ran = await fireAlarm(state, object); // runs a pending alarm now
 *
 * Deviations from real workerd are called out inline with "Deviation:" and
 * summarised in the worktree's final report. The short version:
 *   - Cursors are materialised eagerly (`exec()` runs the statement to
 *     completion immediately), so `rowsRead`/`rowsWritten` are final from the
 *     moment the cursor is returned instead of growing as you iterate, and a
 *     partially-consumed cursor still has run the whole query.
 *   - `rowsRead` is approximated as "rows the query produced"; workerd's real
 *     accounting (b-tree rows scanned, which can exceed rows returned for an
 *     UPDATE/DELETE with a WHERE clause) isn't observable through node:sqlite.
 *   - `fireAlarm()` always runs a pending alarm immediately (like the
 *     `cloudflare:test` `runDurableObjectAlarm()` helper) regardless of the
 *     scheduled time, and does not implement retry-with-backoff on failure:
 *     the alarm is cleared before the handler runs and a thrown error simply
 *     propagates to the caller.
 *   - `deleteAll()` does not also clear the alarm (matching workerd's
 *     pre-2026-02-24-compatibility-date default; call `deleteAlarm()`
 *     separately, same as the DO docs recommend for that default).
 *   - The hidden `__cf_kv` table backing the KV API is a real SQLite table,
 *     but — unlike workerd — this fake does not block `sql.exec()` from
 *     reading it directly.
 *   - `storage.transaction()`'s `txn` parameter forwards straight to the
 *     same storage (workerd calls the SQLite-backend `txn` object
 *     "obsolete" for exactly this reason); `txn.rollback()` is supported but
 *     is a best-effort shim, not exercised by workerd's own test suite.
 */

import { createRequire } from 'node:module';
import * as v8 from 'node:v8';

// ---- node:sqlite surface used here (typed locally: @types/node 20 predates it) ----

type SqlBindable = null | number | bigint | string | Buffer;

interface SqliteColumnInfo {
  name: string;
}

interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  run(...params: SqlBindable[]): SqliteRunResult;
  all(...params: SqlBindable[]): Record<string, unknown>[];
  get(...params: SqlBindable[]): Record<string, unknown> | undefined;
  columns(): SqliteColumnInfo[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readBigInts?: boolean }) => SqliteDatabase;
};

// ---- statement splitting (workerd's documented multi-statement exec()) ----
//
// "query can contain ? placeholders... Multiple SQL statements, separated
// with a semicolon, can be executed in the query. With multiple SQL
// statements, any parameter bindings are applied to the last SQL statement in
// the query, and the returned cursor is only for the last SQL statement."
// (https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec)
//
// node:sqlite's `prepare()` silently only compiles the *first* statement of a
// multi-statement string, the opposite of workerd, so this fake splits the
// string itself and executes all-but-last via `db.exec()` (no bindings, as
// workerd documents) and the last via `db.prepare()` with the bindings.

const TRANSACTION_STATEMENT = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** Splits a SQL string on top-level `;`, respecting quoted strings, bracket/backtick identifiers, and comments. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '[') {
      current += ch;
      i++;
      while (i < sql.length && sql[i] !== ']') current += sql[i++];
      if (i < sql.length) {
        current += sql[i];
        i++;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') current += sql[i++];
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      current += sql[i++];
      current += sql[i++];
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) current += sql[i++];
      if (i < sql.length) {
        current += sql[i++];
        current += sql[i++];
      }
      continue;
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

function assertNotTransactionStatement(statement: string): void {
  if (TRANSACTION_STATEMENT.test(statement)) {
    throw new TypeError(
      'sql.exec() cannot execute transaction-related statements like BEGIN TRANSACTION or SAVEPOINT. ' +
        'Instead, use ctx.storage.transaction() or ctx.storage.transactionSync() to start a transaction.',
    );
  }
}

// ---- binding and row-value conversion ----
//
// Deviation: workerd documents `SqlStorageValue` (the *column/result* type) as
// `ArrayBuffer | string | number | null`. This fake also accepts `bigint` as
// an input *binding* (for 64-bit integers that don't fit a JS `number`), then
// converts bigint results back to `number` on the way out — lossy for values
// beyond 2^53, which mirrors the documented "JavaScript's 52-bit precision"
// caveat, rather than workerd's hypothetical alternative of throwing.

function toSqliteBinding(value: unknown, index: number): SqlBindable {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const got = value === undefined ? 'undefined' : typeof value;
  throw new TypeError(
    `sql.exec(): parameter ${index + 1} cannot be bound. SQL bindings only support ArrayBuffer, string, number, ` +
      `bigint, or null; got ${got}.`,
  );
}

function fromSqliteValue(value: unknown): SqlStorageValue {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return value as SqlStorageValue;
}

function mapRow(row: Record<string, unknown>): Record<string, SqlStorageValue> {
  const out: Record<string, SqlStorageValue> = {};
  for (const key of Object.keys(row)) out[key] = fromSqliteValue(row[key]);
  return out;
}

function totalChanges(db: SqliteDatabase): number {
  const row = db.prepare('SELECT total_changes() AS c').get();
  return Number((row as { c: number | bigint }).c);
}

// ---- cursor ----

class FakeSqlStorageCursor<T> {
  private index = 0;
  constructor(
    private readonly rows: Record<string, SqlStorageValue>[],
    readonly columnNames: string[],
    readonly rowsRead: number,
    readonly rowsWritten: number,
  ) {}

  next(): { done?: false; value: T } | { done: true; value?: undefined } {
    if (this.index >= this.rows.length) return { done: true, value: undefined };
    return { done: false, value: this.rows[this.index++] as T };
  }

  toArray(): T[] {
    const rest = this.rows.slice(this.index) as T[];
    this.index = this.rows.length;
    return rest;
  }

  one(): T {
    const remaining = this.toArray();
    if (remaining.length !== 1) {
      throw new Error(`SqlStorageCursor.one() expects exactly one result, but the query produced ${remaining.length}.`);
    }
    return remaining[0] as T;
  }

  raw<U extends SqlStorageValue[]>(): IterableIterator<U> & { toArray(): U[] } {
    const self = this;
    const toRaw = (row: Record<string, SqlStorageValue>): U => self.columnNames.map((name) => row[name]) as U;
    const rawIterator: IterableIterator<U> & { toArray(): U[] } = {
      next(): IteratorResult<U> {
        const r = self.next();
        if (r.done) return { done: true, value: undefined };
        return { done: false, value: toRaw(r.value as unknown as Record<string, SqlStorageValue>) };
      },
      toArray(): U[] {
        return self.toArray().map((row) => toRaw(row as unknown as Record<string, SqlStorageValue>));
      },
      [Symbol.iterator](): IterableIterator<U> {
        return rawIterator;
      },
    };
    return rawIterator;
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this as unknown as IterableIterator<T>;
  }
}

function execOn<T>(db: SqliteDatabase, query: string, bindings: unknown[]): FakeSqlStorageCursor<T> {
  const statements = splitStatements(query);
  if (statements.length === 0) throw new Error('sql.exec(): empty query.');
  for (const statement of statements) assertNotTransactionStatement(statement);

  for (let i = 0; i < statements.length - 1; i++) db.exec(statements[i] as string);

  const lastStatement = statements[statements.length - 1] as string;
  const mapped = bindings.map((b, i) => toSqliteBinding(b, i));
  const stmt = db.prepare(lastStatement);

  const before = totalChanges(db);
  const rawRows = stmt.all(...mapped);
  const rowsWritten = totalChanges(db) - before;
  const rows = rawRows.map(mapRow);
  const columnNames = stmt.columns().map((c) => c.name);

  return new FakeSqlStorageCursor<T>(rows, columnNames, rows.length, rowsWritten);
}

function databaseSizeOf(db: SqliteDatabase): number {
  const pageCount = Number((db.prepare('PRAGMA page_count').get() as { page_count: number | bigint }).page_count);
  const pageSize = Number((db.prepare('PRAGMA page_size').get() as { page_size: number | bigint }).page_size);
  return pageCount * pageSize;
}

// ---- KV API (hidden `__cf_kv` table, matching workerd's documented backing) ----

const KV_TABLE = '__cf_kv';

function ensureKvTable(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${KV_TABLE} (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID`);
}

/** Node has no built-in "structured clone to bytes"; `node:v8`'s serializer round-trips the same broad set of types. */
function kvEncode(value: unknown): Buffer {
  return v8.serialize(value);
}
function kvDecode(raw: Uint8Array): unknown {
  return v8.deserialize(Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
}

function kvGetSync(db: SqliteDatabase, key: string): unknown {
  const row = db.prepare(`SELECT value FROM ${KV_TABLE} WHERE key = ?`).get(key) as { value: Uint8Array } | undefined;
  return row ? kvDecode(row.value) : undefined;
}

function kvPutSync(db: SqliteDatabase, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO ${KV_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, kvEncode(value));
}

function kvDeleteSync(db: SqliteDatabase, key: string): boolean {
  const info = db.prepare(`DELETE FROM ${KV_TABLE} WHERE key = ?`).run(key);
  return Number(info.changes) > 0;
}

interface KvListOptions {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function kvList(db: SqliteDatabase, options: KvListOptions = {}): Map<string, unknown> {
  if (options.start !== undefined && options.startAfter !== undefined) {
    throw new TypeError('list(): "start" and "startAfter" cannot be used simultaneously.');
  }
  const clauses: string[] = [];
  const params: SqlBindable[] = [];
  if (options.start !== undefined) {
    clauses.push('key >= ?');
    params.push(options.start);
  }
  if (options.startAfter !== undefined) {
    clauses.push('key > ?');
    params.push(options.startAfter);
  }
  if (options.end !== undefined) {
    clauses.push('key < ?');
    params.push(options.end);
  }
  if (options.prefix !== undefined) {
    clauses.push("key LIKE ? ESCAPE '\\'");
    params.push(`${escapeLike(options.prefix)}%`);
  }
  let sql = `SELECT key, value FROM ${KV_TABLE}`;
  if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ` ORDER BY key ${options.reverse ? 'DESC' : 'ASC'}`;
  if (options.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  const rows = db.prepare(sql).all(...params) as { key: string; value: Uint8Array }[];
  const result = new Map<string, unknown>();
  for (const row of rows) result.set(row.key, kvDecode(row.value));
  return result;
}

async function storageGet(db: SqliteDatabase, keyOrKeys: string | string[]): Promise<unknown> {
  if (Array.isArray(keyOrKeys)) {
    if (keyOrKeys.length > 128) throw new RangeError('get(): supports up to 128 keys at a time.');
    const result = new Map<string, unknown>();
    for (const key of [...keyOrKeys].sort()) {
      const value = kvGetSync(db, key);
      if (value !== undefined) result.set(key, value);
    }
    return result;
  }
  return kvGetSync(db, keyOrKeys);
}

async function storagePut(db: SqliteDatabase, keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
  if (typeof keyOrEntries === 'string') {
    kvPutSync(db, keyOrEntries, value);
    return;
  }
  for (const [key, val] of Object.entries(keyOrEntries)) kvPutSync(db, key, val);
}

async function storageDelete(db: SqliteDatabase, keyOrKeys: string | string[]): Promise<boolean | number> {
  if (Array.isArray(keyOrKeys)) {
    let count = 0;
    for (const key of keyOrKeys) if (kvDeleteSync(db, key)) count++;
    return count;
  }
  return kvDeleteSync(db, keyOrKeys);
}

/** Thrown by `txn.rollback()` inside `storage.transaction()`; caught internally, never surfaced to the caller. */
class TransactionRollback extends Error {}

// ---- backend: the mutable db handle behind one fake Durable Object state ----

class SqliteBackend {
  db: SqliteDatabase;
  txDepth = 0;

  constructor() {
    this.db = new DatabaseSync(':memory:', { readBigInts: true });
    ensureKvTable(this.db);
  }

  /** Durable Objects' `deleteAll()`: atomically empties both SQL and KV data. */
  reset(): void {
    this.db.close?.();
    this.db = new DatabaseSync(':memory:', { readBigInts: true });
    ensureKvTable(this.db);
  }
}

// ---- public types ----

export interface CreateSqliteDurableObjectStateOptions {
  /** Defaults to a random id string. */
  id?: string;
  /** `idFromName()`-style name, surfaced on the fake id for assertions. */
  name?: string;
  /** Surfaced on the returned state for assertions; has no other effect (one in-memory db per state). */
  jurisdiction?: string;
}

/** Test-only members this fake adds on top of the real `DurableObjectState` shape, for draining background work. */
export interface SqliteDurableObjectTestExtras {
  __waitUntilPromises: Promise<unknown>[];
}

function createId(opts: CreateSqliteDurableObjectStateOptions) {
  const value = opts.id ?? (opts.name ? `name:${opts.name}` : `id:${Math.random().toString(36).slice(2)}`);
  return {
    name: opts.name,
    toString: () => value,
    equals: (other: unknown) => String(other) === value,
  };
}

/**
 * Builds a fake `DurableObjectState` backed by an in-memory `node:sqlite`
 * database: `state.storage.sql` for the SQL API, `state.storage.get/put/
 * delete/list` and `state.storage.kv.*` for the KV API, `state.storage.
 * getAlarm/setAlarm/deleteAlarm` and `state.storage.deleteAll()`.
 *
 * Construct your Durable Object with it directly:
 *
 *   const state = createSqliteDurableObjectState();
 *   const object = new MailboxObject(state, env);
 */
export function createSqliteDurableObjectState(
  opts: CreateSqliteDurableObjectStateOptions = {},
): DurableObjectState & SqliteDurableObjectTestExtras {
  const backend = new SqliteBackend();
  const alarm: { time: number | null } = { time: null };
  const waitUntilPromises: Promise<unknown>[] = [];

  const sql = {
    exec: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) =>
      execOn<T>(backend.db, query, bindings) as unknown as SqlStorageCursor<T>,
    get databaseSize(): number {
      return databaseSizeOf(backend.db);
    },
  };

  const kv = {
    get: <T = unknown>(key: string): T | undefined => kvGetSync(backend.db, key) as T | undefined,
    put: <T>(key: string, value: T): void => kvPutSync(backend.db, key, value),
    delete: (key: string): boolean => kvDeleteSync(backend.db, key),
    list: <T = unknown>(options?: KvListOptions): Map<string, T> => kvList(backend.db, options) as Map<string, T>,
  };

  function runTransactionSync<T>(closure: () => T): T {
    const isTop = backend.txDepth === 0;
    if (isTop) backend.db.exec('BEGIN');
    backend.txDepth++;
    try {
      const result = closure();
      backend.txDepth--;
      if (backend.txDepth === 0) backend.db.exec('COMMIT');
      return result;
    } catch (err) {
      backend.txDepth--;
      if (backend.txDepth === 0) backend.db.exec('ROLLBACK');
      throw err;
    }
  }

  // The `txn` passed to `transaction()`'s closure just forwards to the same
  // storage: workerd calls the SQLite-backend `txn` object "obsolete" for
  // exactly this reason (every direct `ctx.storage` call inside the closure
  // is already part of the one transaction).
  async function runTransaction<T>(closure: (txn: typeof txnFacade) => Promise<T>): Promise<T> {
    const isTop = backend.txDepth === 0;
    if (isTop) backend.db.exec('BEGIN');
    backend.txDepth++;
    try {
      const result = await closure(txnFacade);
      backend.txDepth--;
      if (backend.txDepth === 0) backend.db.exec('COMMIT');
      return result;
    } catch (err) {
      backend.txDepth--;
      if (backend.txDepth === 0) backend.db.exec('ROLLBACK');
      if (err instanceof TransactionRollback) return undefined as unknown as T;
      throw err;
    }
  }

  const txnFacade = {
    get: (keyOrKeys: string | string[]) => storageGet(backend.db, keyOrKeys),
    put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) => storagePut(backend.db, keyOrEntries, value),
    delete: (keyOrKeys: string | string[]) => storageDelete(backend.db, keyOrKeys),
    list: async (options?: KvListOptions) => kvList(backend.db, options),
    getAlarm: async () => alarm.time,
    setAlarm: async (scheduledTime: number | Date) => {
      alarm.time = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    },
    deleteAlarm: async () => {
      alarm.time = null;
    },
    rollback: (): never => {
      throw new TransactionRollback('Transaction rolled back.');
    },
  };

  const storage = {
    sql: sql as unknown as SqlStorage,
    kv: kv as unknown as SyncKvStorage,
    get: (keyOrKeys: string | string[]) => storageGet(backend.db, keyOrKeys),
    put: (keyOrEntries: string | Record<string, unknown>, value?: unknown) => storagePut(backend.db, keyOrEntries, value),
    delete: (keyOrKeys: string | string[]) => storageDelete(backend.db, keyOrKeys),
    list: async (options?: KvListOptions) => kvList(backend.db, options),
    deleteAll: async () => {
      backend.reset();
    },
    getAlarm: async () => alarm.time,
    setAlarm: async (scheduledTime: number | Date) => {
      alarm.time = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
    },
    deleteAlarm: async () => {
      alarm.time = null;
    },
    sync: async () => undefined,
    transactionSync: runTransactionSync,
    transaction: runTransaction,
    getCurrentBookmark: async () => '',
    getBookmarkForTime: async () => '',
    onNextSessionRestoreBookmark: async (bookmark: string) => bookmark,
  };

  const id = createId(opts);

  const state = {
    id,
    storage,
    jurisdiction: opts.jurisdiction,
    props: undefined,
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>): Promise<T> => callback(),
    waitUntil: (promise: Promise<unknown>): void => {
      waitUntilPromises.push(promise);
    },
    abort: () => undefined,
    __waitUntilPromises: waitUntilPromises,
  };

  return state as unknown as DurableObjectState & SqliteDurableObjectTestExtras;
}

/**
 * Runs a Durable Object's pending alarm immediately, like `cloudflare:test`'s
 * `runDurableObjectAlarm()`. Returns `false` with no effect if no alarm is
 * scheduled. Clears the alarm before invoking the handler (so an alarm that
 * reschedules itself sees a clean slate), and does not retry on failure: a
 * thrown error from `object.alarm()` propagates to the caller.
 */
export async function fireAlarm(
  state: DurableObjectState,
  object: { alarm?: (alarmInfo?: { retryCount: number; isRetry: boolean }) => Promise<void> | void },
): Promise<boolean> {
  const time = await state.storage.getAlarm();
  if (time === null) return false;
  await state.storage.deleteAlarm();
  if (typeof object.alarm !== 'function') {
    throw new TypeError('fireAlarm(): the object has no alarm() method.');
  }
  await object.alarm({ retryCount: 0, isRetry: false });
  return true;
}
