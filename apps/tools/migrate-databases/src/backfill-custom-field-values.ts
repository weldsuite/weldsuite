#!/usr/bin/env node
/**
 * Custom fields Phase 2 — backfill the typed `custom_field_values` table from
 * the legacy per-entity `custom_fields` JSONB blobs.
 *
 * See docs/custom-fields-values-table.md. Phase 1 (dual-write) is live in
 * production, so every write since that deploy already lands in both places.
 * This sweep is the historical catch-up: it explodes each blob into typed rows
 * for entities that predate the cutover, then reports parity.
 *
 * Safety properties:
 *   - Dry-run by default; only `--execute` writes.
 *   - INSERT ... ON CONFLICT DO NOTHING — never overwrites an existing row, so
 *     the fresher dual-write value always wins and re-runs are idempotent.
 *   - Read-only against the blob. Nothing is deleted or rewritten in the source
 *     columns, so a skipped value is never a lost value (Phase 4 drops them).
 *   - A tenant missing migration 0168 is reported and skipped, not crashed on.
 *
 * Values are coerced through the SAME `validateCustomFieldValue` the dual-write
 * path uses, so backfilled rows are byte-identical to what a live write would
 * have produced. That is what makes the parity check meaningful.
 *
 * Usage:
 *   pnpm backfill:cfv                          # dry-run report, all tenants
 *   pnpm backfill:cfv:execute                  # actually insert
 *   pnpm backfill:cfv -- --only org_123        # single workspace
 *   pnpm backfill:cfv -- --entity-type company # single entity type
 *   pnpm backfill:cfv -- --verbose             # per-table detail + samples
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY, DATABASE_ENCRYPTION_KEY
 * (+ DATABASE_ENCRYPTION_KEY_V2 once tenant URLs are rotated to v2).
 */

import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNotNull, and } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { resolveDatabaseUrl } from '@weldsuite/db/lib/neon-resolve';
import {
  fieldTypeToValueColumn,
  validateCustomFieldValue,
  type CustomFieldDefinitionLike,
} from '@weldsuite/app-api-client/schemas/custom-fields';

/** Page size for reading source rows (keyset paginated on `id`). */
const READ_BATCH = 500;
/** Rows per multi-value INSERT. */
const WRITE_BATCH = 200;

/**
 * The entity types wired for dual-write in Phase 1, and the table each one's
 * values live on. Deliberately mirrors the table in the design doc — the
 * custom-field `entityType` namespace is NOT the entity-events namespace
 * (tasks emit `project_task` events but carry `task` custom fields).
 *
 * The other 10 tables with a `custom_fields` column expose no `customFields`
 * in their API, so their blobs are empty by construction; nothing to backfill
 * until a real surface exists.
 */
const ENTITY_TARGETS: { entityType: string; table: string }[] = [
  { entityType: 'company', table: 'companies' },
  { entityType: 'person', table: 'people' },
  { entityType: 'task', table: 'tasks' },
  { entityType: 'opportunity', table: 'crm_opportunities' },
  { entityType: 'activity', table: 'crm_activities' },
  { entityType: 'ticket', table: 'helpdesk_tickets' },
];

interface CliOptions {
  execute: boolean;
  only: string | null;
  entityType: string | null;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { execute: false, only: null, entityType: null, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--only' && args[i + 1]) options.only = args[++i] ?? null;
    else if (arg === '--entity-type' && args[i + 1]) options.entityType = args[++i] ?? null;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    }
  }
  return options;
}

interface Counts {
  /** Source rows carrying a non-empty blob. */
  rows: number;
  /** Total slug->value pairs seen across those blobs. */
  blobValues: number;
  /** Pairs that resolved to a definition and a non-empty value. */
  migratable: number;
  /** Rows inserted (execute only). */
  inserted: number;
  /** Pairs already present in custom_field_values (dual-write or prior run). */
  alreadyPresent: number;
  /** Slugs with no matching active definition — left in the blob, not migrated. */
  orphanSlugs: number;
  /** Values that failed type coercion — left in the blob, not migrated. */
  invalid: number;
  /** Empty/null values — nothing to store (absence IS the cleared state). */
  empty: number;
  /** Tenants that could not be swept. */
  failedTenants: number;
  /** Tenants missing the custom_field_values table (migration 0168 not applied). */
  missingTable: number;
}

function newCounts(): Counts {
  return {
    rows: 0,
    blobValues: 0,
    migratable: 0,
    inserted: 0,
    alreadyPresent: 0,
    orphanSlugs: 0,
    invalid: 0,
    empty: 0,
    failedTenants: 0,
    missingTable: 0,
  };
}

function addCounts(into: Counts, from: Counts) {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += from[k];
}

