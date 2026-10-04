#!/usr/bin/env node
/**
 * Repair `tasks.labels` entries that hold a label NAME instead of a label ID.
 *
 * `tasks.labels` is a list of `project_labels.id` values: the platform resolves
 * them by ID and the `labelIds` task filter matches on them. The WeldFlow mobile
 * app saved label names until TASK-824, so tasks edited there hold a mix of IDs
 * and names, and the named labels are invisible on web.
 *
 * For each entry that is not a label ID, the label with that exact name is
 * looked up: the task's own project's label first, then the workspace-wide one,
 * then the only label with that name anywhere. See `lib/task-label-repair.ts`.
 *
 * Safety properties:
 *   - Dry-run by default; only `--execute` writes.
 *   - Only `tasks.labels` is written. `updated_at` is left alone, so repaired
 *     tasks do not jump to the top of "recently updated" lists.
 *   - Nothing is ever dropped. A name that matches no label, or more than one,
 *     stays as it is and is reported.
 *   - Each UPDATE is guarded on the value that was read, so a task edited
 *     while the script runs is skipped, not overwritten.
 *   - Idempotent: a second run finds only the entries it could not resolve.
 *
 * Usage:
 *   pnpm repair:task-labels                    # dry-run report, all tenants
 *   pnpm repair:task-labels -- --verbose       # also list each task and mapping
 *   pnpm repair:task-labels -- --only ws_x     # single workspace
 *   pnpm repair:task-labels:execute            # write
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { buildLabelIndex, repairTaskLabels, type LabelRow } from './lib/task-label-repair';

interface Counts {
  tasksRepaired: number;
  entriesMapped: number;
  ambiguousEntries: number;
  unresolvedEntries: number;
  tasksChangedMeanwhile: number;
  tenantsSkipped: number;
}

function newCounts(): Counts {
  return {
    tasksRepaired: 0,
    entriesMapped: 0,
    ambiguousEntries: 0,
    unresolvedEntries: 0,
    tasksChangedMeanwhile: 0,
    tenantsSkipped: 0,
  };
}

function addCounts(into: Counts, from: Counts) {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += from[k];
}

interface TaskRow {
  id: string;
  project_id: string | null;
  labels: unknown;
}

async function tableExists(sql: postgres.Sql, table: string): Promise<boolean> {
  const rows = (await sql.unsafe(`SELECT to_regclass('public.${table}') AS reg`)) as unknown as {
    reg: string | null;
  }[];
  return Boolean(rows[0]?.reg);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Writes the repaired labels, guarded on the value that was read. Returns false
 * when the task was edited in the meantime and nothing was written.
 *
 * The values go in as text and are cast in SQL (`$n::text::jsonb`). A parameter
 * typed `jsonb` is JSON-encoded by the driver, which would encode these
 * already-serialised arrays a second time and store a JSON string. The
 * transaction rolls back if the stored value is not an array after all.
 */
async function writeLabels(
  sql: postgres.Sql,
  taskId: string,
  before: string[],
  after: string[],
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = (await tx.unsafe(
      `UPDATE tasks SET labels = $1::text::jsonb
        WHERE id = $2 AND labels = $3::text::jsonb
        RETURNING jsonb_typeof(labels) AS kind`,
      [JSON.stringify(after), taskId, JSON.stringify(before)] as never[],
    )) as unknown as { kind: string }[];
    if (rows.length === 0) return false;
    if (rows[0].kind !== 'array') throw new Error(`task ${taskId}: labels would be stored as ${rows[0].kind}`);
    return true;
  });
}

async function repairTenant(
  label: string,
  databaseUrl: string,
  execute: boolean,
  verbose: boolean,
): Promise<Counts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  const details: string[] = [];

  try {
    if (!((await tableExists(sql, 'tasks')) && (await tableExists(sql, 'project_labels')))) return counts;

    const labelRows = (await sql.unsafe(
      `SELECT id, name, project_id AS "projectId", deleted_at AS "deletedAt" FROM project_labels`,
    )) as unknown as LabelRow[];
    const index = buildLabelIndex(labelRows);

    // Tasks with at least one entry that is not a label ID. Soft-deleted tasks
    // are included so a restored task comes back with working labels.
    const tasks = (await sql.unsafe(
      `SELECT t.id, t.project_id, t.labels
         FROM tasks t
        WHERE jsonb_typeof(t.labels) = 'array'
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(t.labels) AS e(value)
             WHERE NOT EXISTS (SELECT 1 FROM project_labels l WHERE l.id = e.value)
          )`,
    )) as unknown as TaskRow[];

    for (const task of tasks) {
      if (!isStringArray(task.labels)) continue;
      const repair = repairTaskLabels(task.labels, task.project_id, index);
      counts.ambiguousEntries += repair.ambiguous.length;
      counts.unresolvedEntries += repair.unresolved.length;

      if (verbose) {
        for (const m of repair.mapped) details.push(`    ${task.id}: "${m.name}" -> ${m.id}`);
        for (const name of repair.ambiguous) details.push(`    ${task.id}: "${name}" matches several labels, left`);
        for (const name of repair.unresolved) details.push(`    ${task.id}: "${name}" matches no label, left`);
      }
      if (!repair.changed) continue;

      if (execute && !(await writeLabels(sql, task.id, task.labels, repair.labels))) {
        counts.tasksChangedMeanwhile++;
        continue;
      }
      counts.tasksRepaired++;
      counts.entriesMapped += repair.mapped.length;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  const touched =
    counts.tasksRepaired + counts.ambiguousEntries + counts.unresolvedEntries + counts.tasksChangedMeanwhile;
  if (touched > 0) {
    console.log(
      `  ${label}: tasks=${counts.tasksRepaired} mapped=${counts.entriesMapped} ` +
        `ambiguous=${counts.ambiguousEntries} unresolved=${counts.unresolvedEntries}` +
        (counts.tasksChangedMeanwhile > 0 ? ` changedMeanwhile=${counts.tasksChangedMeanwhile}` : ''),
    );
    details.forEach((l) => console.log(l));
  } else if (verbose) {
    console.log(`  ${label}: nothing to repair`);
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

async function main() {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const verbose = args.includes('--verbose');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? null) : null;

  const masterUrl = process.env.MASTER_DATABASE_URL;
  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  const neonApiKey = process.env.NEON_API_KEY || '';
  const keys = { v1: process.env.DATABASE_ENCRYPTION_KEY, v2: process.env.DATABASE_ENCRYPTION_KEY_V2 };

  console.log(`Task label name repair — mode: ${execute ? 'EXECUTE' : 'dry-run'}\n`);

  const rows = await loadActiveTenants(masterUrl, only);

  console.log(`Tenants (${rows.length}):`);
  const total = newCounts();
  for (const w of rows) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    try {
      const url = await resolveDatabaseUrl(neonApiKey, w as never, keys);
      addCounts(total, await repairTenant(w.id, url, execute, verbose));
    } catch (err) {
      console.error(`  ${w.id}: FAILED — ${(err as Error).message}`);
      total.tenantsSkipped++;
    }
  }

  console.log(
    `\nTOTAL: tasks=${total.tasksRepaired} mapped=${total.entriesMapped} ` +
      `ambiguous=${total.ambiguousEntries} unresolved=${total.unresolvedEntries} ` +
      `changedMeanwhile=${total.tasksChangedMeanwhile} tenantsSkipped=${total.tenantsSkipped}`,
  );
  if (!execute) console.log('\nDry-run only. Re-run with --execute to write.');
  process.exit(total.tenantsSkipped > 0 ? 1 : 0);
}

try {
  await main();
} catch (err) {
  console.error('Repair failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
