#!/usr/bin/env node
/**
 * Audit what is ACTUALLY stored in the 16 `custom_fields` JSONB blobs.
 *
 * Phase 4 of the custom-fields refactor (docs/custom-fields-values-table.md)
 * drops these columns. That is only safe if every key inside them is a
 * user-defined custom field with a matching `custom_field_definitions` row —
 * because those are the only keys the Phase 2 backfill migrated into
 * `custom_field_values`.
 *
 * That assumption turned out to be FALSE: several features use the blob as a
 * general extension bag under hard-coded keys (`tasks.attachments`,
 * `mail_messages.snoozedUntil`, ...). Those keys have no definition, were never
 * backfilled, and would be destroyed by the drop.
 *
 * This script enumerates every distinct top-level key per table per tenant and
 * cross-references it against the active definitions, so the drop decision is
 * made against real data instead of an assumption.
 *
 * READ-ONLY. Never writes. Safe to run against production.
 *
 * Usage:
 *   pnpm audit:blobs                    # all tenants
 *   pnpm audit:blobs -- --only ws_abc   # single workspace
 *   pnpm audit:blobs -- --keys          # list every key, not just unmapped ones
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY (+ DATABASE_ENCRYPTION_KEY when
 * tenant URLs are stored encrypted).
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';

/**
 * All 16 blob-bearing tables, with the custom-field `entityType` whose
 * definitions govern that table. The first six are the wired set; the rest are
 * best-effort guesses (they have no wired surface, so in practice they have no
 * definitions at all and every key comes back unmapped — which is exactly the
 * signal we want).
 */
const TABLES: { table: string; entityType: string }[] = [
  { table: 'companies', entityType: 'company' },
  { table: 'people', entityType: 'person' },
  { table: 'tasks', entityType: 'task' },
  { table: 'crm_opportunities', entityType: 'opportunity' },
  { table: 'crm_activities', entityType: 'activity' },
  { table: 'helpdesk_tickets', entityType: 'ticket' },
  { table: 'products', entityType: 'product' },
  { table: 'product_variants', entityType: 'product_variant' },
  { table: 'helpdesk_conversations', entityType: 'conversation' },
  { table: 'helpdesk_articles', entityType: 'article' },
  { table: 'mail_messages', entityType: 'mail_message' },
  { table: 'mail_accounts', entityType: 'mail_account' },
  { table: 'calendar_events', entityType: 'calendar_event' },
  { table: 'discounts', entityType: 'discount' },
  { table: 'categories', entityType: 'category' },
  { table: 'parcels', entityType: 'parcel' },
];

interface CliOptions {
  only: string | null;
  showAllKeys: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { only: null, showAllKeys: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--only' && args[i + 1]) options.only = args[++i] ?? null;
    else if (arg === '--keys') options.showAllKeys = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    }
  }
  return options;
}

/** key -> { rows, tables, tenants } aggregated across the whole fleet. */
interface KeyStat {
  key: string;
  table: string;
  rows: number;
  mapped: boolean;
  tenants: Set<string>;
}

const unmapped = new Map<string, KeyStat>();
const mapped = new Map<string, KeyStat>();

function record(into: Map<string, KeyStat>, table: string, key: string, rows: number, tenant: string, isMapped: boolean) {
  const id = `${table}.${key}`;
  const existing = into.get(id);
  if (existing) {
    existing.rows += rows;
    existing.tenants.add(tenant);
  } else {
    into.set(id, { key, table, rows, mapped: isMapped, tenants: new Set([tenant]) });
  }
}

type Sql = ReturnType<typeof postgres>;

/**
 * Distinct top-level keys (with row counts) in `<table>.custom_fields`.
 * Returns null when the table or column is absent in this tenant.
 */
async function fetchBlobKeyRows(sql: Sql, table: string): Promise<{ key: string; n: string }[] | null> {
  try {
    return (await sql.unsafe(
      `SELECT kv.key AS key, count(*) AS n
         FROM ${table} t, jsonb_each(t.custom_fields) AS kv(key, val)
        WHERE t.custom_fields IS NOT NULL
          AND jsonb_typeof(t.custom_fields) = 'object'
        GROUP BY kv.key
        ORDER BY n DESC`,
    )) as unknown as { key: string; n: string }[];
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Table or column absent in this tenant — fine, skip.
    if (code === '42P01' || code === '42703') return null;
    throw err;
  }
}

