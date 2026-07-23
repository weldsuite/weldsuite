#!/usr/bin/env node
/**
 * Custom fields Pile B — migrate the second user-field system (ticket-type form
 * fields + workflow-set contact/conversation attributes) out of the
 * `custom_fields` blobs into the typed `custom_field_values` table.
 *
 * See docs/custom-fields-blob-extraction.md. Companion to the Phase 2 sweep
 * (backfill-custom-field-values.ts). Two things make this one different:
 *
 *  1. TICKET SCOPING. Ticket definitions are scoped by `ticket_type_id`. A slug
 *     may repeat across ticket types, so a ticket blob value is resolved to a
 *     definition within (its own type OR a global ticket definition), and any
 *     auto-created definition is scoped to that ticket's type.
 *
 *  2. AUTO-CREATE. Unlike Phase 2 (which leaves unmatched slugs in the blob),
 *     Pile B must leave the blob empty for Phase 4. So an unmatched slug on a
 *     ticket / conversation / person blob AUTO-CREATES a `text` definition and
 *     migrates the value under it. Auto-created definitions are counted and, with
 *     --verbose, sampled — review them before Phase 4 drops the columns.
 *
 * The saved-workflow step configs are deliberately NOT rewritten: the
 * set_contact_attribute / set_conversation_attribute handlers already use the
 * attribute string directly as the slug and auto-create a definition at runtime,
 * and this sweep migrates the historical values those steps wrote, so a rewrite
 * would be cosmetic.
 *
 * Safety properties (identical to the Phase 2 sweep):
 *   - Dry-run by default; only `--execute` writes.
 *   - Value inserts use ON CONFLICT DO NOTHING — idempotent, never overwrites the
 *     fresher dual-write value.
 *   - Read-only against the blob. A skipped value is never a lost value.
 *   - Tenants missing custom_field_values (migration 0168) are reported + skipped.
 *   - Values coerced through the SAME validateCustomFieldValue the live dual-write
 *     path uses, so a backfilled row is byte-identical to a live write.
 *
 * Usage:
 *   pnpm backfill:pile-b                          # dry-run report, all tenants
 *   pnpm backfill:pile-b:execute                  # actually insert
 *   pnpm backfill:pile-b -- --only org_123        # single workspace
 *   pnpm backfill:pile-b -- --entity-type ticket  # ticket | conversation | person
 *   pnpm backfill:pile-b -- --verbose             # per-table detail + samples
 *
 * Requires: MASTER_DATABASE_URL, NEON_API_KEY, DATABASE_ENCRYPTION_KEY
 * (+ DATABASE_ENCRYPTION_KEY_V2 once tenant URLs are rotated to v2).
 */

import 'dotenv/config';
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

const READ_BATCH = 500;
const WRITE_BATCH = 200;

/**
 * The Pile B user-field surfaces. `ticket` is scoped by ticket_type_id; the
 * other two are global (ticket_type_id NULL). `person` overlaps the Phase 2
 * sweep, but the ON CONFLICT insert makes re-covering it a no-op — here it also
 * auto-creates definitions for the workflow-written keys Phase 2 leaves behind.
 */
const ENTITY_TARGETS = [
  { entityType: 'ticket', table: 'helpdesk_tickets', scoped: true },
  { entityType: 'conversation', table: 'helpdesk_conversations', scoped: false },
  { entityType: 'person', table: 'people', scoped: false },
] as const;

type Target = (typeof ENTITY_TARGETS)[number];

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
  rows: number;
  blobValues: number;
  migratable: number;
  inserted: number;
  alreadyPresent: number;
  /** Definitions auto-created for a previously-undefined slug. */
  autoCreatedDefs: number;
  invalid: number;
  empty: number;
  failedTenants: number;
  missingTable: number;
}

function newCounts(): Counts {
  return {
    rows: 0, blobValues: 0, migratable: 0, inserted: 0, alreadyPresent: 0,
    autoCreatedDefs: 0, invalid: 0, empty: 0, failedTenants: 0, missingTable: 0,
  };
}

function addCounts(into: Counts, from: Counts) {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += from[k];
}

