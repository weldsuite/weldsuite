#!/usr/bin/env tsx
/**
 * Read-only inventory of the Global deployment, for phase 0 of Global's
 * retirement (ADR OPS-025). Reads the master database, every tenant
 * database, Clerk and (optionally) mail-api's mailbox-store status, and writes
 * `global-inventory.json` and `global-inventory.md` to the output folder.
 *
 * Every session is set read-only before the first query. The report holds
 * workspace ids and counts, not names, addresses or domains.
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
import { keyringFromEnv } from '@weldsuite/db/lib/crypto';
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
  type Query,
  type WorkspaceReport,
} from './lib/global-inventory';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const flag = (name: string): boolean => process.argv.includes(name);

/** A postgres-js connection whose session can't write. */
async function readOnlyConnection(url: string): Promise<{ sql: postgres.Sql; query: Query }> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`set session characteristics as transaction read only`;
  const query: Query = async (text, params) => [...(await sql.unsafe(text, (params ?? []) as postgres.ParameterOrJSON<never>[]))];
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

async function main(): Promise<void> {
  const masterUrl = process.env.MASTER_DATABASE_URL;
  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  const outDir = path.resolve(arg('--out') ?? 'inventory-out');
  const only = arg('--only');
  const keyring = keyringFromEnv({
    DATABASE_ENCRYPTION_KEY: process.env.DATABASE_ENCRYPTION_KEY,
    DATABASE_ENCRYPTION_KEY_V2: process.env.DATABASE_ENCRYPTION_KEY_V2,
  });
  const neonApiKey = process.env.NEON_API_KEY ?? '';

  const master = await readOnlyConnection(masterUrl);
  try {
    console.log('Reading the master database…');
    const masterInv = await masterInventory(master.query);

    const rows = (await master.query(
      `select id, neon_project_id, neon_branch_id, neon_role_name, neon_database_name, database_url
         from workspaces ${only ? 'where id = $1' : ''} order by created_at`,
      only ? [only] : [],
    )) as unknown as ConnectionRow[];

    const mailAdmin = flag('--skip-mail-store') ? null : mailStoreAdminFromEnv(process.env);
    const workspaces: WorkspaceReport[] = [];
    for (const [i, row] of rows.entries()) {
      console.log(`[${i + 1}/${rows.length}] ${row.id}`);
      const report: WorkspaceReport = { id: row.id, tenant: null, tenantSkipped: null, mailStoreModes: null };
      const hasMeta = row.neon_project_id && row.neon_branch_id && row.neon_role_name;
      if (!row.database_url && !hasMeta) {
        report.tenantSkipped = 'no tenant database';
      } else {
        let tenant: Awaited<ReturnType<typeof readOnlyConnection>> | null = null;
        try {
          const url = await resolveDatabaseUrl(
            neonApiKey,
            {
              id: row.id,
              databaseUrl: row.database_url,
              neonProjectId: row.neon_project_id ?? '',
              neonBranchId: row.neon_branch_id ?? '',
              neonRoleName: row.neon_role_name ?? '',
              neonDatabaseName: row.neon_database_name,
            },
            keyring,
          );
          tenant = await readOnlyConnection(url);
          report.tenant = await tenantInventory(tenant.query);
        } catch (err) {
          report.tenantSkipped = `tenant database not read: ${sanitizeError(err)}`;
        } finally {
          await tenant?.sql.end({ timeout: 5 });
        }
      }
      if (mailAdmin && (report.tenant?.mail.accounts ?? 0) > 0) {
        try {
          report.mailStoreModes = await mailStoreModes(mailAdmin, row.id);
        } catch (err) {
          report.mailStoreModes = { '(status call failed)': 1 };
          console.warn(`  mail-store status failed: ${sanitizeError(err)}`);
        }
      }
      workspaces.push(report);
    }

    const clerkKey = process.env.CLERK_SECRET_KEY;
    let clerk = null;
    if (clerkKey && !flag('--skip-clerk')) {
      console.log('Reading Clerk…');
      clerk = await clerkInventory(clerkKey);
    }

    const inventory: GlobalInventory = {
      generatedAt: new Date().toISOString(),
      master: masterInv,
      workspaces,
      clerk,
      mailStoreChecked: mailAdmin !== null,
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
