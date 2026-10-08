/**
 * In-memory D1 for tests, backed by Node's built-in SQLite (`node:sqlite`).
 *
 * Runs real SQL — UPSERTs, MIN(), compare-and-set UPDATEs — so index helpers
 * are tested against the same semantics D1 gives them, using the real
 * migration files:
 *
 *   const d1 = createSqliteD1(readFileSync(migrationPath, 'utf8'));
 *
 * Covers the D1 surface the index helpers use: prepare/bind/run/all/first and
 * batch (atomic, like D1's).
 */

import { createRequire } from 'node:module';

type SqlValue = null | number | bigint | string | Uint8Array;

/** The slice of `node:sqlite` used here (typed locally: @types/node 20 predates it). */
interface SqliteStatement {
  run(...values: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...values: SqlValue[]): unknown[];
  get(...values: SqlValue[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDatabase;
};

function toSqlValues(values: unknown[]): SqlValue[] {
  return values.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v as SqlValue;
  });
}

export function createSqliteD1(...setupSql: string[]): D1Database {
  const db = new DatabaseSync(':memory:');
  for (const sql of setupSql) db.exec(sql);

  const statement = (query: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(query, next),
    async run() {
      const r = db.prepare(query).run(...toSqlValues(values));
      return {
        success: true,
        results: [],
        meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
      };
    },
    async all() {
      const rows = db.prepare(query).all(...toSqlValues(values));
      return { success: true, results: rows, meta: {} };
    },
    async first(column?: string) {
      const row = db.prepare(query).get(...toSqlValues(values)) as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : row;
    },
  });

  const d1 = {
    prepare: (query: string) => statement(query),
    async batch(statements: Array<ReturnType<typeof statement>>) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return d1 as unknown as D1Database;
}

/** Minimal in-memory KVNamespace (get/put/delete of strings). */
export function createMemoryKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  const kv = {
    store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return kv as unknown as KVNamespace & { store: Map<string, string> };
}
