#!/usr/bin/env node
/**
 * Per-app permissions — rewrite stored grants from `object:action` to
 * `app:object:action` in every tenant DB.
 *
 * Rewrites `roles.permissions` and `workspace_members.permissions` with
 * `toAppScopedKeys` from @weldsuite/permissions: each grant on an app-scoped
 * object becomes one grant per app that exposes the object, so every member
 * keeps exactly the access they had (verified per role in
 * apps/workers/app-api/src/routes/_app-permissions.test.ts). Admins then
 * narrow access per app in the role / member editor.
 *
 * ORDERING — do NOT --execute until every client checks app-qualified keys:
 * the platform SPA (`can('companies:read')` must resolve against the current
 * app), mcp-server and the mobile apps. Until then a rewritten role would
 * read as "no access" in those clients. The server side (app-api) already
 * accepts both formats. `--execute` therefore also requires `--clients-ready`.
 *
 * Safety properties:
 *   - Dry-run by default; writes need `--execute --clients-ready`.
 *   - Idempotent: already-qualified keys are left alone, so a re-run after a
 *     partial failure only touches the rows that still need it.
 *   - Before writing a tenant, its original values are saved to
 *     ./backups/app-permissions/<workspaceId>-<timestamp>.json.
 *   - Each tenant is rewritten in one transaction.
 *
 * Usage:
 *   pnpm migrate:app-permissions                              # dry-run, all tenants
 *   pnpm migrate:app-permissions -- --only org_123 --verbose  # one tenant, show diffs
 *   pnpm migrate:app-permissions:execute                      # write (adds --execute --clients-ready)
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY, DATABASE_ENCRYPTION_KEY
 * (+ DATABASE_ENCRYPTION_KEY_V2 once tenant URLs are rotated to v2).
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, isNotNull } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { toAppScopedKeys } from '@weldsuite/permissions';

const TABLES = ['roles', 'workspace_members'] as const;
type TableName = (typeof TABLES)[number];

const BACKUP_DIR = join(process.cwd(), 'backups', 'app-permissions');

interface CliOptions {
  execute: boolean;
  clientsReady: boolean;
  only: string | null;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { execute: false, clientsReady: false, only: null, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--clients-ready') options.clientsReady = true;
    else if (arg === '--only' && args[i + 1]) options.only = args[++i] ?? null;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    }
  }
  return options;
}

interface Counts {
  rows: number;
  changed: number;
  failedTenants: number;
}

const newCounts = (): Counts => ({ rows: 0, changed: 0, failedTenants: 0 });

interface PendingUpdate {
  table: TableName;
  id: string;
  before: string[];
  after: string[];
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

async function tableExists(sql: postgres.Sql, table: TableName): Promise<boolean> {
  const rows = (await sql.unsafe(`SELECT to_regclass('public.${table}') AS reg`)) as unknown as {
    reg: string | null;
  }[];
  return Boolean(rows[0]?.reg);
}

async function collectUpdates(sql: postgres.Sql, table: TableName, counts: Counts): Promise<PendingUpdate[]> {
  if (!(await tableExists(sql, table))) return [];
  const rows = (await sql.unsafe(
    `SELECT id, permissions FROM "${table}" WHERE permissions IS NOT NULL`,
  )) as unknown as { id: string; permissions: unknown }[];

  const updates: PendingUpdate[] = [];
  for (const row of rows) {
    counts.rows++;
    if (!Array.isArray(row.permissions)) continue;
    const before = row.permissions.filter((k): k is string => typeof k === 'string');
    const after = toAppScopedKeys(before);
    if (!sameKeys(before, after)) updates.push({ table, id: row.id, before, after });
  }
  return updates;
}

async function sweepTenant(label: string, databaseUrl: string, options: CliOptions): Promise<Counts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  try {
    const updates: PendingUpdate[] = [];
    for (const table of TABLES) updates.push(...(await collectUpdates(sql, table, counts)));
    counts.changed = updates.length;

    if (options.verbose) {
      for (const u of updates) {
        const added = u.after.filter((k) => !u.before.includes(k));
        const removed = u.before.filter((k) => !u.after.includes(k));
        console.log(`    ${u.table} ${u.id}: -${removed.length} +${added.length}  (e.g. ${removed[0] ?? '—'} → ${added[0] ?? '—'})`);
      }
    }

    if (options.execute && updates.length > 0) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const backupFile = join(BACKUP_DIR, `${label}-${Date.now()}.json`);
      writeFileSync(
        backupFile,
        JSON.stringify(updates.map(({ table, id, before }) => ({ table, id, permissions: before })), null, 2),
      );
      await sql.begin(async (tx) => {
        for (const u of updates) {
          await tx.unsafe(`UPDATE "${u.table}" SET permissions = $1::jsonb WHERE id = $2`, [
            JSON.stringify(u.after),
            u.id,
          ]);
        }
      });
      console.log(`  ${label}: rows=${counts.rows} rewritten=${updates.length} (backup: ${backupFile})`);
    } else {
      console.log(`  ${label}: rows=${counts.rows} to rewrite=${updates.length}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return counts;
}

async function main() {
  const options = parseArgs();
  if (options.execute && !options.clientsReady) {
    console.error(
      'Refusing to --execute without --clients-ready: the platform, mcp-server and mobile apps must ' +
        'check app-qualified keys first (see file header).',
    );
    process.exit(1);
  }

  const masterUrl = process.env.MASTER_DATABASE_URL;
  const neonApiKey = process.env.NEON_API_KEY || '';
  const v1 = process.env.DATABASE_ENCRYPTION_KEY;
  const v2 = process.env.DATABASE_ENCRYPTION_KEY_V2;

  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  if (!v1 && !v2) console.log('No DATABASE_ENCRYPTION_KEY set — resolving tenant URLs via the Neon API.');

  console.log(`Per-app permission rewrite — mode: ${options.execute ? 'EXECUTE' : 'dry-run'}`);

  const masterClient = postgres(masterUrl, { max: 1, ssl: 'require', prepare: false });
  const db = drizzle(masterClient);
  const conditions = [eq(workspaces.isActive, true), isNotNull(workspaces.neonProjectId)];
  if (options.only) conditions.push(eq(workspaces.id, options.only));
  const rows = await db
    .select({
      id: workspaces.id, name: workspaces.name, neonProjectId: workspaces.neonProjectId,
      neonBranchId: workspaces.neonBranchId, neonRoleName: workspaces.neonRoleName,
      neonDatabaseName: workspaces.neonDatabaseName, databaseUrl: workspaces.databaseUrl,
    })
    .from(workspaces)
    .where(and(...conditions));
  await masterClient.end({ timeout: 5 });

  console.log(`\nTenant DBs (${rows.length}):`);
  const total = newCounts();
  for (const w of rows) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    try {
      const url = await resolveDatabaseUrl(neonApiKey, w as never, { v1, v2 });
      const counts = await sweepTenant(w.id, url, options);
      total.rows += counts.rows;
      total.changed += counts.changed;
    } catch (err) {
      console.error(`  ${w.id}: FAILED — ${(err as Error).message}`);
      total.failedTenants++;
    }
  }

  console.log(`\nTOTAL: rows=${total.rows} ${options.execute ? 'rewritten' : 'to rewrite'}=${total.changed} failedTenants=${total.failedTenants}`);
  if (!options.execute) console.log('\nDry-run only. Re-run with --execute --clients-ready to write.');
  process.exit(total.failedTenants === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Per-app permission rewrite failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
