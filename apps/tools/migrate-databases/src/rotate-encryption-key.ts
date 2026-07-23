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
 * Usage:
 *   pnpm rotate:key                    # dry-run report (master + all tenants)
 *   pnpm rotate:key:execute            # actually re-encrypt
 *   pnpm rotate:key -- --only org_123  # single workspace (+ master)
 *   pnpm rotate:key -- --tenants-only  # skip master DB
 *   pnpm rotate:key -- --master-only   # skip tenant DBs
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY, DATABASE_ENCRYPTION_KEY,
 * DATABASE_ENCRYPTION_KEY_V2 (the last one only for --execute).
 *
 * Never logs plaintext or key material.
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import { decrypt, encrypt, type EncryptionKeyring } from '@weldsuite/db/lib/crypto';

const V1_FORMAT = /^[0-9a-f]+:[0-9a-f]+$/i;
const V2_FORMAT = /^v2:[0-9a-f]+:[0-9a-f]+$/i;
const BATCH_SIZE = 200;

interface ColumnTarget {
  table: string;
  idColumn: string;
  column: string;
  kind: 'text' | 'jsonb';
}

/** Master DB encrypted columns. */
const MASTER_TARGETS: ColumnTarget[] = [
  { table: 'workspaces', idColumn: 'id', column: 'database_url', kind: 'text' },
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
  failed: number; // v1-format values that failed to decrypt with the v1 key
  rewritten: number;
}

function newCounts(): SweepCounts {
  return { v1: 0, v2: 0, plaintext: 0, failed: 0, rewritten: 0 };
}

function addCounts(into: SweepCounts, from: SweepCounts) {
  into.v1 += from.v1;
  into.v2 += from.v2;
  into.plaintext += from.plaintext;
  into.failed += from.failed;
  into.rewritten += from.rewritten;
}

/**
 * Re-encrypt one scalar value. Returns the new value, or null when no
 * rewrite is needed (already v2 / plaintext / undecryptable).
 */
async function rotateValue(
  value: string,
  keys: Required<EncryptionKeyring>,
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
  keys: Required<EncryptionKeyring>,
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

async function sweepTarget(
  sql: postgres.Sql,
  target: ColumnTarget,
  keys: Required<EncryptionKeyring>,
  execute: boolean,
  verbose: boolean,
): Promise<SweepCounts> {
  const counts = newCounts();
  const { table, idColumn, column, kind } = target;

  let offset = 0;
  for (;;) {
    let rows: { id: string; value: unknown }[];
    try {
      rows = (await sql.unsafe(
        `SELECT ${idColumn} AS id, ${column} AS value FROM ${table}
         WHERE ${column} IS NOT NULL
         ORDER BY ${idColumn} LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
      )) as unknown as { id: string; value: unknown }[];
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '42P01' || code === '42703') {
        // Table or column doesn't exist in this database — fine, skip.
        if (verbose) console.log(`    ${table}.${column}: not present, skipped`);
        return counts;
      }
      throw err;
    }

    if (rows.length === 0) break;

    for (const row of rows) {
      if (kind === 'text') {
        if (typeof row.value !== 'string') continue;
        const rotated = await rotateValue(row.value, keys, counts);
        if (rotated !== null && execute) {
          await sql.unsafe(`UPDATE ${table} SET ${column} = $1 WHERE ${idColumn} = $2`, [
            rotated,
            row.id,
          ]);
          counts.rewritten++;
        }
      } else {
        if (row.value === null || typeof row.value !== 'object' || Array.isArray(row.value)) continue;
        const rotated = await rotateJsonb(row.value as Record<string, unknown>, keys, counts);
        if (rotated !== null && execute) {
          await sql.unsafe(`UPDATE ${table} SET ${column} = $1::jsonb WHERE ${idColumn} = $2`, [
            JSON.stringify(rotated),
            row.id,
          ]);
          counts.rewritten++;
        }
      }
    }

    if (rows.length < BATCH_SIZE) break;
    offset += BATCH_SIZE;
  }

  if (verbose && (counts.v1 || counts.v2)) {
    console.log(
      `    ${table}.${column}: v1=${counts.v1} v2=${counts.v2} plaintext=${counts.plaintext} rewritten=${counts.rewritten}`,
    );
  }
  return counts;
}

async function sweepDatabase(
  label: string,
  databaseUrl: string,
  targets: ColumnTarget[],
  keys: Required<EncryptionKeyring>,
  execute: boolean,
  verbose: boolean,
): Promise<SweepCounts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  try {
    for (const target of targets) {
      addCounts(counts, await sweepTarget(sql, target, keys, execute, verbose));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  const status = counts.v1 === 0 ? 'clean' : execute ? 'rotated' : 'NEEDS ROTATION';
  console.log(
    `  ${label}: v1=${counts.v1} v2=${counts.v2} plaintext=${counts.plaintext} failed=${counts.failed} rewritten=${counts.rewritten} → ${status}`,
  );
  return counts;
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
  const keys: Required<EncryptionKeyring> = { v1, v2: v2 ?? '0'.repeat(64) };

  console.log(
    `Encryption-key rotation sweep — mode: ${options.execute ? 'EXECUTE' : 'dry-run'}`,
  );

  const total = newCounts();

  // Master DB
  if (!options.tenantsOnly) {
    console.log('\nMaster DB:');
    addCounts(
      total,
      await sweepDatabase('master', masterUrl, MASTER_TARGETS, keys, options.execute, options.verbose),
    );
  }

  // Tenant DBs
  if (!options.masterOnly) {
    const masterClient = postgres(masterUrl, { max: 1, ssl: 'require', prepare: false });
    const db = drizzle(masterClient);
    const conditions = [eq(workspaces.isActive, true), isNotNull(workspaces.neonProjectId)];
    if (options.only) conditions.push(eq(workspaces.id, options.only));

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

    console.log(`\nTenant DBs (${rows.length}):`);
    for (const w of rows) {
      if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
      try {
        const url = await resolveDatabaseUrl(neonApiKey, w as never, { v1, v2 });
        addCounts(
          total,
          await sweepDatabase(w.id, url, TENANT_TARGETS, keys, options.execute, options.verbose),
        );
      } catch (err) {
        console.error(`  ${w.id}: FAILED to connect/sweep — ${(err as Error).message}`);
        total.failed++;
      }
    }
  }

  console.log(
    `\nTOTAL: v1=${total.v1} v2=${total.v2} plaintext=${total.plaintext} failed=${total.failed} rewritten=${total.rewritten}`,
  );
  if (total.v1 === 0 && total.failed === 0) {
    console.log('All encrypted values are on v2 — the v1 key can be retired.');
  } else if (!options.execute) {
    console.log('Dry-run only. Re-run with --execute to rotate.');
  }
  process.exit(total.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Sweep failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