/** Generate an id. Mirrors app-api's `generateId(prefix)` format. */
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

type DefinitionRow = {
  id: string;
  slug: string;
  field_type: string;
  ticket_type_id: string | null;
  options: { label: string; value: string; color?: string }[] | null;
  required: boolean | null;
};

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

function toPendingRow(
  def: DefinitionRow,
  entityType: string,
  entityId: string,
  value: string | number | boolean | string[] | Record<string, unknown>,
): PendingRow {
  const row: PendingRow = {
    id: generateId('cfv'), fieldId: def.id, entityType, entityId,
    valueText: null, valueNumber: null, valueDate: null,
    valueBool: null, valueJson: null, valueRef: null,
  };
  switch (fieldTypeToValueColumn(def.field_type as CustomFieldDefinitionLike['fieldType'])) {
    case 'number': row.valueNumber = value as number; break;
    case 'date': row.valueDate = value as string; break;
    case 'bool': row.valueBool = value as boolean; break;
    case 'json': row.valueJson = JSON.stringify(value); break;
    case 'ref': row.valueRef = value as string; break;
    case 'text': default: row.valueText = value as string; break;
  }
  return row;
}

async function insertBatch(sql: postgres.Sql, batch: PendingRow[]): Promise<number> {
  if (batch.length === 0) return 0;
  const params: unknown[] = [];
  const tuples = batch.map((r) => {
    const base = params.length;
    params.push(r.id, r.fieldId, r.entityType, r.entityId, r.valueText,
      r.valueNumber, r.valueDate, r.valueBool, r.valueJson, r.valueRef);
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

/** Insert an auto-created `text` definition and return its row. */
async function insertDefinition(
  sql: postgres.Sql,
  entityType: string,
  slug: string,
  ticketTypeId: string | null,
): Promise<DefinitionRow> {
  const id = generateId('cfld');
  await sql.unsafe(
    `INSERT INTO custom_field_definitions
       (id, entity_type, name, slug, field_type, required, sort_order, ticket_type_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'text', false, 0, $5, now(), now())`,
    [id, entityType, slug, slug, ticketTypeId] as never[],
  );
  return { id, slug, field_type: 'text', ticket_type_id: ticketTypeId, options: null, required: false };
}

/**
 * Resolve the definition for (slug, ticketTypeId) within a sweep, auto-creating
 * a text definition when absent. Ticket scoping: prefer a definition scoped to
 * the ticket's type, fall back to a global (ticket_type_id NULL) one, else
 * create one scoped to the ticket's type. `cache` is keyed by the resolution
 * scope so repeated slugs across rows share one lookup + one auto-create.
 *
 * In dry-run mode (`execute=false`) an auto-create is COUNTED but not written,
 * and the value it would carry is counted migratable without a pending insert
 * (there is no real definition id to key it on yet).
 */
async function resolveDefinition(
  sql: postgres.Sql,
  cache: Map<string, DefinitionRow | null>,
  bySlug: Map<string, DefinitionRow>,       // scoped defs for this ticket type
  globalBySlug: Map<string, DefinitionRow>, // ticket_type_id NULL defs
  entityType: string,
  slug: string,
  ticketTypeId: string | null,
  execute: boolean,
  autoCreated: { count: number; samples: Set<string> },
): Promise<DefinitionRow | null> {
  const key = `${ticketTypeId ?? ''}:${slug}`;
  if (cache.has(key)) return cache.get(key)!;

  const found = bySlug.get(slug) ?? globalBySlug.get(slug);
  if (found) {
    cache.set(key, found);
    return found;
  }

  // Unmatched — auto-create (scoped to the ticket type for tickets, else global).
  autoCreated.count++;
  if (autoCreated.samples.size < 15) autoCreated.samples.add(ticketTypeId ? `${slug}@${ticketTypeId}` : slug);
  if (!execute) {
    cache.set(key, null); // dry-run: no real def; value counted but not inserted
    return null;
  }
  const created = await insertDefinition(sql, entityType, slug, ticketTypeId);
  cache.set(key, created);
  bySlug.set(slug, created); // subsequent rows of the same type reuse it
  return created;
}

async function sweepEntityType(sql: postgres.Sql, target: Target, execute: boolean, verbose: boolean): Promise<Counts> {
  const counts = newCounts();
  const { entityType, table, scoped } = target;

  // Active definitions for this entity type (with ticket_type_id for scoping).
  const defs = (await sql.unsafe(
    `SELECT id, slug, field_type, ticket_type_id, options, required
       FROM custom_field_definitions
      WHERE entity_type = $1 AND deleted_at IS NULL`,
    [entityType] as never[],
  )) as unknown as DefinitionRow[];

  // Global (ticket_type_id NULL) definitions, always usable as a fallback.
  const globalBySlug = new Map(defs.filter((d) => d.ticket_type_id === null).map((d) => [d.slug, d]));
  // Scoped definitions grouped by ticket_type_id (only meaningful for tickets).
  const scopedByType = new Map<string, Map<string, DefinitionRow>>();
  for (const d of defs) {
    if (d.ticket_type_id === null) continue;
    let m = scopedByType.get(d.ticket_type_id);
    if (!m) scopedByType.set(d.ticket_type_id, (m = new Map()));
    m.set(d.slug, d);
  }

  const existing = (await sql.unsafe(
    `SELECT entity_id, field_id FROM custom_field_values WHERE entity_type = $1`,
    [entityType] as never[],
  )) as unknown as { entity_id: string; field_id: string }[];
  const existingKeys = new Set(existing.map((r) => `${r.entity_id}:${r.field_id}`));

  const autoCreated = { count: 0, samples: new Set<string>() };
  const invalidSamples: string[] = [];
  const defCache = new Map<string, DefinitionRow | null>();
  let pending: PendingRow[] = [];
  let cursor = '';

  const typeColumn = scoped ? 'ticket_type_id' : `NULL::varchar AS ticket_type_id`;

  for (;;) {
    const rows = (await sql.unsafe(
      `SELECT id, ${typeColumn}, custom_fields
         FROM ${table}
        WHERE custom_fields IS NOT NULL
          AND jsonb_typeof(custom_fields) = 'object'
          AND custom_fields <> '{}'::jsonb
          AND id > $1
        ORDER BY id
        LIMIT ${READ_BATCH}`,
      [cursor] as never[],
    )) as unknown as { id: string; ticket_type_id: string | null; custom_fields: Record<string, unknown> }[];

    if (rows.length === 0) break;

    for (const row of rows) {
      counts.rows++;
      const ticketTypeId = scoped ? row.ticket_type_id : null;
      const scopedBySlug = (ticketTypeId && scopedByType.get(ticketTypeId)) || new Map<string, DefinitionRow>();

      for (const [slug, raw] of Object.entries(row.custom_fields)) {
        counts.blobValues++;

        if (raw === null || raw === undefined || raw === '') {
          counts.empty++;
          continue;
        }

        const def = await resolveDefinition(
          sql, defCache, scopedBySlug, globalBySlug, entityType, slug, ticketTypeId, execute, autoCreated,
        );

        // Dry-run auto-create: no real definition, but the value WOULD migrate.
        if (!def) {
          counts.migratable++;
          continue;
        }

        const result = validateCustomFieldValue(
          { slug: def.slug, fieldType: def.field_type, options: def.options, required: def.required } as CustomFieldDefinitionLike,
          raw,
        );
        if (!result.ok || result.value === null || result.value === undefined) {
          if (!result.ok) {
            counts.invalid++;
            if (invalidSamples.length < 10) invalidSamples.push(`${row.id}.${slug}: ${result.error}`);
          } else {
            counts.empty++;
          }
          continue;
        }

        counts.migratable++;
        if (existingKeys.has(`${row.id}:${def.id}`)) {
          counts.alreadyPresent++;
          continue;
        }

        pending.push(toPendingRow(def, entityType, row.id, result.value));
        if (execute && pending.length >= WRITE_BATCH) {
          counts.inserted += await insertBatch(sql, pending);
          pending = [];
        }
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < READ_BATCH) break;
  }

  if (execute && pending.length > 0) counts.inserted += await insertBatch(sql, pending);
  counts.autoCreatedDefs = autoCreated.count;

  if (verbose && counts.blobValues > 0) {
    console.log(
      `    ${entityType} (${table}): rows=${counts.rows} values=${counts.blobValues} ` +
        `migratable=${counts.migratable} present=${counts.alreadyPresent} inserted=${counts.inserted} ` +
        `autoCreatedDefs=${counts.autoCreatedDefs} invalid=${counts.invalid} empty=${counts.empty}`,
    );
    if (autoCreated.samples.size > 0) {
      console.log(`      auto-created (text) defs for slugs: ${[...autoCreated.samples].join(', ')}`);
    }
    for (const sample of invalidSamples) console.log(`      invalid: ${sample}`);
  }
  return counts;
}

async function hasValuesTable(sql: postgres.Sql): Promise<boolean> {
  const rows = (await sql.unsafe(
    `SELECT to_regclass('public.custom_field_values') AS reg`,
  )) as unknown as { reg: string | null }[];
  return Boolean(rows[0]?.reg);
}

async function sweepTenant(label: string, databaseUrl: string, options: CliOptions): Promise<Counts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  try {
    if (!(await hasValuesTable(sql))) {
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

  const stored = counts.alreadyPresent + counts.inserted;
  const parity = options.execute
    ? stored === counts.migratable
      ? 'PARITY OK'
      : `PARITY MISMATCH (${counts.migratable - stored} unstored)`
    : `${counts.migratable - counts.alreadyPresent} to insert`;
  console.log(
    `  ${label}: rows=${counts.rows} values=${counts.blobValues} migratable=${counts.migratable} ` +
      `present=${counts.alreadyPresent} inserted=${counts.inserted} ` +
      `autoCreatedDefs=${counts.autoCreatedDefs} invalid=${counts.invalid} → ${parity}`,
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
  if (!v1 && !v2) console.log('No DATABASE_ENCRYPTION_KEY set — resolving tenant URLs via the Neon API.');

  console.log(
    `Custom fields Pile B backfill — mode: ${options.execute ? 'EXECUTE' : 'dry-run'}` +
      (options.entityType ? ` — entity type: ${options.entityType}` : ''),
  );

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
      addCounts(total, await sweepTenant(w.id, url, options));
    } catch (err) {
      console.error(`  ${w.id}: FAILED — ${(err as Error).message}`);
      total.failedTenants++;
    }
  }

  const stored = total.alreadyPresent + total.inserted;
  console.log(
    `\nTOTAL: rows=${total.rows} values=${total.blobValues} migratable=${total.migratable} ` +
      `present=${total.alreadyPresent} inserted=${total.inserted}`,
  );
  console.log(
    `       autoCreatedDefs=${total.autoCreatedDefs} invalid=${total.invalid} empty=${total.empty} ` +
      `missingTable=${total.missingTable} failedTenants=${total.failedTenants}`,
  );

  if (total.autoCreatedDefs > 0) {
    console.log(
      `\nNote: ${total.autoCreatedDefs} text definition(s) ${options.execute ? 'were' : 'would be'} ` +
        'auto-created for previously-undefined slugs (--verbose lists samples). Review them before Phase 4.',
    );
  }
  if (total.invalid > 0) {
    console.log(
      `\nWarning: ${total.invalid} value(s) failed coercion and remain in the blob. ` +
        'Investigate before Phase 4 drops the columns.',
    );
  }

  if (options.execute) {
    if (stored === total.migratable && total.missingTable === 0 && total.failedTenants === 0 && total.invalid === 0) {
      console.log('\nParity verified across all tenants — ticket/conversation/person blobs migrated.');
    } else {
      console.log('\nParity NOT clean. Re-run (the sweep is idempotent) and investigate.');
    }
  } else {
    console.log(
      `\nDry-run only. ${total.migratable - total.alreadyPresent} row(s) would be inserted, ` +
        `${total.autoCreatedDefs} definition(s) auto-created. Re-run with --execute to write.`,
    );
  }

  const clean = total.failedTenants === 0 && total.missingTable === 0;
  process.exit(clean ? 0 : 1);
}

main().catch((err) => {
  console.error('Pile B backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
