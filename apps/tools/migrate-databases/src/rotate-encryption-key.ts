#!/usr/bin/env node
/**
 * Field-encryption key rotation sweep (task_mrn6q2a4hariwbc6).
 *
 * Walks every encrypted column across the master DB and all tenant DBs,
 * decrypts legacy v1 values ("iv:ciphertext", DATABASE_ENCRYPTION_KEY) and
 * rewrites them as v2 ("v2:iv:ciphertext", DATABASE_ENCRYPTION_KEY_V2).
 *
 * Safe by default: without --execute it only reports counts. Idempotent:
 * values already in v2 format are skipped, so it can be re-run until the
 * report shows zero v1 values everywhere. Only after that may the v1 key be
 * removed from the secret stores.
 *
 * workspaces.database_url (audit finding 657): with FIELD_ENCRYPTION_AAD_WRITES
 * on, its v1 and v2 values are rewritten as v3 ("v3:iv:ciphertext", v2 key,
 * AES-GCM AAD = workspaces:<id>:database_url) so a copy onto another workspace
 * row no longer decrypts. Only turn it on once every worker that reads a tenant
 * connection string has been redeployed with v3 support. Values already in v3
 * are skipped, but each is opened with its own row id (needs the v2 key), so
 * a swapped or tampered value is reported as failed. The update is a
 * compare-and-swap on the value that was read, so re-running is safe.
 * Without the flag database_url behaves like every other column (v1 -> v2).
 *
 * Usage:
 *   pnpm rotate:key                    # dry-run report (master + all tenants)
 *   pnpm rotate:key:execute            # actually re-encrypt
 *   pnpm rotate:key -- --only org_123  # single workspace (+ master)
 *   pnpm rotate:key -- --tenants-only  # skip master DB
 *   pnpm rotate:key -- --master-only   # skip tenant DBs
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY, DATABASE_ENCRYPTION_KEY,
 * DATABASE_ENCRYPTION_KEY_V2 (the last one only for --execute, or to verify v3
 * values in a dry-run). Optional: FIELD_ENCRYPTION_AAD_WRITES=1 (see above).
 *
 * Never logs plaintext or key material.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import {
  aadWritesEnabled,
  decrypt,
  decryptWorkspaceDatabaseUrl,
  encrypt,
  encryptField,
  encryptWorkspaceDatabaseUrl,
  isAadBound,
  type EncryptionKeyring,
} from '@weldsuite/db/lib/crypto';

const V1_FORMAT = /^[0-9a-f]+:[0-9a-f]+$/i;
const V2_FORMAT = /^v2:[0-9a-f]+:[0-9a-f]+$/i;
const BATCH_SIZE = 200;

interface ColumnTarget {
  table: string;
  idColumn: string;
  column: string;
  /** 'workspace-database-url' is text bound to its row id (AAD) when AAD writes are on. */
  kind: 'text' | 'jsonb' | 'workspace-database-url';
}

/** Both keys, as the sweep always needs them (v2 is a placeholder in a dry-run without one). */
type RotationKeys = { v1: string; v2: string };

/** What the sweep may do to workspaces.database_url beyond the v1 -> v2 rotation. */
interface AadPolicy {
  /** FIELD_ENCRYPTION_AAD_WRITES: rewrite database_url as v3. */
  aadWrites: boolean;
  /** A real v2 key is configured, so v3 values can be opened and verified. */
  haveV2: boolean;
}

/** Master DB encrypted columns. */
const MASTER_TARGETS: ColumnTarget[] = [
  { table: 'workspaces', idColumn: 'id', column: 'database_url', kind: 'workspace-database-url' },
  { table: 'neon_shared_projects', idColumn: 'id', column: 'admin_password_encrypted', kind: 'text' },
];

