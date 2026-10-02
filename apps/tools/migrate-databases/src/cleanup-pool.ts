#!/usr/bin/env node

/**
 * Database Pool Cleanup
 *
 * Deletes accidentally over-provisioned Neon pool projects (`weldsuite-pool-*`).
 *
 * What it deletes (UNASSIGNED only):
 *   1. Tracked rows in `database_pool` with status `available` or `error`
 *      → deletes the Neon project AND removes the row.
 *   2. Orphan Neon projects named `weldsuite-pool-*` that have NO row in
 *      `database_pool` (created but never recorded) → deletes the Neon project.
 *
 * What it NEVER touches:
 *   - `database_pool` rows with status `assigned` (back a live workspace).
 *   - Any Neon project whose id is referenced by `workspaces.neon_project_id`.
 *   - Real workspace projects (named `weldsuite-<workspaceId>`, not `-pool-`).
 *
 * SAFE BY DEFAULT: dry-run. Pass `--execute` to actually delete.
 *
 * Note: the replenish-pool cron (workspace-worker, every 5 min in production)
 * will rebuild the pool back to its per-region target after this runs. To stop
 * it temporarily, disable that cron trigger first.
 *
 * Usage:
 *   pnpm cleanup:pool                     # dry-run, all regions, includes orphans
 *   pnpm cleanup:pool -- --execute        # actually delete
 *   pnpm cleanup:pool -- --region aws-eu-central-1
 *   pnpm cleanup:pool -- --keep-per-region 5   # keep N newest available/region
 *   pnpm cleanup:pool -- --no-orphans     # skip untracked Neon projects
 *   pnpm cleanup:pool -- --verbose
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { inArray } from 'drizzle-orm';
import { workspaces, databasePool } from '@weldsuite/db/schema/master';

const NEON_API_BASE = 'https://console.neon.tech/api/v2';
const POOL_PREFIX = 'weldsuite-pool-';

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

interface CliOptions {
  execute: boolean;
  region: string | null;
  keepPerRegion: number;
  includeOrphans: boolean;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    execute: false,
    region: null,
    keepPerRegion: 0,
    includeOrphans: true,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--region' && args[i + 1]) options.region = args[++i] ?? null;
    else if (arg === '--keep-per-region' && args[i + 1]) options.keepPerRegion = Math.max(0, Number.parseInt(args[++i] ?? '0', 10) || 0);
    else if (arg === '--no-orphans') options.includeOrphans = false;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
  }
  return options;
}

function printHelp(): void {
  console.log(`
Database Pool Cleanup

Deletes UNASSIGNED Neon pool projects (weldsuite-pool-*). Never touches
projects that back a live workspace.

Usage:
  pnpm cleanup:pool [options]

Options:
  --execute               Actually delete (default: dry-run, no changes)
  --region <id>           Only act on this Neon region (e.g. aws-eu-central-1)
  --keep-per-region <n>   Keep the N newest 'available' projects per region (default 0 = delete all)
  --no-orphans            Do NOT delete untracked weldsuite-pool-* Neon projects
  --verbose               Print every project considered
  --help, -h              Show this help

Env (apps/tools/migrate-databases/.env):
  MASTER_DATABASE_URL     Master Postgres connection (required)
  NEON_API_KEY            Neon API key (required)
  NEON_ORG_ID             Neon org id (optional; scopes the project list)
`);
}

// ----------------------------------------------------------------------------
// Neon API
// ----------------------------------------------------------------------------

interface NeonProject {
  id: string;
  name: string;
  region_id: string;
  created_at: string;
}

async function neonRequest<T>(apiKey: string, method: string, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${NEON_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Neon API ${method} ${path} -> ${res.status}: ${text}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return { status: 204, body: {} as T };
  return { status: res.status, body: (await res.json()) as T };
}

/** List ALL Neon projects, following cursor pagination. */
async function listAllNeonProjects(apiKey: string, orgId?: string): Promise<NeonProject[]> {
  const projects: NeonProject[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({ limit: '100' });
    if (orgId) params.set('org_id', orgId);
    if (cursor) params.set('cursor', cursor);

    const { body } = await neonRequest<{ projects: NeonProject[]; pagination?: { cursor?: string } }>(
      apiKey,
      'GET',
      `/projects?${params.toString()}`,
    );

    projects.push(...body.projects);
    const next = body.pagination?.cursor;
    // Neon returns the same trailing cursor on the last page; stop when a page
    // is short or the cursor stops advancing.
    cursor = body.projects.length === 100 && next && next !== cursor ? next : undefined;
  } while (cursor);

  return projects;
}

async function deleteNeonProject(apiKey: string, projectId: string): Promise<'deleted' | 'already-gone'> {
  try {
    await neonRequest(apiKey, 'DELETE', `/projects/${projectId}`);
    return 'deleted';
  } catch (e) {
    if ((e as { status?: number }).status === 404) return 'already-gone';
    throw e;
  }
}