/** Generate a value-row id. Mirrors app-api's `generateId('cfv')` format. */
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Array.from(randomBytes(8), (b) => (b % 36).toString(36)).join('');
  return `${prefix}_${timestamp}${random}`;
}

type DefinitionRow = {
  id: string;
  slug: string;
  field_type: string;
  options: { label: string; value: string; color?: string }[] | null;
  required: boolean | null;
};

/** One pending insert, already coerced into its typed column. */
interface PendingRow {
  id: string;
  fieldId: string;
  entityType: string;
  entityId: string;
  valueText: string | null;
  valueNumber: number | null;
  valueDate: string | null;
  valueBool: boolean | null;
  valueJson: string | null;
  valueRef: string | null;
}

/** Place a validated value into the column implied by its field type. */
function toPendingRow(
  def: DefinitionRow,
  entityType: string,
  entityId: string,
  value: string | number | boolean | string[] | Record<string, unknown>,
): PendingRow {
  const row: PendingRow = {
    id: generateId('cfv'),
    fieldId: def.id,
    entityType,
    entityId,
    valueText: null,
    valueNumber: null,
    valueDate: null,
    valueBool: null,
    valueJson: null,
    valueRef: null,
  };

  switch (fieldTypeToValueColumn(def.field_type as CustomFieldDefinitionLike['fieldType'])) {
    case 'number':
      row.valueNumber = value as number;
      break;
    case 'date':
      // validateCustomFieldValue normalizes dates to an ISO string.
      row.valueDate = value as string;
      break;
    case 'bool':
      row.valueBool = value as boolean;
      break;
    case 'json':
      row.valueJson = JSON.stringify(value);
      break;
    case 'ref':
      row.valueRef = value as string;
      break;
    case 'text':
    default:
      row.valueText = value as string;
      break;
  }
  return row;
}

/**
 * Insert a batch, skipping any (entity_type, entity_id, field_id) that already
 * exists. Returns how many rows were actually written.
 */
