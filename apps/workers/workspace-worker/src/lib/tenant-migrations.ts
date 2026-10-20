/**
 * Tenant-database migration applier, shared by ProvisionWorkspaceWorkflow
 * (on-demand provisioning), RefillPoolWorkflow (warm-slot preparation and
 * catch-up) and the database move. Idempotent: tracks applied migrations in
 * "__drizzle_migrations" and only applies the pending delta.
 *
 * Each migration is applied atomically: its statements and its
 * "__drizzle_migrations" row run as ONE transaction (on neon-http, one HTTP
 * request). A call that dies midway (a step limit, a Neon error) leaves every
 * migration either applied and recorded or not there at all, so a retry
 * starts the unfinished one from a clean slate. Applied statement by statement,
 * a migration could be half there yet unrecorded, and every retry then failed
 * on its first statement (42P07 duplicate_table) for good.
 */

import { matchTenantJournal, type TenantJournalEntry } from '@weldsuite/db/lib/tenant-journal';
import { MIGRATION_JOURNAL, MIGRATION_SQL, MIGRATION_HASHES } from '../generated/tenant-migrations';
import { sqlStateOf } from './database-move/pg-errors';
import type { SqlRow, SqlStatement, TenantSql } from './database-move/types';

/** Latest bundled migration tag — the pool's target schema version. */
export const LATEST_SCHEMA_VERSION: string | undefined =
  MIGRATION_JOURNAL.at(-1)?.tag;

export interface ApplyMigrationsOptions {
  /**
   * Soft cap on SQL statements executed in one call. Callers running inside a
   * Cloudflare Workflow step should set this: it bounds the Postgres work one
   * step attempt waits on (the full journal is ~2,600 statements), and so what
   * a failed attempt has to redo. Subrequests no longer run out first: a call
   * makes one request for the journal table plus one per migration applied.
   * At least one migration is always applied per call, so a single oversized
   * migration still makes progress.
   */
  statementBudget?: number;
}

export interface ApplyMigrationsResult {
  applied: number;
  skipped: number;
  /** Pending migrations left after this call; 0 = database fully migrated. */
  remaining: number;
}

// Created and widened in the same request that reads it. drizzle's own
// migrator creates the table without the tag column.
const JOURNAL_TABLE: readonly SqlStatement[] = [
  {
    text: `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      tag text
    )`,
  },
  { text: `ALTER TABLE "__drizzle_migrations" ADD COLUMN IF NOT EXISTS tag text` },
  { text: `SELECT tag, hash, created_at::text AS created_at FROM "__drizzle_migrations"` },
];

const RECORD_MIGRATION = `INSERT INTO "__drizzle_migrations" (hash, created_at, tag) VALUES ($1, $2, $3)`;

export async function applyTenantMigrations(
  sql: TenantSql,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  // Which migrations are already applied (idempotent on retry). A row may name its migration by tag (written
  // here), by hash or only by created_at (drizzle's migrator), so every row is matched against the journal; a
  // migration already recorded is never applied or recorded again.
  const [, , recorded = []] = await sql.transaction(JOURNAL_TABLE);
  const match = matchTenantJournal(
    (recorded as Array<SqlRow & { tag: string | null; hash: string | null; created_at: string | null }>).map((r) => ({
      tag: r.tag,
      hash: r.hash,
      createdAt: r.created_at,
    })),
    bundledJournalEntries(),
  );
  const missing = new Set(match.missing.map((entry) => entry.tag));
  const pending = MIGRATION_JOURNAL.filter((m) => missing.has(m.tag));

  if (pending.length === 0) {
    return { applied: 0, skipped: MIGRATION_JOURNAL.length, remaining: 0 };
  }

  const budget = options.statementBudget ?? Infinity;
  let executed = 0;
  let appliedCount = 0;

  for (const m of pending) {
    if (appliedCount > 0 && executed >= budget) break;

    const statements = splitMigration(MIGRATION_SQL[m.tag] ?? '');
    const refused = findNonTransactionalStatement(statements);
    if (refused) {
      throw new TenantMigrationError(m.tag, statements.length, { refusedAt: refused.statement, reason: refused.reason });
    }

    try {
      await sql.transaction([
        ...statements.map((text) => ({ text })),
        { text: RECORD_MIGRATION, params: [MIGRATION_HASHES[m.tag] ?? '', m.when, m.tag] },
      ]);
    } catch (error) {
      throw new TenantMigrationError(m.tag, statements.length, { cause: error });
    }

    executed += statements.length + 1;
    appliedCount++;
  }

  return { applied: appliedCount, skipped: match.applied.size, remaining: pending.length - appliedCount };
}

/** The bundled journal as `matchTenantJournal` takes it. */
export function bundledJournalEntries(): TenantJournalEntry[] {
  return MIGRATION_JOURNAL.map((m) => ({ tag: m.tag, when: m.when, hash: MIGRATION_HASHES[m.tag] ?? '' }));
}

