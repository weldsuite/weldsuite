/**
 * Shared types for the tenant-database move engine.
 *
 * The engine never talks to a driver directly: it takes a {@link TenantSql},
 * which neon-http implements in production (`neon-sql.ts`) and PGlite
 * implements in tests. Everything here is plain JSON data (no Map/Set/Date), so
 * a Cloudflare Workflow can persist catalogs, cursors and saved state as step
 * outputs.
 */

/** Values the engine ever binds as query parameters. */
export type SqlParam = string | number | boolean | null;

/** One result row. Values are whatever the driver returned; the engine casts to text in SQL and parses here. */
export type SqlRow = Record<string, unknown>;

export interface SqlStatement {
  text: string;
  params?: readonly SqlParam[];
}

/**
 * The slice of a Postgres client the engine needs.
 *
 * `transaction` runs the statements in order inside ONE transaction and
 * returns each statement's rows in the same order. On neon-http that is a
 * single HTTP request (one subrequest) however many statements it holds.
 */
export interface TenantSql {
  query(text: string, params?: readonly SqlParam[]): Promise<SqlRow[]>;
  transaction(statements: readonly SqlStatement[]): Promise<SqlRow[][]>;
}

export interface ColumnInfo {
  name: string;
  /** `format_type()` of the column, usable in a column definition list and as a cast target. */
  type: string;
  /**
   * json / jsonb column (or a domain over one). Their values travel as TEXT,
   * because a JSON null and an SQL NULL are indistinguishable once a row went
   * through `row_to_json`.
   */
  json: boolean;
}

export interface TableInfo {
  name: string;
  /** Copyable columns in attnum order (dropped and generated columns excluded). */
  columns: ColumnInfo[];
  /** Primary-key column names in key order. Empty only for a table without a primary key. */
  primaryKey: string[];
  /** `pg_class.reltuples`, null when the table was never analysed. */
  estimatedRows: number | null;
  /** Estimated bytes of one row as JSON text (column widths + JSON key overhead). */
  avgRowBytes: number;
}

export interface ForeignKeyInfo {
  table: string;
  name: string;
  /** `pg_get_constraintdef`, e.g. `FOREIGN KEY (a) REFERENCES t(id) ON DELETE CASCADE`. */
  definition: string;
  /** `convalidated` on the source: a constraint that is NOT VALID there is not validated on the target either. */
  validated: boolean;
}

/** `pg_trigger.tgenabled`: O = origin (the default), D = disabled, R = replica, A = always. */
export type TriggerEnabledMode = 'O' | 'D' | 'R' | 'A';

export interface TriggerInfo {
  table: string;
  name: string;
  enabled: TriggerEnabledMode;
}

export interface MaterializedViewInfo {
  name: string;
  populated: boolean;
}

/** The migrations journal, compared between source and target by count and newest `created_at`, never by tag. */
export interface JournalSummary {
  /** Schema the `__drizzle_migrations` table lives in (`public`, else `drizzle`). */
  schema: string;
  count: number;
  /** `max(created_at)` as text (a bigint), null for an empty journal. */
  maxCreatedAt: string | null;
}

export interface Catalog {
  tables: TableInfo[];
  foreignKeys: ForeignKeyInfo[];
  triggers: TriggerInfo[];
  materializedViews: MaterializedViewInfo[];
  /**
   * Sequences in the tenant schema (serial/identity columns), other than the
   * journal's own. The tenant schema has none; the engine refuses to copy a
   * database that does, because the target's counters would restart from 1.
   */
  sequences: string[];
  /** Null when the database has no `__drizzle_migrations` table at all. */
  journal: JournalSummary | null;
}

/** Everything `prepareTargetForCopy` changed on the target, handed back to `finishTarget`. */
export interface SavedTargetState {
  /** Foreign keys that were dropped (or were about to be) and must come back. */
  foreignKeys: ForeignKeyInfo[];
  /** User triggers on tables that had `DISABLE TRIGGER USER` applied, with their original mode. */
  triggers: TriggerInfo[];
}