// ----------------------------------------------------------------------------
// Concurrency helper
// ----------------------------------------------------------------------------

async function runPooled<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

type PoolRow = Pick<
  typeof databasePool.$inferSelect,
  'id' | 'kind' | 'neonProjectId' | 'status' | 'region' | 'assignedWorkspaceId' | 'createdAt'
>;

/** Protected: anything backing a live workspace, plus any assigned pool row. */
function collectProtectedProjectIds(
  wsRows: { neonProjectId: string | null }[],
  poolRows: PoolRow[],
): Set<string> {
  const protectedProjectIds = new Set<string>();
  for (const w of wsRows) if (w.neonProjectId) protectedProjectIds.add(w.neonProjectId);
  for (const r of poolRows) {
    if (r.status === 'assigned' || r.assignedWorkspaceId) protectedProjectIds.add(r.neonProjectId);
  }
  return protectedProjectIds;
}

/** Optionally keep the N newest 'available' rows per region. */
function excludeNewestPerRegion(deletableRows: PoolRow[], keepPerRegion: number): PoolRow[] {
  const keepIds = new Set<string>();
  const byRegion = new Map<string, PoolRow[]>();
  for (const r of deletableRows) {
    if (r.status !== 'available') continue;
    const list = byRegion.get(r.region) ?? [];
    list.push(r);
    byRegion.set(r.region, list);
  }
  for (const [, list] of byRegion) {
    list.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    list.slice(0, keepPerRegion).forEach((r) => keepIds.add(r.id));
  }
  return deletableRows.filter((r) => !keepIds.has(r.id));
}

/**
 * Tracked, deletable pool rows (available/error, not protected).
 * NEVER include kind='shared' rows: their neonProjectId is a shared SHARD
 * hosting up to ~100 live free tenants — deleting the project would take
 * them all down. Shared warm slots are databases inside that shard and are
 * managed by the refill workflow, not this script.
 */
function selectDeletableRows(
  poolRows: PoolRow[],
  protectedProjectIds: Set<string>,
  inRegion: (region: string) => boolean,
  keepPerRegion: number,
): PoolRow[] {
  const deletableRows = poolRows.filter(
    (r) =>
      r.kind !== 'shared' &&
      (r.status === 'available' || r.status === 'error') &&
      !protectedProjectIds.has(r.neonProjectId) &&
      inRegion(r.region),
  );
  return keepPerRegion > 0 ? excludeNewestPerRegion(deletableRows, keepPerRegion) : deletableRows;
}

interface DeletionStats {
  neonDeleted: number;
  neonAlreadyGone: number;
  rowsRemoved: number;
  failures: number;
}

/** Delete one Neon project, counting the outcome. Returns null (and counts a failure) on error. */
async function deleteAndCount(
  neonApiKey: string,
  projectId: string,
  stats: DeletionStats,
): Promise<'deleted' | 'already-gone' | null> {
  try {
    const outcome = await deleteNeonProject(neonApiKey, projectId);
    if (outcome === 'deleted') stats.neonDeleted++;
    else stats.neonAlreadyGone++;
    return outcome;
  } catch (e) {
    stats.failures++;
    console.error(`  ✗ ${projectId}: ${(e as Error).message}`);
    return null;
  }
}

/** Execute deletions (Neon project first, then DB row for tracked entries). */
async function executeDeletions(
  db: ReturnType<typeof drizzle>,
  neonApiKey: string,
  deletableRows: PoolRow[],
  orphanProjects: NeonProject[],
  verbose: boolean,
): Promise<DeletionStats> {
  const stats: DeletionStats = { neonDeleted: 0, neonAlreadyGone: 0, rowsRemoved: 0, failures: 0 };
  const removedRowIds: string[] = [];

  console.log('\nDeleting tracked pool entries…');
  await runPooled(deletableRows, 4, async (r) => {
    const outcome = await deleteAndCount(neonApiKey, r.neonProjectId, stats);
    if (!outcome) return;
    removedRowIds.push(r.id);
    if (verbose) console.log(`  ✓ ${r.neonProjectId} (${outcome}) — row ${r.id}`);
  });

  // Remove DB rows for everything whose Neon project is gone (batched).
  for (let i = 0; i < removedRowIds.length; i += 100) {
    const batch = removedRowIds.slice(i, i + 100);
    await db.delete(databasePool).where(inArray(databasePool.id, batch));
    stats.rowsRemoved += batch.length;
  }

  if (orphanProjects.length > 0) {
    console.log('\nDeleting orphan Neon projects…');
    await runPooled(orphanProjects, 4, async (p) => {
      const outcome = await deleteAndCount(neonApiKey, p.id, stats);
      if (outcome && verbose) console.log(`  ✓ ${p.id} (${outcome}) — ${p.name}`);
    });
  }

  return stats;
}

