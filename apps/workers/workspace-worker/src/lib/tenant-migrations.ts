/**
 * Tenant-database migration applier, shared by ProvisionWorkspaceWorkflow
 * (on-demand provisioning) and RefillPoolWorkflow (warm-slot preparation and
 * catch-up). Idempotent: tracks applied migrations in "__drizzle_migrations"
 * and only applies the pending delta.
 */

import { sql as rawSql } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { MIGRATION_JOURNAL, MIGRATION_SQL, MIGRATION_HASHES } from '../generated/tenant-migrations';

/** Latest bundled migration tag — the pool's target schema version. */
export const LATEST_SCHEMA_VERSION: string | undefined =
  MIGRATION_JOURNAL[MIGRATION_JOURNAL.length - 1]?.tag;

export interface ApplyMigrationsOptions {
  /**
   * Soft cap on SQL statements executed in one call. Callers running inside a
   * Cloudflare Workflow step MUST set this: every statement is one neon-http
   * subrequest, and a step attempt that runs the full journal (~2,600
   * statements) blows the per-invocation subrequest/CPU limits and dies with
   * an opaque WorkflowInternalError. At least one migration is always applied
   * per call, so a single oversized migration still makes progress.
   */
  statementBudget?: number;
}

export interface ApplyMigrationsResult {
  applied: number;
  skipped: number;
  /** Pending migrations left after this call; 0 = database fully migrated. */
  remaining: number;
}

// The db only needs `execute`; accept any drizzle neon-http instance.
type TenantDb = Pick<NeonHttpDatabase<Record<string, unknown>>, 'execute'>;

export async function applyTenantMigrations(
  db: TenantDb,
  options: ApplyMigrationsOptions = {},
): Promise<ApplyMigrationsResult> {
  // Create Drizzle migrations tracking table
  await db.execute(rawSql.raw(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      tag text
    )
  `));

  // Check which migrations are already applied (idempotent on retry)
  const applied = await db.execute(rawSql.raw(
    `SELECT tag FROM "__drizzle_migrations" WHERE tag IS NOT NULL`
  ));
  const appliedTags = new Set(
    (applied.rows as Array<{ tag: string }>).map((r) => r.tag)
  );

  const pending = MIGRATION_JOURNAL.filter((m) => !appliedTags.has(m.tag));

  if (pending.length === 0) {
    return { applied: 0, skipped: MIGRATION_JOURNAL.length, remaining: 0 };
  }

  const budget = options.statementBudget ?? Infinity;
  let executed = 0;
  let appliedCount = 0;

  // Neon HTTP doesn't support multi-statement queries.
  // Split on Drizzle's `--> statement-breakpoint` marker — splitting on
  // `;\n` is unsafe because it shreds PL/pgSQL `DO $$ ... $$` blocks.
  for (const m of pending) {
    if (appliedCount > 0 && executed >= budget) break;

    const statements = MIGRATION_SQL[m.tag]
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await db.execute(rawSql.raw(stmt));
    }

    const hash = MIGRATION_HASHES[m.tag];
    await db.execute(
      rawSql`INSERT INTO "__drizzle_migrations" (hash, created_at, tag) VALUES (${hash}, ${m.when}, ${m.tag})`
    );

    executed += statements.length + 1;
    appliedCount++;
  }

  return { applied: appliedCount, skipped: appliedTags.size, remaining: pending.length - appliedCount };
}
