#!/usr/bin/env node
/**
 * Pile A extraction — move PRODUCT-FEATURE data out of the `custom_fields`
 * JSONB blobs and into the real columns added by migration 0169 (plus `files`
 * rows for attachments).
 *
 * See docs/custom-fields-blob-extraction.md. `custom_field_values` is for
 * user-created fields only; anything that is a product feature gets a real
 * column. These keys were never migrated by the Phase 2 backfill (they have no
 * `custom_field_definitions` row) and would be destroyed by the Phase 4 drop.
 *
 * Safety properties:
 *   - Dry-run by default; only `--execute` writes.
 *   - NEVER touches `custom_fields`. The blob stays intact as the fallback
 *     until Phase 4 drops the column, so a bad run is recoverable by re-running.
 *   - Idempotent. Column moves are guarded on `target IS NULL`, so a second run
 *     is a no-op and will not clobber a value the app has since written.
 *     File creation is guarded on the target `files.id` already existing.
 *   - A tenant missing the 0169 columns is reported and skipped, not crashed on.
 *
 * Usage:
 *   pnpm extract:blobs                  # dry-run report, all tenants
 *   pnpm extract:blobs:execute          # write
 *   pnpm extract:blobs -- --only ws_x   # single workspace
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';

type Cast = 'text' | 'timestamp' | 'boolean' | 'jsonb' | 'int';

interface ColumnMove {
  table: string;
  blobKey: string;
  column: string;
  cast: Cast;
}

/**
 * Straight blob-key -> column moves. Several targets (mail `scheduled_for` /
 * `send_status`, calendar `source_type` / `source_id` / `auto_scheduled`)
 * already existed before 0169 — the blob copies are legacy leftovers written by
 * the `api-worker` deleted 2026-07-17, sitting beside real columns.
 */
const COLUMN_MOVES: ColumnMove[] = [
  // crm_activities
  { table: 'crm_activities', blobKey: 'labels', column: 'labels', cast: 'jsonb' },
  { table: 'crm_activities', blobKey: 'assigneeIds', column: 'assignee_ids', cast: 'jsonb' },
  { table: 'crm_activities', blobKey: 'repeat', column: 'repeat', cast: 'jsonb' },
  // mail_messages — send state
  { table: 'mail_messages', blobKey: 'sendStatus', column: 'send_status', cast: 'text' },
  { table: 'mail_messages', blobKey: 'sendProvider', column: 'send_provider', cast: 'text' },
  { table: 'mail_messages', blobKey: 'providerMessageId', column: 'provider_message_id', cast: 'text' },
  { table: 'mail_messages', blobKey: 'mailgunMessageId', column: 'mailgun_message_id', cast: 'text' },
  { table: 'mail_messages', blobKey: 'scheduledFor', column: 'scheduled_for', cast: 'timestamp' },
  // mail_messages — snooze state
  { table: 'mail_messages', blobKey: 'snoozedUntil', column: 'snoozed_until', cast: 'timestamp' },
  { table: 'mail_messages', blobKey: 'snoozedAt', column: 'snoozed_at', cast: 'timestamp' },
  { table: 'mail_messages', blobKey: 'unsnoozedAt', column: 'unsnoozed_at', cast: 'timestamp' },
  { table: 'mail_messages', blobKey: 'unsnoozedEarly', column: 'unsnoozed_early', cast: 'boolean' },
  { table: 'mail_messages', blobKey: 'resnoozedAt', column: 'resnoozed_at', cast: 'timestamp' },
  { table: 'mail_messages', blobKey: 'unsnoozeTriggerRunId', column: 'unsnooze_trigger_run_id', cast: 'text' },
  // calendar_events
  { table: 'calendar_events', blobKey: 'sourceType', column: 'source_type', cast: 'text' },
  { table: 'calendar_events', blobKey: 'sourceId', column: 'source_id', cast: 'text' },
  { table: 'calendar_events', blobKey: 'autoScheduled', column: 'auto_scheduled', cast: 'boolean' },
  { table: 'calendar_events', blobKey: 'reason', column: 'reason', cast: 'text' },
  { table: 'calendar_events', blobKey: 'taskPriority', column: 'task_priority', cast: 'text' },
];

/**
 * The legacy CRM change-log keys are consolidated into one `change_log` object
 * rather than getting a column each — their writer is gone and only the CRM
 * activity feed still reads them.
 */
const CHANGELOG_KEYS = ['changes', '__changeLog', 'changedFields', 'previousValues', 'newValues'];

