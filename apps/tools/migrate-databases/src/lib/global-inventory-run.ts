/**
 * The Global inventory run (ADR OPS-025, phase 0): the master database, every
 * tenant database, Clerk and optionally mail-api, written to
 * `global-inventory.json` and `global-inventory.md`. `src/global-inventory.ts`
 * is the command line around it.
 *
 * Every query runs in a read-only transaction of its own. A session-level
 * `SET … read only` would not do: Neon's pooler is PgBouncer in transaction
 * mode, so the setting would stay on a pooled backend that then serves the
 * live workers, while later queries could land on a backend that never ran
 * it.
 */

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
} from './global-inventory';

/** A postgres-js connection whose every query is its own read-only transaction. */
export function readOnlyConnection(url: string): { sql: postgres.Sql; query: Query } {
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
  fetchFn: typeof fetch;
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
      report.mailStoreModes = await mailStoreModes(ctx.mailAdmin, row.id, ctx.fetchFn);
    } catch (err) {
      report.mailStoreModes = { '(status call failed)': 1 };
      report.tenant?.errors.push(`mail-store status: ${sanitizeError(err)}`);
    }
  }
  return report;
}

export interface InventoryRunOptions {
  /** Reads `MASTER_DATABASE_URL`, the encryption keys, `NEON_API_KEY`, `CLERK_SECRET_KEY` and the mail-store admin settings. */
  env: NodeJS.ProcessEnv;
  outDir: string;
  /** One workspace (`workspaces.id`) instead of all. */
  only?: string;
  skipClerk?: boolean;
  skipMailStore?: boolean;
  log?: (line: string) => void;
  fetchFn?: typeof fetch;
}

/** Runs the inventory and writes both reports into `outDir`; returns what it wrote. */
export async function runGlobalInventory(options: InventoryRunOptions): Promise<GlobalInventory> {
  const { env } = options;
  const log = options.log ?? (() => {});
  const masterUrl = env.MASTER_DATABASE_URL;
  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  const ctx: Context = {
    keyring: keyringFromEnv({
      DATABASE_ENCRYPTION_KEY: env.DATABASE_ENCRYPTION_KEY,
      DATABASE_ENCRYPTION_KEY_V2: env.DATABASE_ENCRYPTION_KEY_V2,
    }),
    neonApiKey: env.NEON_API_KEY ?? '',
    mailAdmin: options.skipMailStore ? null : mailStoreAdminFromEnv(env),
    fetchFn: options.fetchFn ?? fetch,
  };

  const master = readOnlyConnection(masterUrl);
  try {
    log('Reading the master database…');
    const masterInv = await masterInventory(master.query);
    const rows = (await master.query(
      `select id, neon_project_id, neon_branch_id, neon_role_name, neon_database_name, database_url
         from workspaces ${options.only ? 'where id = $1' : ''} order by created_at`,
      options.only ? [options.only] : [],
    )) as unknown as ConnectionRow[];

    const workspaces: WorkspaceReport[] = [];
    for (const [i, row] of rows.entries()) {
      log(`[${i + 1}/${rows.length}] ${row.id}`);
      workspaces.push(await inventoryWorkspace(row, ctx));
    }

    const clerkKey = options.skipClerk ? undefined : env.CLERK_SECRET_KEY;
    if (clerkKey) log('Reading Clerk…');
    const clerk = clerkKey ? await clerkInventory(clerkKey, ctx.fetchFn) : null;

    const inventory: GlobalInventory = {
      generatedAt: new Date().toISOString(),
      master: masterInv,
      workspaces,
      clerk,
      mailStoreChecked: ctx.mailAdmin !== null,
    };
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path.join(options.outDir, 'global-inventory.json'), JSON.stringify(inventory, null, 2));
    await writeFile(path.join(options.outDir, 'global-inventory.md'), formatInventoryReport(inventory));
    log(`Wrote global-inventory.json and global-inventory.md to ${options.outDir}`);
    return inventory;
  } finally {
    await master.sql.end({ timeout: 5 });
  }
}
