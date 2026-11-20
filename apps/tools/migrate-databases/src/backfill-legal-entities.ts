#!/usr/bin/env node
/**
 * Legal entities, release 1: the TypeScript half of the backfill
 * (weldsuite-documentation/plans/legal-entities.md, "Release 1 (expand)"). Tenant migration 0249
 * has done the deterministic copies; this does what SQL cannot, per tenant
 * database (logic and details in ./lib/legal-entities-backfill.ts):
 *
 *   1. decrypt hr_payroll_employers.bank_encrypted, match or create the core
 *      bank account on the employer's legal entity, move nachaCompanyId into
 *      ach_settings.companyIdentification, set bank_account_id;
 *   2. entities.bank_details → a core bank account, set as
 *      accounting_entity_settings.invoice_bank_account_id;
 *   3. merge workspace_settings into the default legal entity (fill-only,
 *      differences reported), or create the default when there is no entity;
 *   4. fill the remaining hr_employees.legal_entity_id;
 *   5. report ambiguous einOrSsn values, bank blobs that cannot be moved and
 *      conflicts.
 *
 * Safe by default: without --execute it plans in a read-only transaction and
 * writes nothing; the report shows exactly what --execute would write. With
 * --execute each workspace is written in one transaction. Idempotent: a
 * second run reports nothing to change. Run it on test, review the report,
 * then production.
 *
 * Usage:
 *   pnpm backfill:legal-entities                    # dry-run report, all tenants
 *   pnpm backfill:legal-entities:execute            # write
 *   pnpm backfill:legal-entities -- --only ws_123   # one workspace (workspaces.id or Clerk org id)
 *   pnpm backfill:legal-entities -- --quiet         # print only workspaces with changes or findings
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY, DATABASE_ENCRYPTION_KEY and
 * DATABASE_ENCRYPTION_KEY_V2 (bank blobs are v1 or v2; new account numbers are
 * sealed with the v2 key when it is set, as the workers do).
 *
 * Never logs plaintext account numbers, tax ids or key material.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq, isNotNull } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { matchWorkspaceRef } from '@weldsuite/db/lib/workspace-ref';
import { keyringFromEnv, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';
import {
  addToSummary,
  backfillLegalEntities,
  ConcurrentChangeError,
  emptySummary,
  formatSummary,
  formatWorkspaceReport,
  type BackfillSummary,
  type WorkspaceBackfillReport,
} from './lib/legal-entities-backfill';

interface CliOptions {
  execute: boolean;
  only: string | null;
  quiet: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { execute: false, only: null, quiet: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--dry-run') options.execute = false;
    else if (arg === '--only' && args[i + 1]) options.only = args[++i] ?? null;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    }
  }
  return options;
}

interface TenantRow {
  id: string;
  name: string;
  neonProjectId: string | null;
  neonBranchId: string | null;
  neonRoleName: string | null;
  neonDatabaseName: string | null;
  databaseUrl: string | null;
}

async function loadTenantRows(masterUrl: string, only: string | null): Promise<TenantRow[]> {
  const masterClient = postgres(masterUrl, { max: 1, ssl: 'require', prepare: false });
  try {
    const db = drizzle(masterClient);
    const conditions = [eq(workspaces.isActive, true), isNotNull(workspaces.neonProjectId)];
    if (only) conditions.push(matchWorkspaceRef(only));
    return await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        neonProjectId: workspaces.neonProjectId,
        neonBranchId: workspaces.neonBranchId,
        neonRoleName: workspaces.neonRoleName,
        neonDatabaseName: workspaces.neonDatabaseName,
        databaseUrl: workspaces.databaseUrl,
      })
      .from(workspaces)
      .where(and(...conditions));
  } finally {
    await masterClient.end({ timeout: 5 });
  }
}

/** The database error itself (not drizzle's wrapper, which repeats the query and its parameters), without connection strings. */
function safeMessage(err: unknown): string {
  const cause = (err as { cause?: unknown }).cause;
  const source = cause instanceof Error ? cause : err;
  const message = source instanceof Error ? source.message : String(source);
  return message.replaceAll(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-connection-string>');
}

function hasFindings(report: WorkspaceBackfillReport): boolean {
  return (
    report.changes > 0 ||
    report.differences.length > 0 ||
    report.conflicts.length > 0 ||
    report.bankIssues.length > 0 ||
    report.taxIdsToReview.length > 0 ||
    report.notes.length > 0
  );
}

async function backfillTenant(
  tenant: TenantRow,
  neonApiKey: string,
  keyring: EncryptionKeyring,
  options: CliOptions,
  summary: BackfillSummary,
): Promise<void> {
  const label = `${tenant.id} (${tenant.name})`;
  if (!tenant.neonProjectId || !tenant.neonBranchId || !tenant.neonRoleName) {
    console.log(`  ${label}: skipped, no Neon connection details`);
    return;
  }
  let client: postgres.Sql | null = null;
  try {
    const url = await resolveDatabaseUrl(
      neonApiKey,
      {
        id: tenant.id,
        databaseUrl: tenant.databaseUrl,
        neonProjectId: tenant.neonProjectId,
        neonBranchId: tenant.neonBranchId,
        neonRoleName: tenant.neonRoleName,
        neonDatabaseName: tenant.neonDatabaseName,
      },
      keyring,
    );
    client = postgres(url, { max: 1, ssl: 'require', prepare: false });
    const db = drizzle(client, { schema });
    const report = await backfillLegalEntities(db, keyring, { execute: options.execute });
    addToSummary(summary, report);
    if (!options.quiet || hasFindings(report)) {
      for (const line of formatWorkspaceReport(label, report)) console.log(line);
    }
  } catch (err) {
    summary.workspaces += 1;
    summary.failed += 1;
    if (err instanceof ConcurrentChangeError) console.error(`  ${label}: ROLLED BACK, ${err.message}`);
    else console.error(`  ${label}: FAILED, ${safeMessage(err)}`);
  } finally {
    if (client) await client.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const options = parseArgs();
  const masterUrl = process.env.MASTER_DATABASE_URL;
  const neonApiKey = process.env.NEON_API_KEY ?? '';
  const keyring = keyringFromEnv({
    DATABASE_ENCRYPTION_KEY: process.env.DATABASE_ENCRYPTION_KEY,
    DATABASE_ENCRYPTION_KEY_V2: process.env.DATABASE_ENCRYPTION_KEY_V2,
  });

  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  if (!keyring.v1 && !keyring.v2) {
    throw new Error('DATABASE_ENCRYPTION_KEY (and DATABASE_ENCRYPTION_KEY_V2) are required to read the bank details');
  }
  if (!keyring.v2) console.log('No DATABASE_ENCRYPTION_KEY_V2: v2 bank blobs will be reported as undecryptable.');
  if (!keyring.v1) console.log('No DATABASE_ENCRYPTION_KEY: v1 bank blobs will be reported as undecryptable.');

  console.log(`Legal entities backfill, mode: ${options.execute ? 'EXECUTE' : 'dry-run (writes nothing)'}`);
  const tenants = await loadTenantRows(masterUrl, options.only);
  console.log(`\nTenant DBs (${tenants.length}):`);

  const summary = emptySummary();
  for (const tenant of tenants) {
    await backfillTenant(tenant, neonApiKey, keyring, options, summary);
  }

  for (const line of formatSummary(summary, options.execute)) console.log(line);
  if (!options.execute && summary.changes > 0) console.log('Dry-run only. Review the report, then re-run with --execute.');
  if (options.execute && summary.failed === 0) console.log('Done. A second run should report nothing to change.');
  process.exit(summary.failed > 0 ? 1 : 0);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', safeMessage(err));
  process.exit(1);
}