function printDeletionSummary(stats: DeletionStats) {
  console.log('\n' + '='.repeat(70));
  console.log('Done.');
  console.log(`  Neon projects deleted:      ${stats.neonDeleted}`);
  console.log(`  Neon already gone (404):    ${stats.neonAlreadyGone}`);
  console.log(`  database_pool rows removed: ${stats.rowsRemoved}`);
  if (stats.failures > 0) console.log(`  ⚠️  Failures:                ${stats.failures} (see errors above)`);
  console.log('='.repeat(70));
}

function printPlan(
  poolRows: PoolRow[],
  sharedRows: PoolRow[],
  deletableRows: PoolRow[],
  orphanProjects: NeonProject[],
  verbose: boolean,
) {
  const assignedCount = poolRows.filter((r) => r.status === 'assigned' || r.assignedWorkspaceId).length;
  console.log('');
  console.log('Plan:');
  console.log(`  • Protected (assigned / live workspace): ${assignedCount} pool row(s) — KEPT`);
  console.log(`  • Shared-shard slots (kind=shared):      ${sharedRows.length} pool row(s) — KEPT (live shard projects)`);
  console.log(`  • Tracked available/error to delete:     ${deletableRows.length}`);
  console.log(`  • Orphan Neon projects to delete:        ${orphanProjects.length}`);

  if (verbose) {
    for (const r of deletableRows) console.log(`    [row]    ${r.neonProjectId}  status=${r.status}  region=${r.region}  id=${r.id}`);
    for (const p of orphanProjects) console.log(`    [orphan] ${p.id}  name=${p.name}  region=${p.region_id}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();

  const masterUrl = process.env.MASTER_DATABASE_URL;
  const neonApiKey = process.env.NEON_API_KEY;
  const neonOrgId = process.env.NEON_ORG_ID || undefined;

  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is not set');
  if (!neonApiKey) throw new Error('NEON_API_KEY is not set');

  console.log('='.repeat(70));
  console.log(`Database Pool Cleanup — ${opts.execute ? '🔴 EXECUTE (will delete)' : '🟢 DRY RUN (no changes)'}`);
  if (opts.region) console.log(`Region filter: ${opts.region}`);
  console.log(`Keep per region: ${opts.keepPerRegion}   Orphans: ${opts.includeOrphans ? 'delete' : 'skip'}`);
  console.log('='.repeat(70));

  const masterClient = postgres(masterUrl, { max: 1 });
  const db = drizzle(masterClient);

  try {
    // 1. Load pool rows + protected project ids from the master DB.
    const poolRows = await db
      .select({
        id: databasePool.id,
        kind: databasePool.kind,
        neonProjectId: databasePool.neonProjectId,
        status: databasePool.status,
        region: databasePool.region,
        assignedWorkspaceId: databasePool.assignedWorkspaceId,
        createdAt: databasePool.createdAt,
      })
      .from(databasePool);

    const wsRows = await db
      .select({ neonProjectId: workspaces.neonProjectId })
      .from(workspaces);

    const protectedProjectIds = collectProtectedProjectIds(wsRows, poolRows);

    const trackedProjectIds = new Set(poolRows.map((r) => r.neonProjectId));

    // 2. List every Neon project (paginated).
    console.log('Listing Neon projects…');
    const allProjects = await listAllNeonProjects(neonApiKey, neonOrgId);
    const poolProjects = allProjects.filter((p) => p.name.startsWith(POOL_PREFIX));
    console.log(`Neon: ${allProjects.length} total project(s), ${poolProjects.length} named ${POOL_PREFIX}*`);

    const inRegion = (region: string) => !opts.region || region === opts.region;

    // 3a. Tracked, deletable pool rows.
    const sharedRows = poolRows.filter((r) => r.kind === 'shared');
    const deletableRows = selectDeletableRows(poolRows, protectedProjectIds, inRegion, opts.keepPerRegion);

    // 3b. Orphan Neon projects: weldsuite-pool-* with no DB row, not protected.
    const orphanProjects = opts.includeOrphans
      ? poolProjects.filter(
          (p) => !trackedProjectIds.has(p.id) && !protectedProjectIds.has(p.id) && inRegion(p.region_id),
        )
      : [];

    // Status summary.
    printPlan(poolRows, sharedRows, deletableRows, orphanProjects, opts.verbose);

    const totalToDelete = deletableRows.length + orphanProjects.length;
    if (totalToDelete === 0) {
      console.log('\nNothing to delete. ✅');
      return;
    }

    if (!opts.execute) {
      console.log(`\nDRY RUN: would delete ${totalToDelete} Neon project(s). Re-run with --execute to apply.`);
      return;
    }

    // 4. Execute deletions.
    const stats = await executeDeletions(db, neonApiKey, deletableRows, orphanProjects, opts.verbose);
    printDeletionSummary(stats);

    if (stats.failures > 0) process.exitCode = 1;
  } finally {
    await masterClient.end({ timeout: 5 });
  }
}

try {
  await main();
} catch (err) {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
}