/**
 * A migration file's statements. Neon HTTP runs one statement per query, so
 * the file is split on Drizzle's `--> statement-breakpoint` marker; splitting
 * on `;\n` is unsafe because it shreds PL/pgSQL `DO $$ ... $$` blocks.
 */
export function splitMigration(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Comments, string literals and dollar-quoted bodies: blanked out before a
// statement is classified, so a comment that mentions CONCURRENTLY (0175 has
// one) or a function body does not count as the statement itself. One
// alternation, so whichever starts first wins (a quote inside a comment).
const NOT_CODE = new RegExp(
  [
    String.raw`--[^\n]*`, // line comment
    String.raw`/\*[\s\S]*?\*/`, // block comment
    String.raw`'(?:[^']|'')*'`, // string literal
    String.raw`(\$(?:[A-Za-z_]\w*)?\$)[\s\S]*?\1`, // dollar-quoted body ($$ or $tag$)
  ].join('|'),
  'g',
);

/**
 * Statements Postgres refuses inside a transaction block, or that would end the
 * migration's transaction early. A migration holding one cannot be applied
 * atomically, so it is refused before any of it runs. drizzle's migrator
 * (apps/tools/migrate-databases) wraps migrations in a transaction too, so such
 * a migration could not reach existing tenants either.
 *
 * `ALTER TYPE ... ADD VALUE` is deliberately not here: since PostgreSQL 12 it
 * runs inside a transaction (tenant projects run 16). The new value cannot be
 * used before the transaction commits, so a later statement of the same
 * migration must not use it; Postgres fails that with 55P04 and the whole
 * migration rolls back.
 */
const NON_TRANSACTIONAL: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // CREATE/DROP INDEX, REINDEX and DETACH PARTITION ... CONCURRENTLY. REFRESH
  // MATERIALIZED VIEW CONCURRENTLY is the one that may run in a transaction.
  { pattern: /^(?!REFRESH MATERIALIZED VIEW\b).*\bCONCURRENTLY\b/i, reason: 'a CONCURRENTLY operation' },
  { pattern: /^REINDEX (\(.*\) )?(SCHEMA|DATABASE|SYSTEM)\b/i, reason: 'REINDEX of a schema, database or system' },
  { pattern: /^VACUUM\b/i, reason: 'VACUUM' },
  { pattern: /^(CREATE|DROP) (DATABASE|TABLESPACE)\b/i, reason: 'CREATE/DROP DATABASE or TABLESPACE' },
  { pattern: /^ALTER SYSTEM\b/i, reason: 'ALTER SYSTEM' },
  {
    pattern: /^(BEGIN|START TRANSACTION|COMMIT|END|ROLLBACK|ABORT|PREPARE TRANSACTION)\b/i,
    reason: 'transaction control',
  },
];

/** The first statement that cannot run inside the migration's transaction (1-based), or null. */
export function findNonTransactionalStatement(
  statements: readonly string[],
): { statement: number; reason: string } | null {
  for (const [index, statement] of statements.entries()) {
    const code = statement.replace(NOT_CODE, ' ').replace(/\s+/g, ' ').trim();
    const hit = NON_TRANSACTIONAL.find(({ pattern }) => pattern.test(code));
    if (hit) return { statement: index + 1, reason: hit.reason };
  }
  return null;
}

/** Why a migration was not applied: its transaction failed, or it was refused before it ran. */
type TenantMigrationProblem = { cause: unknown } | { refusedAt: number; reason: string };

function describeProblem(tag: string, statements: number, problem: TenantMigrationProblem, state: string | null): string {
  if ('refusedAt' in problem) {
    return `Tenant migration ${tag} cannot run inside a transaction: statement ${problem.refusedAt} of ${statements} ` +
      `is ${problem.reason}. Nothing was applied`;
  }
  const count = statements === 1 ? '1 statement' : `${statements} statements`;
  const suffix = state ? ', SQLSTATE ' + state : '';
  return `Tenant migration ${tag} failed (${count} in one transaction${suffix})`;
}

/**
 * A tenant migration was not applied: Postgres rejected its transaction (the
 * migration rolled back whole), or it was refused before anything ran because
 * a statement cannot run inside a transaction. Names the migration, with the
 * SQLSTATE only: a driver message can quote values.
 */
export class TenantMigrationError extends Error {
  /** SQLSTATE Postgres failed the migration with; null when refused here or when no answer came back. */
  readonly sqlState: string | null;
  /** 1-based statement a migration was refused at; null when it ran and failed (a transaction does not say where). */
  readonly statement: number | null;

  constructor(
    readonly tag: string,
    readonly statements: number,
    problem: TenantMigrationProblem,
  ) {
    const state = 'cause' in problem ? sqlStateOf(problem.cause) ?? null : null;
    super(describeProblem(tag, statements, problem, state), 'cause' in problem ? { cause: problem.cause } : undefined);
    this.name = 'TenantMigrationError';
    this.sqlState = state;
    this.statement = 'refusedAt' in problem ? problem.refusedAt : null;
  }
}
