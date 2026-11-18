#!/usr/bin/env tsx
/**
 * Read-only inventory of the Global deployment, for phase 0 of Global's
 * retirement (ADR OPS-025). Reads the master database, every tenant
 * database, Clerk and (optionally) mail-api's mailbox-store status, and writes
 * `global-inventory.json` and `global-inventory.md` to the output folder.
 *
 * Every query runs in a read-only transaction of its own. A session-level
 * `SET … read only` would not do: Neon's pooler is PgBouncer in transaction
 * mode, so the setting would stay on a pooled backend that then serves the
 * live workers, while later queries could land on a backend that never ran
 * it. The report holds workspace ids and counts, not names, addresses or
 * domains.
 *
 * Usage:
 *   pnpm --filter migrate-databases inventory:global [--out <dir>] [--only <workspaceId>] [--skip-clerk] [--skip-mail-store]
 *
 * Environment (the same names the migration runner reads):
 *   MASTER_DATABASE_URL                                required
 *   DATABASE_ENCRYPTION_KEY, DATABASE_ENCRYPTION_KEY_V2  to open stored tenant URLs
 *   NEON_API_KEY                                       fallback for workspaces without a stored URL
 *   CLERK_SECRET_KEY                                   Clerk's users, SAML connections and OAuth applications
 *   MAIL_STORE_ADMIN_URL, OUTBOUND_ADMIN_SECRET, MAIL_STORE_ADMIN_EMAIL   mailbox store modes (optional)
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import {
  clerkInventory,
  formatInventoryReport,
  mailStoreAdminFromEnv,
  mailStoreModes,
  masterInventory,
  sanitizeError,
  tenantInventory,
  type GlobalInventory,
  type MailStoreAdmin,
  type Query,
  type WorkspaceReport,
} from './lib/global-inventory';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const flag = (name: string): boolean => process.argv.includes(name);

/** A postgres-js connection whose every query is its own read-only transaction. */
function readOnlyConnection(url: string): { sql: postgres.Sql; query: Query } {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const query: Query = (text, params) =>
    sql.begin('read only', async (tx) => [...(await tx.unsafe(text, (params ?? []) as postgres.ParameterOrJSON<never>[]))]);
  return { sql, query };
}

interface ConnectionRow {
  id: string;
  neon_project_id: string | null;
  neon_branch_id: string | null;
  neon_role_name: string | null;
  neon_database_name: string | null;
  database_url: string | null;
}

interface Context {
  keyring: EncryptionKeyring;
  neonApiKey: string;
  mailAdmin: MailStoreAdmin | null;
}

/** One workspace's tenant inventory and mailbox modes; failures are recorded, never thrown. */
async function inventoryWorkspace(row: ConnectionRow, ctx: Context): Promise<WorkspaceReport> {
  const report: WorkspaceReport = { id: row.id, tenant: null, tenantSkipped: null, mailStoreModes: null };
  const hasMeta = Boolean(row.neon_project_id && row.neon_branch_id && row.neon_role_name);
  if (!row.database_url && !hasMeta) {
    report.tenantSkipped = 'no tenant database';
    return report;
  }

  let tenant: ReturnType<typeof readOnlyConnection> | null = null;
  try {
    const url = await resolveDatabaseUrl(
      ctx.neonApiKey,
      {
        id: row.id,
        databaseUrl: row.database_url,
        neonProjectId: row.neon_project_id ?? '',
        neonBranchId: row.neon_branch_id ?? '',
        neonRoleName: row.neon_role_name ?? '',
        neonDatabaseName: row.neon_database_name,
      },
      ctx.keyring,
    );
    tenant = readOnlyConnection(url);
    report.tenant = await tenantInventory(tenant.query);
  } catch (err) {
    report.tenantSkipped = `tenant database not read: ${sanitizeError(err)}`;
  } finally {
    await tenant?.sql.end({ timeout: 5 });
  }

  if (ctx.mailAdmin && (report.tenant?.mail.accounts ?? 0) > 0) {
    try {
      report.mailStoreModes = await mailStoreModes(ctx.mailAdmin, row.id);
    } catch (err) {
      report.mailStoreModes = { '(status call failed)': 1 };
      console.warn(`  mail-store status failed: ${sanitizeError(err)}`);
    }
  }
  return report;
}

async function main(): Promise<void> {
  const masterUrl = process.env.MASTER_DATABASE_URL;
  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  const outDir = path.resolve(arg('--out') ?? 'inventory-out');
  const only = arg('--only');
  const ctx: Context = {
    keyring: keyringFromEnv({
      DATABASE_ENCRYPTION_KEY: process.env.DATABASE_ENCRYPTION_KEY,
      DATABASE_ENCRYPTION_KEY_V2: process.env.DATABASE_ENCRYPTION_KEY_V2,
    }),
    neonApiKey: process.env.NEON_API_KEY ?? '',
    mailAdmin: flag('--skip-mail-store') ? null : mailStoreAdminFromEnv(process.env),
  };

  const master = readOnlyConnection(masterUrl);
  try {
    console.log('Reading the master database…');
    const masterInv = await masterInventory(master.query);
    const rows = (await master.query(
      `select id, neon_project_id, neon_branch_id, neon_role_name, neon_database_name, database_url
         from workspaces ${only ? 'where id = $1' : ''} order by created_at`,
      only ? [only] : [],
    )) as unknown as ConnectionRow[];

    const workspaces: WorkspaceReport[] = [];
    for (const [i, row] of rows.entries()) {
      console.log(`[${i + 1}/${rows.length}] ${row.id}`);
      workspaces.push(await inventoryWorkspace(row, ctx));
    }

    const clerkKey = process.env.CLERK_SECRET_KEY;
    const readClerk = Boolean(clerkKey) && !flag('--skip-clerk');
    if (readClerk) console.log('Reading Clerk…');
    const clerk = readClerk && clerkKey ? await clerkInventory(clerkKey) : null;

    const inventory: GlobalInventory = {
      generatedAt: new Date().toISOString(),
      master: masterInv,
      workspaces,
      clerk,
      mailStoreChecked: ctx.mailAdmin !== null,
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'global-inventory.json'), JSON.stringify(inventory, null, 2));
    await writeFile(path.join(outDir, 'global-inventory.md'), formatInventoryReport(inventory));
    console.log(`Wrote global-inventory.json and global-inventory.md to ${outDir}`);
  } finally {
    await master.sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(sanitizeError(err));
  process.exit(1);
});