/** Tenant DB encrypted columns (missing tables are skipped per-tenant). */
const TENANT_TARGETS: ColumnTarget[] = [
  { table: 'workflow_integrations', idColumn: 'id', column: 'oauth_tokens', kind: 'jsonb' },
  { table: 'workflow_integrations', idColumn: 'id', column: 'credentials', kind: 'jsonb' },
  { table: 'integration_connections', idColumn: 'id', column: 'oauth_tokens', kind: 'jsonb' },
  { table: 'integration_connections', idColumn: 'id', column: 'webhook_secret', kind: 'text' },
  { table: 'github_connections', idColumn: 'id', column: 'webhook_secret', kind: 'text' },
  { table: 'workflow_variables', idColumn: 'id', column: 'encrypted_value', kind: 'text' },
  { table: 'helpdesk_workflow_variables', idColumn: 'id', column: 'encrypted_value', kind: 'text' },
  { table: 'mail_accounts', idColumn: 'id', column: 'access_token', kind: 'text' },
  { table: 'mail_accounts', idColumn: 'id', column: 'refresh_token', kind: 'text' },
  { table: 'social_accounts', idColumn: 'id', column: 'access_token', kind: 'text' },
  { table: 'social_accounts', idColumn: 'id', column: 'refresh_token', kind: 'text' },
];

interface CliOptions {
  execute: boolean;
  only: string | null;
  masterOnly: boolean;
  tenantsOnly: boolean;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    execute: false,
    only: null,
    masterOnly: false,
    tenantsOnly: false,
    verbose: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--only' && args[i + 1]) options.only = args[++i] ?? null;
    else if (arg === '--master-only') options.masterOnly = true;
    else if (arg === '--tenants-only') options.tenantsOnly = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    }
  }
  return options;
}

interface SweepCounts {
  v1: number; // legacy values found (rewritten when --execute)
  v2: number; // already rotated
  plaintext: number; // unencrypted values (reported, untouched)
  failed: number; // v1-format values that failed to decrypt with the v1 key; v3 values that do not open for their row
  rewritten: number;
  v3: number; // workspaces.database_url values already AAD-bound
  aadPending: number; // workspaces.database_url values still v1/v2 (no AAD) when read
}

function newCounts(): SweepCounts {
  return { v1: 0, v2: 0, plaintext: 0, failed: 0, rewritten: 0, v3: 0, aadPending: 0 };
}

function addCounts(into: SweepCounts, from: SweepCounts) {
  into.v1 += from.v1;
  into.v2 += from.v2;
  into.plaintext += from.plaintext;
  into.failed += from.failed;
  into.rewritten += from.rewritten;
  into.v3 += from.v3;
  into.aadPending += from.aadPending;
}

/**
 * Re-encrypt one scalar value. Returns the new value, or null when no
 * rewrite is needed (already v2 / plaintext / undecryptable).
 */
async function rotateValue(
  value: string,
  keys: RotationKeys,
  counts: SweepCounts,
): Promise<string | null> {
  if (V2_FORMAT.test(value)) {
    counts.v2++;
    return null;
  }
  if (!V1_FORMAT.test(value)) {
    counts.plaintext++;
    return null;
  }
  counts.v1++;
  let plaintext: string;
  try {
    plaintext = await decrypt(value, keys.v1);
  } catch {
    // Hex-pair-shaped value that isn't v1 ciphertext (or wrong key) — leave it.
    counts.failed++;
    counts.v1--;
    counts.plaintext++;
    return null;
  }
  return `v2:${await encrypt(plaintext, keys.v2)}`;
}

/** Rotate every v1-encrypted string inside a JSONB object (one level deep,
 *  matching how oauth_tokens / credentials store their fields). */
async function rotateJsonb(
  obj: Record<string, unknown>,
  keys: RotationKeys,
  counts: SweepCounts,
): Promise<Record<string, unknown> | null> {
  let changed = false;
  const out: Record<string, unknown> = { ...obj };
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') continue;
    const rotated = await rotateValue(v, keys, counts);
    if (rotated !== null) {
      out[k] = rotated;
      changed = true;
    }
  }
  return changed ? out : null;
}

interface RawRow {
  id: string;
  value: unknown;
}