/** Build the SQL expression that reads a blob key at the right type. */
function readExpr(blobKey: string, cast: Cast): string {
  const asText = `custom_fields ->> '${blobKey}'`;
  switch (cast) {
    case 'jsonb':
      return `custom_fields -> '${blobKey}'`;
    case 'timestamp':
      // Stored as ISO-8601 with a Z suffix. text->timestamp ignores the offset,
      // so this lands on the same UTC wall-clock the app writes via Drizzle.
      return `(${asText})::timestamp`;
    case 'boolean':
      return `(${asText})::boolean`;
    case 'int':
      return `(${asText})::integer`;
    case 'text':
    default:
      return asText;
  }
}

interface Counts {
  columnUpdates: number;
  filesCreated: number;
  changelogRows: number;
  missingColumns: number;
  tenantsSkipped: number;
}

function newCounts(): Counts {
  return { columnUpdates: 0, filesCreated: 0, changelogRows: 0, missingColumns: 0, tenantsSkipped: 0 };
}

function addCounts(into: Counts, from: Counts) {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += from[k];
}

function generateId(prefix: string): string {
  const random = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

async function columnExists(sql: postgres.Sql, table: string, column: string): Promise<boolean> {
  const rows = (await sql.unsafe(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column] as never[],
  )) as unknown as unknown[];
  return rows.length > 0;
}

async function tableExists(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = (await sql.unsafe(`SELECT to_regclass('public.${table}') AS reg`)) as unknown as {
    reg: string | null;
  }[];
  return Boolean(rows[0]?.reg);
}

/** Per-tenant state shared by the extraction phases. */
interface TenantCtx {
  sql: postgres.Sql;
  execute: boolean;
  counts: Counts;
  lines: string[];
}

/**
 * Execute mode runs the UPDATE and returns its affected-row count; dry-run runs
 * the matching COUNT query instead. Returns the number of rows affected/matched.
 */
async function applyOrCount(ctx: TenantCtx, updateSql: string, countSql: string): Promise<number> {
  if (ctx.execute) {
    const res = await ctx.sql.unsafe(updateSql);
    return (res as unknown as { count?: number }).count ?? 0;
  }
  const [row] = (await ctx.sql.unsafe(countSql)) as unknown as { n: string }[];
  return Number(row?.n ?? 0);
}

/** One straight blob-key -> column move. */
async function moveColumn(ctx: TenantCtx, move: ColumnMove): Promise<void> {
  const { sql, counts, lines } = ctx;
  if (!(await tableExists(sql, move.table))) return;
  if (!(await columnExists(sql, move.table, move.column))) {
    counts.missingColumns++;
    lines.push(`    ${move.table}.${move.column} MISSING — apply migration 0169 first`);
    return;
  }

  // `target IS NULL` makes this idempotent and stops a re-run from
  // overwriting a value the application has written since.
  const where =
    `custom_fields ? '${move.blobKey}' ` +
    `AND jsonb_typeof(custom_fields -> '${move.blobKey}') <> 'null' ` +
    `AND ${move.column} IS NULL`;

  const n = await applyOrCount(
    ctx,
    `UPDATE ${move.table} SET ${move.column} = ${readExpr(move.blobKey, move.cast)} WHERE ${where}`,
    `SELECT count(*) AS n FROM ${move.table} WHERE ${where}`,
  );
  if (n > 0) lines.push(`    ${move.table}.${move.blobKey} -> ${move.column}: ${n}`);
  counts.columnUpdates += n;
}

/** crm_activities change-log consolidation. */
async function consolidateChangeLog(ctx: TenantCtx): Promise<void> {
  const { sql, counts, lines } = ctx;
  if (!((await tableExists(sql, 'crm_activities')) && (await columnExists(sql, 'crm_activities', 'change_log')))) return;

  const keyList = CHANGELOG_KEYS.map((k) => `'${k}'`).join(', ');
  const where = `custom_fields ?| array[${keyList}] AND change_log IS NULL`;
  // Execute mode keeps only the change-log keys, preserving whatever subset is present.
  const n = await applyOrCount(
    ctx,
    `UPDATE crm_activities
        SET change_log = (
          SELECT jsonb_object_agg(kv.key, kv.value)
            FROM jsonb_each(custom_fields) AS kv
           WHERE kv.key = ANY(array[${keyList}])
        )
      WHERE ${where}`,
    `SELECT count(*) AS n FROM crm_activities WHERE ${where}`,
  );
  counts.changelogRows += n;
  if (n > 0) lines.push(`    crm_activities change-log -> change_log: ${n}`);
}

