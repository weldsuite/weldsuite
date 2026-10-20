/**
 * Migrations drizzle's migrator skipped.
 *
 * `migrate()` applies only migrations NEWER than the newest row in
 * `__drizzle_migrations`, so a migration merged with an older timestamp than
 * one a database already ran is never applied to it (0081 on the oldest test
 * tenants, task 1150). This reads each database's rows, judges them migration
 * by migration against the journal (`matchTenantJournal`, shared with the
 * workspace worker), and, only when asked, applies what is missing in journal
 * order, each migration in its own transaction, recording it with its tag.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type postgres from 'postgres';
import {
  matchTenantJournal,
  type RecordedMigration,
  type TenantJournalEntry,
  type TenantJournalMatch,
} from '@weldsuite/db/lib/tenant-journal';

export interface TenantJournal {
  entries: TenantJournalEntry[];
  /** The SQL of each migration, by tag. */
  sql: Map<string, string>;
}

/** The tenant journal from disk, with each migration's sha256 (what drizzle records as `hash`). */
export function loadTenantJournal(migrationsFolder: string): TenantJournal {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };
  const sql = new Map<string, string>();
  const entries = journal.entries.map((entry) => {
    const text = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    sql.set(entry.tag, text);
    return { tag: entry.tag, when: entry.when, hash: createHash('sha256').update(text).digest('hex') };
  });
  return { entries, sql };
}

async function hasTagColumn(client: postgres.Sql): Promise<boolean> {
  const [row] = await client`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '__drizzle_migrations' AND column_name = 'tag'
    ) AS present`;
  return row?.present === true;
}

/** The rows of `public.__drizzle_migrations` (drizzle's table has no `tag` column; it then reads as null). */
export async function readRecordedMigrations(client: postgres.Sql): Promise<RecordedMigration[]> {
  const tag = (await hasTagColumn(client)) ? client`tag` : client`NULL::text`;
  const rows = await client`
    SELECT ${tag} AS tag, hash, created_at::text AS created_at
    FROM public.__drizzle_migrations
    ORDER BY id`;
  return rows.map((row) => ({
    tag: (row.tag as string | null) ?? null,
    hash: (row.hash as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
  }));
}

export async function checkJournal(client: postgres.Sql, journal: TenantJournal): Promise<TenantJournalMatch> {
  return matchTenantJournal(await readRecordedMigrations(client), journal.entries);
}

/**
 * Apply every migration `match` reports missing, in journal order. Each runs in
 * its own transaction with its row, so a failure leaves the earlier ones
 * applied and recorded, and nothing half-done. Returns the tags applied.
 */
export async function applySkippedMigrations(
  client: postgres.Sql,
  journal: TenantJournal,
  match: TenantJournalMatch,
): Promise<string[]> {
  await client`ALTER TABLE public.__drizzle_migrations ADD COLUMN IF NOT EXISTS tag text`;
  const applied: string[] = [];
  for (const entry of match.missing) {
    const statements = (journal.sql.get(entry.tag) ?? '')
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await client.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      await tx`
        INSERT INTO public.__drizzle_migrations (hash, created_at, tag)
        VALUES (${entry.hash}, ${entry.when}, ${entry.tag})`;
    });
    applied.push(entry.tag);
  }
  return applied;
}