/**
 * Fetch one batch of rows for a target. Returns null when the table or
 * column doesn't exist in this database (caller skips the target).
 */
async function fetchBatch(
  sql: postgres.Sql,
  target: ColumnTarget,
  offset: number,
  verbose: boolean,
): Promise<RawRow[] | null> {
  const { table, idColumn, column } = target;
  try {
    return (await sql.unsafe(
      `SELECT ${idColumn} AS id, ${column} AS value FROM ${table}
         WHERE ${column} IS NOT NULL
         ORDER BY ${idColumn} LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    )) as unknown as RawRow[];
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01' || code === '42703') {
      // Table or column doesn't exist in this database — fine, skip.
      if (verbose) console.log(`    ${table}.${column}: not present, skipped`);
      return null;
    }
    throw err;
  }
}

async function rotateTextRow(
  sql: postgres.Sql,
  target: ColumnTarget,
  row: RawRow,
  keys: RotationKeys,
  execute: boolean,
  counts: SweepCounts,
  _aad: AadPolicy,
): Promise<void> {
  const { table, idColumn, column } = target;
  if (typeof row.value !== 'string') return;
  const rotated = await rotateValue(row.value, keys, counts);
  if (rotated !== null && execute) {
    await sql.unsafe(`UPDATE ${table} SET ${column} = $1 WHERE ${idColumn} = $2`, [
      rotated,
      row.id,
    ]);
    counts.rewritten++;
  }
}

/** A v3 database_url must open for its own row; anything else is counted as failed. */
async function verifyAadBoundUrl(
  value: string,
  workspaceId: string,
  keyring: EncryptionKeyring,
  counts: SweepCounts,
  label: string,
): Promise<void> {
  try {
    await decryptWorkspaceDatabaseUrl(value, workspaceId, keyring);
  } catch {
    // Sealed for another workspace, tampered with, or the wrong v2 key.
    counts.failed++;
    console.error(`    ${label}: v3 value does not open for this workspace`);
  }
}

/**
 * Decrypt a v1/v2 database_url and count it. Null (counted as failed) when it
 * does not decrypt.
 */
async function openLegacyDatabaseUrl(
  value: string,
  isV2: boolean,
  workspaceId: string,
  keyring: EncryptionKeyring,
  counts: SweepCounts,
  label: string,
): Promise<string | null> {
  let plaintext: string;
  try {
    plaintext = await decryptWorkspaceDatabaseUrl(value, workspaceId, keyring);
  } catch {
    counts.failed++;
    if (isV2) {
      counts.v2++;
      console.error(`    ${label}: v2 value does not decrypt`);
    } else {
      // Hex-pair-shaped value that isn't v1 ciphertext (or wrong key) — leave it.
      counts.plaintext++;
    }
    return null;
  }
  if (isV2) counts.v2++;
  else counts.v1++;
  counts.aadPending++;
  return plaintext;
}

/**
 * workspaces.database_url. v1/v2 values are decrypted and, with AAD writes on,
 * resealed as v3 bound to the row's id; otherwise v1 is rotated to v2 like any
 * other column. v3 values are left alone (verified against their row when the
 * v2 key is available). Idempotent, and the UPDATE only lands if the value is
 * still the one that was read.
 */
async function rotateWorkspaceDatabaseUrlRow(
  sql: postgres.Sql,
  target: ColumnTarget,
  row: RawRow,
  keys: RotationKeys,
  execute: boolean,
  counts: SweepCounts,
  aad: AadPolicy,
): Promise<void> {
  const { table, idColumn, column } = target;
  if (typeof row.value !== 'string') return;
  const value = row.value;
  const label = `${table}.${column} ${row.id}`;
  const keyring: EncryptionKeyring = { v1: keys.v1, v2: keys.v2 };
  const toV3 = aad.aadWrites && aad.haveV2;

  if (isAadBound(value)) {
    counts.v3++;
    if (aad.haveV2) await verifyAadBoundUrl(value, row.id, keyring, counts, label);
    return;
  }

  const isV2 = V2_FORMAT.test(value);
  if (!isV2 && !V1_FORMAT.test(value)) {
    counts.plaintext++;
    return;
  }

  // A v2 value only has work to do when it is going to become v3; otherwise it is
  // counted and left alone, as for every other column.
  if (isV2 && !toV3) {
    counts.v2++;
    counts.aadPending++;
    return;
  }

  const plaintext = await openLegacyDatabaseUrl(value, isV2, row.id, keyring, counts, label);
  if (plaintext === null || !execute) return;

  // Target format: v3 with AAD writes on; otherwise only v1 moves (to v2).
  const rewrittenValue = toV3
    ? await encryptWorkspaceDatabaseUrl(plaintext, row.id, { ...keyring, aadWrites: true })
    : await encryptField(plaintext, { v2: keys.v2 });

  const result = await sql.unsafe(
    `UPDATE ${table} SET ${column} = $1 WHERE ${idColumn} = $2 AND ${column} = $3`,
    [rewrittenValue, row.id, value],
  );
  if (result.count === 0) {
    console.error(`    ${table}.${column} ${row.id}: changed while sweeping, skipped (re-run)`);
    return;
  }
  counts.rewritten++;
}

async function rotateJsonbRow(
  sql: postgres.Sql,
  target: ColumnTarget,
  row: RawRow,
  keys: RotationKeys,
  execute: boolean,
  counts: SweepCounts,
  _aad: AadPolicy,
): Promise<void> {
  const { table, idColumn, column } = target;
  if (row.value === null || typeof row.value !== 'object' || Array.isArray(row.value)) return;
  const rotated = await rotateJsonb(row.value as Record<string, unknown>, keys, counts);
  if (rotated !== null && execute) {
    await sql.unsafe(`UPDATE ${table} SET ${column} = $1::jsonb WHERE ${idColumn} = $2`, [
      JSON.stringify(rotated),
      row.id,
    ]);
    counts.rewritten++;
  }
}

const ROW_ROTATORS = {
  text: rotateTextRow,
  jsonb: rotateJsonbRow,
  'workspace-database-url': rotateWorkspaceDatabaseUrlRow,
} satisfies Record<ColumnTarget['kind'], unknown>;

async function sweepTarget(
  sql: postgres.Sql,
  target: ColumnTarget,
  keys: RotationKeys,
  execute: boolean,
  verbose: boolean,
  aad: AadPolicy,
): Promise<SweepCounts> {
  const counts = newCounts();
  const { table, column, kind } = target;
  const rotateRow = ROW_ROTATORS[kind];

  let offset = 0;
  for (;;) {
    const rows = await fetchBatch(sql, target, offset, verbose);
    if (rows === null) return counts;

    if (rows.length === 0) break;

    for (const row of rows) {
      await rotateRow(sql, target, row, keys, execute, counts, aad);
    }

    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  if (verbose && (counts.v1 || counts.v2 || counts.v3)) {
    console.log(
      `    ${table}.${column}: v1=${counts.v1} v2=${counts.v2} v3=${counts.v3} plaintext=${counts.plaintext} rewritten=${counts.rewritten}`,
    );
  }
  return counts;
}

async function sweepDatabase(
  label: string,
  databaseUrl: string,
  targets: ColumnTarget[],
  keys: RotationKeys,
  execute: boolean,
  verbose: boolean,
  aad: AadPolicy,
): Promise<SweepCounts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  try {
    for (const target of targets) {
      addCounts(counts, await sweepTarget(sql, target, keys, execute, verbose, aad));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  let status = 'clean';
  if (counts.v1 !== 0) status = execute ? 'rotated' : 'NEEDS ROTATION';
  if (counts.aadPending !== 0 && aad.aadWrites) status = execute ? 'rotated (AAD)' : 'NEEDS AAD UPGRADE';
  const aadReport =
    counts.v3 || counts.aadPending ? ` database_url: v3=${counts.v3} no-aad=${counts.aadPending}` : '';
  console.log(
    `  ${label}: v1=${counts.v1} v2=${counts.v2} plaintext=${counts.plaintext} failed=${counts.failed} rewritten=${counts.rewritten}${aadReport} → ${status}`,
  );
  return counts;
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
  const db = drizzle(masterClient);
  const conditions = [eq(workspaces.isActive, true), isNotNull(workspaces.neonProjectId)];
  if (only) conditions.push(eq(workspaces.id, only));

  const rows = await db
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
  await masterClient.end({ timeout: 5 });
  return rows;
}

async function sweepTenants(
  masterUrl: string,
  neonApiKey: string,
  keyring: EncryptionKeyring,
  keys: RotationKeys,
  options: CliOptions,
  total: SweepCounts,
  aad: AadPolicy,
): Promise<void> {
  const rows = await loadTenantRows(masterUrl, options.only);

  console.log(`\nTenant DBs (${rows.length}):`);
  for (const w of rows) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    try {
      const url = await resolveDatabaseUrl(neonApiKey, w as never, keyring);
      addCounts(
        total,
        await sweepDatabase(w.id, url, TENANT_TARGETS, keys, options.execute, options.verbose, aad),
      );
    } catch (err) {
      console.error(`  ${w.id}: FAILED to connect/sweep — ${(err as Error).message}`);
      total.failed++;
    }
  }
}

function printTotals(total: SweepCounts, execute: boolean): void {
  console.log(
    `\nTOTAL: v1=${total.v1} v2=${total.v2} plaintext=${total.plaintext} failed=${total.failed} rewritten=${total.rewritten}`,
  );
  if (total.v3 || total.aadPending) {
    console.log(
      `workspaces.database_url: AAD-bound (v3)=${total.v3} without AAD=${total.aadPending}${
        execute && total.aadPending ? ' (upgraded above where AAD writes are on)' : ''
      }`,
    );
  }
  if (total.v1 === 0 && total.failed === 0) {
    console.log('All encrypted values are on v2 — the v1 key can be retired.');
  } else if (!execute) {
    console.log('Dry-run only. Re-run with --execute to rotate.');
  }
}

async function main() {
  const options = parseArgs();

  const masterUrl = process.env.MASTER_DATABASE_URL;
  const neonApiKey = process.env.NEON_API_KEY || '';
  const v1 = process.env.DATABASE_ENCRYPTION_KEY;
  const v2 = process.env.DATABASE_ENCRYPTION_KEY_V2;

  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  if (!v1) throw new Error('DATABASE_ENCRYPTION_KEY (v1) is required');
  if (options.execute && !v2) {
    throw new Error('DATABASE_ENCRYPTION_KEY_V2 is required with --execute');
  }
  // Dry-run works without a v2 key: rotateValue only encrypts on execute paths
  // that we never reach, but keep the type simple with a placeholder.
  const keys: RotationKeys = { v1, v2: v2 ?? '0'.repeat(64) };
  const aad: AadPolicy = {
    aadWrites: aadWritesEnabled(process.env.FIELD_ENCRYPTION_AAD_WRITES),
    haveV2: Boolean(v2),
  };

  console.log(
    `Encryption-key rotation sweep — mode: ${options.execute ? 'EXECUTE' : 'dry-run'}, database_url AAD (v3) writes: ${aad.aadWrites ? 'ON' : 'off'}`,
  );

  const total = newCounts();

  // Master DB
  if (!options.tenantsOnly) {
    console.log('\nMaster DB:');
    addCounts(
      total,
      await sweepDatabase('master', masterUrl, MASTER_TARGETS, keys, options.execute, options.verbose, aad),
    );
  }

  // Tenant DBs
  if (!options.masterOnly) {
    await sweepTenants(masterUrl, neonApiKey, { v1, v2 }, keys, options, total, aad);
  }

  printTotals(total, options.execute);
  process.exit(total.failed > 0 ? 1 : 0);
}

try {
  await main();
} catch (err) {
  console.error('Sweep failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