async function auditTable(
  sql: Sql,
  table: string,
  entityType: string,
  label: string,
  options: CliOptions,
  findings: string[],
) {
  const keyRows = await fetchBlobKeyRows(sql, table);
  if (keyRows === null || keyRows.length === 0) return;

  const defs = (await sql.unsafe(
    `SELECT slug FROM custom_field_definitions
      WHERE entity_type = $1 AND deleted_at IS NULL`,
    [entityType] as never[],
  )) as unknown as { slug: string }[];
  const slugs = new Set(defs.map((d) => d.slug));

  for (const { key, n } of keyRows) {
    const isMapped = slugs.has(key);
    record(isMapped ? mapped : unmapped, table, key, Number(n), label, isMapped);
    if (!isMapped) findings.push(`      ${table}.${key} — ${n} row(s)`);
    else if (options.showAllKeys) findings.push(`      ${table}.${key} — ${n} row(s) [defined]`);
  }
}

async function auditTenant(label: string, databaseUrl: string, options: CliOptions) {
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  const findings: string[] = [];

  try {
    for (const { table, entityType } of TABLES) {
      await auditTable(sql, table, entityType, label, options, findings);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (findings.length > 0) {
    console.log(`  ${label}:`);
    findings.forEach((f) => console.log(f));
  } else {
    console.log(`  ${label}: clean`);
  }
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

/** Audits every tenant in order; returns how many could not be audited. */
async function auditAllTenants(
  rows: Awaited<ReturnType<typeof loadActiveTenants>>,
  neonApiKey: string,
  keys: { v1: string | undefined; v2: string | undefined },
  options: CliOptions,
): Promise<number> {
  let failed = 0;
  for (const w of rows) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    try {
      const url = await resolveDatabaseUrl(neonApiKey, w as never, keys);
      await auditTenant(w.id, url, options);
    } catch (err) {
      console.error(`  ${w.id}: FAILED — ${(err as Error).message}`);
      failed++;
    }
  }
  return failed;
}

function printStatLine(s: KeyStat) {
  console.log(`  ${s.table}.${s.key}`.padEnd(52) + `${s.rows} row(s) across ${s.tenants.size} tenant(s)`);
}

function printUnmapped(unmappedList: KeyStat[]) {
  console.log('\n============================================================');
  console.log('UNMAPPED KEYS — no active definition, NOT migrated by the');
  console.log('Phase 2 backfill, and DESTROYED if Phase 4 drops the column.');
  console.log('============================================================');
  if (unmappedList.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const s of unmappedList) printStatLine(s);
}

function printMapped(mappedList: KeyStat[]) {
  console.log('\n--- mapped keys (have a definition; safely migrated) ---');
  if (mappedList.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const s of mappedList) printStatLine(s);
}

async function main() {
  const options = parseArgs();

  const masterUrl = process.env.MASTER_DATABASE_URL;
  const neonApiKey = process.env.NEON_API_KEY || '';
  const v1 = process.env.DATABASE_ENCRYPTION_KEY;
  const v2 = process.env.DATABASE_ENCRYPTION_KEY_V2;
  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');

  console.log('Custom-field blob audit — READ ONLY\n');

  const rows = await loadActiveTenants(masterUrl, options.only);

  console.log(`Tenants (${rows.length}):`);
  const failed = await auditAllTenants(rows, neonApiKey, { v1, v2 }, options);

  const unmappedList = [...unmapped.values()].sort((a, b) => b.rows - a.rows);
  printUnmapped(unmappedList);

  const mappedList = [...mapped.values()].sort((a, b) => b.rows - a.rows);
  printMapped(mappedList);

  console.log(
    `\nVERDICT: ${unmappedList.length === 0
      ? 'no unmapped keys found — the drop would not lose data in this environment.'
      : `${unmappedList.length} unmapped key(s) MUST be migrated elsewhere before Phase 4.`}`,
  );
  if (failed > 0) console.log(`WARNING: ${failed} tenant(s) could not be audited — result is incomplete.`);
  process.exit(failed > 0 || unmappedList.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Audit failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