/** Create the `files` row for one task attachment (execute mode only). */
async function insertTaskAttachmentFile(
  sql: postgres.Sql,
  a: Record<string, string | null>,
  storagePath: string,
): Promise<void> {
  // Preserve the blob's id when present so any existing reference to it
  // still resolves; only invent one when the attachment had none.
  const fileId = a.file_id || generateId('file');
  await sql.unsafe(
    `INSERT INTO files
       (id, file_name, original_name, mime_type, file_size, file_type,
        storage_path, file_key, url, entity_type, entity_id, created_at, updated_at)
     VALUES ($1, $2, $2, $3, $4, 'file', $5, $6, $7, 'task', $8, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [
      fileId,
      a.file_name ?? 'attachment',
      a.mime_type ?? 'application/octet-stream',
      Number(a.file_size ?? 0),
      storagePath,
      a.file_key ?? null,
      a.url ?? null,
      a.entity_id,
    ] as never[],
  );
}

/**
 * tasks attachments -> files rows.
 * The blob's attachment `id` values LOOK like file ids but have no matching
 * `files` row (verified against live data), so real rows must be created.
 */
async function extractTaskAttachments(ctx: TenantCtx): Promise<void> {
  const { sql, execute, counts, lines } = ctx;
  if (!((await tableExists(sql, 'files')) && (await tableExists(sql, 'tasks')))) return;

  const attachments = (await sql.unsafe(
    `SELECT t.id AS entity_id,
            a->>'id'       AS file_id,
            a->>'url'      AS url,
            a->>'fileKey'  AS file_key,
            a->>'fileName' AS file_name,
            a->>'fileSize' AS file_size,
            a->>'mimeType' AS mime_type
       FROM tasks t, jsonb_array_elements(t.custom_fields->'attachments') AS a
      WHERE t.custom_fields ? 'attachments'
        AND jsonb_typeof(t.custom_fields->'attachments') = 'array'`,
  )) as unknown as Record<string, string | null>[];

  for (const a of attachments) {
    // Dedup on STABLE storage identity (entity + storage path), NOT the
    // row id. The blob's `id` is optional, and when absent generateId()
    // would mint a new value every run — so keying idempotency off the id
    // would insert a duplicate on each re-run for idless attachments.
    // storage_path is `file_key ?? url` (the same value written below), and
    // is the stable handle for the object in R2.
    const storagePath = a.file_key ?? a.url ?? '';
    const dupe = (await sql.unsafe(
      `SELECT 1 FROM files WHERE entity_type='task' AND entity_id=$1 AND storage_path=$2`,
      [a.entity_id, storagePath] as never[],
    )) as unknown as unknown[];
    if (dupe.length > 0) continue; // idempotent on stable identity
    counts.filesCreated++;
    if (execute) await insertTaskAttachmentFile(sql, a, storagePath);
  }
  if (counts.filesCreated > 0) lines.push(`    tasks.attachments -> files: ${counts.filesCreated}`);
}

/** Create the `files` row for one crm_activities file (execute mode only). */
async function insertActivityFile(sql: postgres.Sql, r: Record<string, string | null>): Promise<void> {
  await sql.unsafe(
    `INSERT INTO files
       (id, file_name, original_name, mime_type, file_size, file_type,
        storage_path, file_key, entity_type, entity_id, created_at, updated_at)
     VALUES ($1, $2, $2, $3, $4, 'file', $5, $5, 'crm_activity', $6, now(), now())`,
    [
      generateId('file'),
      r.file_name ?? 'attachment',
      r.content_type ?? 'application/octet-stream',
      Number(r.file_size ?? 0),
      r.file_key ?? '',
      r.entity_id,
    ] as never[],
  );
}

/** crm_activities file metadata -> files rows. */
async function extractActivityFiles(ctx: TenantCtx): Promise<void> {
  const { sql, execute, counts, lines } = ctx;
  if (!((await tableExists(sql, 'files')) && (await tableExists(sql, 'crm_activities')))) return;

  const rows = (await sql.unsafe(
    `SELECT id AS entity_id,
            custom_fields->>'fileKey'     AS file_key,
            custom_fields->>'fileName'    AS file_name,
            custom_fields->>'fileSize'    AS file_size,
            custom_fields->>'contentType' AS content_type
       FROM crm_activities
      WHERE custom_fields ? 'fileKey'`,
  )) as unknown as Record<string, string | null>[];

  let created = 0;
  for (const r of rows) {
    // Keyed on (entity, storage path) so a re-run doesn't duplicate.
    const dupe = (await sql.unsafe(
      `SELECT 1 FROM files WHERE entity_type='crm_activity' AND entity_id=$1 AND file_key=$2`,
      [r.entity_id, r.file_key] as never[],
    )) as unknown as unknown[];
    if (dupe.length > 0) continue;
    created++;
    if (execute) await insertActivityFile(sql, r);
  }
  counts.filesCreated += created;
  if (created > 0) lines.push(`    crm_activities file metadata -> files: ${created}`);
}

async function migrateTenant(
  label: string,
  databaseUrl: string,
  execute: boolean,
  verbose: boolean,
): Promise<Counts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  const lines: string[] = [];
  const ctx: TenantCtx = { sql, execute, counts, lines };

  try {
    // ---- straight column moves -------------------------------------------
    for (const move of COLUMN_MOVES) {
      await moveColumn(ctx, move);
    }

    // ---- crm_activities change-log consolidation --------------------------
    await consolidateChangeLog(ctx);

    // ---- attachments -> files rows ----------------------------------------
    await extractTaskAttachments(ctx);

    // ---- crm_activities file metadata -> files rows ------------------------
    await extractActivityFiles(ctx);
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (lines.length > 0) {
    console.log(`  ${label}:`);
    lines.forEach((l) => console.log(l));
  } else if (verbose) {
    console.log(`  ${label}: nothing to move`);
  }
  return counts;
}

async function loadActiveTenants(masterUrl: string, only: string | null) {
  const masterClient = postgres(masterUrl, { max: 1, ssl: 'require', prepare: false });
  const db = drizzle(masterClient);
  const conditions = [eq(workspaces.isActive, true), isNotNull(workspaces.neonProjectId)];
  if (only) conditions.push(eq(workspaces.id, only));
  const rows = await db
    .select({
      id: workspaces.id,
      neonProjectId: workspaces.neonProjectId,
      neonBranchId: workspaces.neonBranchId,
      neonRoleName: workspaces.neonRoleName,
      neonDatabaseName: workspaces.neonDatabaseName,
      databaseUrl: workspaces.databaseUrl,
    })
    .from(workspaces)
    .where(and(...conditions));
  await masterClient.end({ timeout: 5 });
  return rows;
}

/** Migrates every tenant in order, accumulating into `total`. */
async function migrateAllTenants(
  rows: Awaited<ReturnType<typeof loadActiveTenants>>,
  neonApiKey: string,
  keys: { v1: string | undefined; v2: string | undefined },
  execute: boolean,
  verbose: boolean,
  total: Counts,
): Promise<void> {
  for (const w of rows) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    try {
      const url = await resolveDatabaseUrl(neonApiKey, w as never, keys);
      addCounts(total, await migrateTenant(w.id, url, execute, verbose));
    } catch (err) {
      console.error(`  ${w.id}: FAILED — ${(err as Error).message}`);
      total.tenantsSkipped++;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const verbose = args.includes('--verbose');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? null) : null;

  const masterUrl = process.env.MASTER_DATABASE_URL;
  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  const neonApiKey = process.env.NEON_API_KEY || '';
  const v1 = process.env.DATABASE_ENCRYPTION_KEY;
  const v2 = process.env.DATABASE_ENCRYPTION_KEY_V2;

  console.log(`Pile A blob extraction — mode: ${execute ? 'EXECUTE' : 'dry-run'}`);
  console.log('(the custom_fields blob is never modified — Phase 4 drops it)\n');

  const rows = await loadActiveTenants(masterUrl, only);

  console.log(`Tenants (${rows.length}):`);
  const total = newCounts();
  await migrateAllTenants(rows, neonApiKey, { v1, v2 }, execute, verbose, total);

  console.log(
    `\nTOTAL: columnUpdates=${total.columnUpdates} filesCreated=${total.filesCreated} ` +
      `changelogRows=${total.changelogRows} missingColumns=${total.missingColumns} ` +
      `tenantsSkipped=${total.tenantsSkipped}`,
  );
  if (!execute) console.log('\nDry-run only. Re-run with --execute to write.');
  process.exit(total.tenantsSkipped > 0 || total.missingColumns > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Extraction failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