async function insertBatch(sql: postgres.Sql, batch: PendingRow[]): Promise<number> {
  if (batch.length === 0) return 0;

  const params: unknown[] = [];
  const tuples = batch.map((r) => {
    const base = params.length;
    params.push(
      r.id,
      r.fieldId,
      r.entityType,
      r.entityId,
      r.valueText,
      r.valueNumber,
      r.valueDate,
      r.valueBool,
      r.valueJson,
      r.valueRef,
    );
    // Explicit casts: a bare NULL parameter has no inferred type.
    return (
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, ` +
      `$${base + 5}::text, $${base + 6}::double precision, $${base + 7}::timestamp, ` +
      `$${base + 8}::boolean, $${base + 9}::jsonb, $${base + 10}::varchar)`
    );
  });

  const result = await sql.unsafe(
    `INSERT INTO custom_field_values
       (id, field_id, entity_type, entity_id,
        value_text, value_number, value_date, value_bool, value_json, value_ref)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (entity_type, entity_id, field_id) DO NOTHING
     RETURNING id`,
    params as never[],
  );
  return (result as unknown as { id: string }[]).length;
}

/** Mutable bookkeeping for one entity-type sweep. */
interface SweepState {
  counts: Counts;
  defBySlug: Map<string, DefinitionRow>;
  existingKeys: Set<string>;
  orphanSamples: Set<string>;
  invalidSamples: string[];
  pending: PendingRow[];
}

type SourceRow = { id: string; custom_fields: Record<string, unknown> };

/**
 * Classify one slug->value pair from a blob, updating the counters. Returns the
 * row to insert, or null when there is nothing to write.
 */
function classifyBlobValue(
  state: SweepState,
  entityType: string,
  rowId: string,
  slug: string,
  raw: unknown,
): PendingRow | null {
  const { counts } = state;
  counts.blobValues++;

  const def = state.defBySlug.get(slug);
  if (!def) {
    // Renamed or never-defined field. Non-destructive: the blob keeps it.
    counts.orphanSlugs++;
    if (state.orphanSamples.size < 10) state.orphanSamples.add(slug);
    return null;
  }

  if (raw === null || raw === undefined || raw === '') {
    // Absence of a row IS the cleared state — nothing to insert.
    counts.empty++;
    return null;
  }

  // `required` is deliberately not enforced: a historical row that predates
  // a field being made required must still migrate, exactly as the Phase 1
  // mirror treats it (enforceRequired: false).
  const result = validateCustomFieldValue(
    { ...def, fieldType: def.field_type } as unknown as CustomFieldDefinitionLike,
    raw,
  );
  if (!result.ok) {
    counts.invalid++;
    if (state.invalidSamples.length < 10) {
      state.invalidSamples.push(`${rowId}.${slug}: ${result.error}`);
    }
    return null;
  }
  if (result.value === null || result.value === undefined) {
    counts.empty++;
    return null;
  }

  counts.migratable++;
  if (state.existingKeys.has(`${rowId}:${def.id}`)) {
    counts.alreadyPresent++;
    return null;
  }

  return toPendingRow(def, entityType, rowId, result.value);
}

/** Classify every pair in one source row, flushing full batches when executing. */
async function processSourceRow(
  sql: postgres.Sql,
  state: SweepState,
  entityType: string,
  row: SourceRow,
  execute: boolean,
): Promise<void> {
  state.counts.rows++;
  for (const [slug, raw] of Object.entries(row.custom_fields)) {
    const pendingRow = classifyBlobValue(state, entityType, row.id, slug, raw);
    if (!pendingRow) continue;

    state.pending.push(pendingRow);
    if (execute && state.pending.length >= WRITE_BATCH) {
      state.counts.inserted += await insertBatch(sql, state.pending);
      state.pending = [];
    }
  }
}

/**
 * Keyset pagination — stable under concurrent writes, unlike OFFSET.
 * Soft-deleted parents are INCLUDED: their blob is still restorable data,
 * and dropping it here would silently lose it at Phase 4.
 */
async function fetchSourceRows(sql: postgres.Sql, table: string, cursor: string): Promise<SourceRow[]> {
  return (await sql.unsafe(
    `SELECT id, custom_fields
       FROM ${table}
      WHERE custom_fields IS NOT NULL
        AND jsonb_typeof(custom_fields) = 'object'
        AND custom_fields <> '{}'::jsonb
        AND id > $1
      ORDER BY id
      LIMIT ${READ_BATCH}`,
    [cursor] as never[],
  )) as unknown as SourceRow[];
}

function logEntitySummary(entityType: string, table: string, state: SweepState) {
  const { counts } = state;
  if (counts.blobValues <= 0) return;
  console.log(
    `    ${entityType} (${table}): rows=${counts.rows} values=${counts.blobValues} ` +
      `migratable=${counts.migratable} present=${counts.alreadyPresent} ` +
      `inserted=${counts.inserted} orphan=${counts.orphanSlugs} invalid=${counts.invalid} empty=${counts.empty}`,
  );
  if (state.orphanSamples.size > 0) {
    console.log(`      orphan slugs (no active definition): ${[...state.orphanSamples].join(', ')}`);
  }
  for (const sample of state.invalidSamples) console.log(`      invalid: ${sample}`);
}

/** Backfill one entity type within one tenant DB. */
async function sweepEntityType(
  sql: postgres.Sql,
  target: { entityType: string; table: string },
  execute: boolean,
  verbose: boolean,
): Promise<Counts> {
  const counts = newCounts();
  const { entityType, table } = target;

  // Active definitions only. A soft-deleted definition's values stay inert by
  // design, so we must not resurrect them into the typed table.
  const defs = (await sql.unsafe(
    `SELECT id, slug, field_type, options, required
       FROM custom_field_definitions
      WHERE entity_type = $1 AND deleted_at IS NULL`,
    [entityType] as never[],
  )) as unknown as DefinitionRow[];

  if (defs.length === 0) {
    if (verbose) console.log(`    ${entityType}: no definitions, skipped`);
    return counts;
  }
  const defBySlug = new Map(defs.map((d) => [d.slug, d]));

  // Which (entity, field) pairs already exist — one query, avoids an N+1 probe.
  const existing = (await sql.unsafe(
    `SELECT entity_id, field_id FROM custom_field_values WHERE entity_type = $1`,
    [entityType] as never[],
  )) as unknown as { entity_id: string; field_id: string }[];
  const existingKeys = new Set(existing.map((r) => `${r.entity_id}:${r.field_id}`));

  const state: SweepState = {
    counts,
    defBySlug,
    existingKeys,
    orphanSamples: new Set<string>(),
    invalidSamples: [],
    pending: [],
  };
  let cursor = '';

  for (;;) {
    const rows = await fetchSourceRows(sql, table, cursor);
    if (rows.length === 0) break;

    for (const row of rows) {
      await processSourceRow(sql, state, entityType, row, execute);
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < READ_BATCH) break;
  }

  if (execute && state.pending.length > 0) {
    counts.inserted += await insertBatch(sql, state.pending);
  }

  if (verbose) logEntitySummary(entityType, table, state);

  return counts;
}

/** Does this tenant have migration 0168 applied? */
async function hasValuesTable(sql: postgres.Sql): Promise<boolean> {
  const rows = (await sql.unsafe(
    `SELECT to_regclass('public.custom_field_values') AS reg`,
  )) as unknown as { reg: string | null }[];
  return Boolean(rows[0]?.reg);
}

async function sweepTenant(
  label: string,
  databaseUrl: string,
  options: CliOptions,
): Promise<Counts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });

  try {
    if (!(await hasValuesTable(sql))) {
      // Explicit, not assumed: tenant migrations can partially fail, and
      // backfilling a tenant without the table would abort the whole sweep.
      counts.missingTable++;
      console.log(`  ${label}: custom_field_values MISSING — run tenant migrations first`);
      return counts;
    }

    const targets = options.entityType
      ? ENTITY_TARGETS.filter((t) => t.entityType === options.entityType)
      : ENTITY_TARGETS;

    for (const target of targets) {
      addCounts(counts, await sweepEntityType(sql, target, options.execute, options.verbose));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  // Parity: every migratable pair must end up stored (already there or inserted).
  const stored = counts.alreadyPresent + counts.inserted;
  let parity: string;
  if (!options.execute) {
    parity = `${counts.migratable - counts.alreadyPresent} to insert`;
  } else if (stored === counts.migratable) {
    parity = 'PARITY OK';
  } else {
    parity = `PARITY MISMATCH (${counts.migratable - stored} unstored)`;
  }

  console.log(
    `  ${label}: rows=${counts.rows} values=${counts.blobValues} migratable=${counts.migratable} ` +
      `present=${counts.alreadyPresent} inserted=${counts.inserted} ` +
      `orphan=${counts.orphanSlugs} invalid=${counts.invalid} → ${parity}`,
  );
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

/** Sweeps every tenant in order, accumulating into `total`. */
async function sweepAllTenants(
  rows: Awaited<ReturnType<typeof loadActiveTenants>>,
  neonApiKey: string,
  keys: { v1: string | undefined; v2: string | undefined },
  options: CliOptions,
  total: Counts,
): Promise<void> {
  for (const w of rows) {
    if (!w.neonProjectId || !w.neonBranchId || !w.neonRoleName) continue;
    try {
      const url = await resolveDatabaseUrl(neonApiKey, w as never, keys);
      addCounts(total, await sweepTenant(w.id, url, options));
    } catch (err) {
      console.error(`  ${w.id}: FAILED — ${(err as Error).message}`);
      total.failedTenants++;
    }
  }
}

function printTotals(total: Counts, options: CliOptions) {
  const stored = total.alreadyPresent + total.inserted;
  console.log(
    `\nTOTAL: rows=${total.rows} values=${total.blobValues} migratable=${total.migratable} ` +
      `present=${total.alreadyPresent} inserted=${total.inserted}`,
  );
  console.log(
    `       orphan=${total.orphanSlugs} invalid=${total.invalid} empty=${total.empty} ` +
      `missingTable=${total.missingTable} failedTenants=${total.failedTenants}`,
  );

  if (total.orphanSlugs > 0 || total.invalid > 0) {
    console.log(
      '\nNote: orphaned/invalid values were NOT migrated and remain in the ' +
        'custom_fields blob. Review them (--verbose lists samples) before ' +
        'Phase 4 drops those columns.',
    );
  }

  if (!options.execute) {
    console.log(
      `\nDry-run only. ${total.migratable - total.alreadyPresent} row(s) would be inserted. ` +
        'Re-run with --execute to write.',
    );
    return;
  }

  if (stored === total.migratable && total.missingTable === 0 && total.failedTenants === 0) {
    console.log('\nParity verified across all tenants — safe to proceed to Phase 3.');
  } else {
    console.log('\nParity NOT clean. Re-run (the sweep is idempotent) and investigate.');
  }
}

async function main() {
  const options = parseArgs();

  const masterUrl = process.env.MASTER_DATABASE_URL;
  const neonApiKey = process.env.NEON_API_KEY || '';
  const v1 = process.env.DATABASE_ENCRYPTION_KEY;
  const v2 = process.env.DATABASE_ENCRYPTION_KEY_V2;

  if (!masterUrl) throw new Error('MASTER_DATABASE_URL is required');
  // The encryption keys are optional, matching `index.ts`: resolveDatabaseUrl
  // only needs them when a workspace stores an ENCRYPTED databaseUrl. Plaintext
  // URLs are returned as-is, and a missing/unusable key falls back to the Neon
  // API. Requiring them here would block the sweep for no reason.
  if (!v1 && !v2) {
    console.log('No DATABASE_ENCRYPTION_KEY set — resolving tenant URLs via the Neon API.');
  }

  console.log(
    `Custom field values backfill (Phase 2) — mode: ${options.execute ? 'EXECUTE' : 'dry-run'}` +
      (options.entityType ? ` — entity type: ${options.entityType}` : ''),
  );

  const rows = await loadActiveTenants(masterUrl, options.only);

  console.log(`\nTenant DBs (${rows.length}):`);
  const total = newCounts();

  await sweepAllTenants(rows, neonApiKey, { v1, v2 }, options, total);

  printTotals(total, options);

  const clean = total.failedTenants === 0 && total.missingTable === 0;
  process.exit(clean ? 0 : 1);
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
