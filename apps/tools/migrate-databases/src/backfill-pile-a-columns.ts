#!/usr/bin/env node
/**
 * Custom fields Pile A — move the remaining product-feature keys out of the
 * `custom_fields` blobs into their real columns, then strip the keys, so
 * `pnpm audit:blobs` reaches zero and Phase 4 can drop the blob columns.
 *
 * See docs/custom-fields-blob-extraction.md (Pile A). The Pile A CODE cutover
 * already routes new writes to the real columns; this is the historical catch-up
 * for legacy rows (mostly written by the deleted api-worker before the cutover).
 *
 * Scope: the two tables the production audit still flags — `calendar_events` and
 * `mail_messages`. Their full documented key->column mappings are covered (not
 * just the keys that happen to carry data today) so the sweep is complete and
 * idempotent. crm_activities / tasks blobs already audit clean, so they are out
 * of scope; extend TABLE_MAPPINGS if that changes.
 *
 * Per row, for each mapped key present in the blob (nothing writes these keys
 * today, so their presence means a legacy row):
 *   - column IS NULL → write the coerced blob value in, then strip. Only a
 *     no-default column can be NULL, so this fill is unambiguous.
 *   - column == blob value → strip (a true stale dup), whether that value is a
 *     genuine write or a migration default.
 *   - column != blob value (non-null) → CONFLICT: leave the key and report it.
 *     A non-null value is NOT proof of an authoritative write: `auto_scheduled`
 *     is `boolean DEFAULT false` (migration 0106), so a legacy `false` is
 *     indistinguishable from an intentional `pinRescheduledSource()` write.
 *     Overwriting could clobber a real value; stripping could drop real legacy
 *     data — so the sweep NEVER touches a non-null column, and a disagreement is
 *     left for manual reconciliation.
 *   - empty blob value → strip (nothing to preserve).
 *   - coercion failure → LEFT in place and reported, never dropped.
 *
 * Safety:
 *   - Dry-run by default; only `--execute` writes.
 *   - Only the mapped keys are ever removed; every other blob key is untouched.
 *   - NEVER writes a non-null column. The only column write is filling a NULL;
 *     every non-null disagreement is a conflict, never auto-resolved.
 *   - Idempotent: once stripped, a re-run matches no rows.
 *   - Missing columns (tenant not on migration 0169) are reported + skipped.
 *
 * Usage:
 *   pnpm backfill:pile-a                       # dry-run report, all tenants
 *   pnpm backfill:pile-a:execute               # apply
 *   pnpm backfill:pile-a -- --only ws_abc123   # single workspace
 *   pnpm backfill:pile-a -- --table mail_messages
 *   pnpm backfill:pile-a -- --verbose
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

type ColType = 'text' | 'bool' | 'ts';
interface KeyMap {
  key: string; // blob key (camelCase, as written)
  col: string; // real column (snake_case)
  type: ColType;
}
interface TableMapping {
  table: string;
  maps: KeyMap[];
}

const TABLE_MAPPINGS: TableMapping[] = [
  {
    table: 'calendar_events',
    maps: [
      { key: 'sourceType', col: 'source_type', type: 'text' },
      { key: 'sourceId', col: 'source_id', type: 'text' },
      // NOTE: auto_scheduled is `boolean DEFAULT false` (migration 0106), so it
      // is never NULL and a `false` is ambiguous (migration default vs a genuine
      // pinRescheduledSource() write). The sweep therefore never auto-writes it —
      // a blob value that disagrees with the column is reported as a conflict.
      { key: 'autoScheduled', col: 'auto_scheduled', type: 'bool' },
      { key: 'reason', col: 'reason', type: 'text' },
      { key: 'taskPriority', col: 'task_priority', type: 'text' },
    ],
  },
  {
    table: 'mail_messages',
    maps: [
      { key: 'scheduledFor', col: 'scheduled_for', type: 'ts' },
      { key: 'sendStatus', col: 'send_status', type: 'text' },
      { key: 'sendProvider', col: 'send_provider', type: 'text' },
      { key: 'providerMessageId', col: 'provider_message_id', type: 'text' },
      { key: 'mailgunMessageId', col: 'mailgun_message_id', type: 'text' },
      { key: 'snoozedUntil', col: 'snoozed_until', type: 'ts' },
      { key: 'snoozedAt', col: 'snoozed_at', type: 'ts' },
      { key: 'unsnoozedAt', col: 'unsnoozed_at', type: 'ts' },
      { key: 'unsnoozedEarly', col: 'unsnoozed_early', type: 'bool' },
      { key: 'resnoozedAt', col: 'resnoozed_at', type: 'ts' },
      { key: 'unsnoozeTriggerRunId', col: 'unsnooze_trigger_run_id', type: 'text' },
    ],
  },
];

interface CliOptions {
  execute: boolean;
  only: string | null;
  table: string | null;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { execute: false, only: null, table: null, verbose: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--only' && args[i + 1]) options.only = args[++i] ?? null;
    else if (arg === '--table' && args[i + 1]) options.table = args[++i] ?? null;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('See file header for usage.');
      process.exit(0);
    }
  }
  return options;
}

interface Counts {
  rows: number; // rows carrying at least one mapped key
  keysFound: number; // mapped key occurrences seen
  columnsSet: number; // columns written from the blob (were null or default)
  alreadySet: number; // column already held the same authoritative value (stale dup)
  keysStripped: number; // keys removed from the blob
  invalid: number; // blob values that failed coercion — LEFT in the blob
  conflicts: number; // column holds a real value that disagrees with the blob — LEFT in the blob
  failedTenants: number;
  missingCols: number; // tenants missing a mapped column
}

function newCounts(): Counts {
  return { rows: 0, keysFound: 0, columnsSet: 0, alreadySet: 0, keysStripped: 0, invalid: 0, conflicts: 0, failedTenants: 0, missingCols: 0 };
}
function addCounts(into: Counts, from: Counts) {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += from[k];
}

const INVALID = Symbol('invalid');

/** Coerce a raw blob value to its column type. Returns null to mean "empty"
 *  (nothing to store), INVALID when it cannot be safely converted. */
function coerce(type: ColType, val: unknown): string | boolean | null | typeof INVALID {
  if (val === null || val === undefined || val === '') return null;
  if (type === 'bool') {
    if (val === true || val === false) return val;
    if (val === 'true' || val === 1 || val === '1') return true;
    if (val === 'false' || val === 0 || val === '0') return false;
    return INVALID;
  }
  if (type === 'ts') {
    const d = new Date(String(val));
    return Number.isNaN(d.getTime()) ? INVALID : d.toISOString();
  }
  return String(val);
}

/** Compare a live DB column value against a coerced blob value. A null/undefined
 *  column is never "equal" (that is the unset case, handled separately). */
function colEquals(type: ColType, dbVal: unknown, coerced: string | boolean): boolean {
  if (dbVal === null || dbVal === undefined) return false;
  if (type === 'bool') return dbVal === coerced;
  if (type === 'ts') {
    const a = dbVal instanceof Date ? dbVal.getTime() : new Date(String(dbVal)).getTime();
    const b = new Date(String(coerced)).getTime();
    return a === b;
  }
  return String(dbVal) === String(coerced);
}

/** Which of a table's mapped columns actually exist in this tenant. */
async function existingColumns(sql: postgres.Sql, table: string, cols: string[]): Promise<Set<string>> {
  const rows = (await sql.unsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2::text[])`,
    [table, cols] as never[],
  )) as unknown as { column_name: string }[];
  return new Set(rows.map((r) => r.column_name));
}

async function sweepTable(sql: postgres.Sql, mapping: TableMapping, execute: boolean, verbose: boolean): Promise<Counts> {
  const counts = newCounts();
  const { table } = mapping;

  // Table present at all? (calendar_events / mail_messages exist everywhere, but
  // be defensive — a partially-migrated tenant should be reported, not crashed.)
  const reg = (await sql.unsafe(`SELECT to_regclass('public.${table}') AS reg`)) as unknown as { reg: string | null }[];
  if (!reg[0]?.reg) {
    counts.missingCols++;
    console.log(`    ${table}: table missing — skipped`);
    return counts;
  }

  const have = await existingColumns(sql, table, mapping.maps.map((m) => m.col));
  const maps = mapping.maps.filter((m) => have.has(m.col));
  if (maps.length < mapping.maps.length) {
    counts.missingCols++;
    console.log(`    ${table}: missing columns ${mapping.maps.filter((m) => !have.has(m.col)).map((m) => m.col).join(', ')} — those mappings skipped`);
  }
  if (maps.length === 0) return counts;

  const keys = maps.map((m) => m.key);
  const colList = maps.map((m) => `"${m.col}"`).join(', ');
  const invalidSamples: string[] = [];
  const conflictSamples: string[] = [];

  // ONE sequential scan. `?|` is not indexable, so an ORDER BY / keyset paginated
  // read makes Postgres walk the PK index doing a per-row heap lookup (random
  // I/O) to find sparse matches — pathologically slow on a large table (it hung a
  // production dry-run on mail_messages). A plain unordered scan is a single
  // sequential pass, exactly what the audit does; the mapped keys are legacy
  // product-feature data, so matches are rare and the result set is tiny.
  // Soft-deleted rows are included — their blob is dropped at Phase 4 too.
  const rows = (await sql.unsafe(
    `SELECT id, custom_fields, ${colList}
       FROM ${table}
      WHERE custom_fields IS NOT NULL
        AND jsonb_typeof(custom_fields) = 'object'
        AND custom_fields ?| $1::text[]`,
    [keys] as never[],
  )) as unknown as Array<Record<string, unknown> & { id: string; custom_fields: Record<string, unknown> }>;

  {
    for (const row of rows) {
      const blob = row.custom_fields ?? {};
      const stripKeys: string[] = [];
      const setCols: { col: string; type: ColType; val: string | boolean }[] = [];

      for (const m of maps) {
        if (!Object.prototype.hasOwnProperty.call(blob, m.key)) continue;
        counts.keysFound++;
        const coerced = coerce(m.type, blob[m.key]);
        if (coerced === INVALID) {
          counts.invalid++;
          if (invalidSamples.length < 10) invalidSamples.push(`${table}.${row.id}.${m.key}=${JSON.stringify(blob[m.key])}`);
          continue; // leave the key in the blob; do not lose an unconvertible value
        }
        if (coerced === null) {
          // Empty blob value — nothing to preserve, safe to strip.
          stripKeys.push(m.key);
          continue;
        }
        const currentCol = row[m.col];
        if (currentCol === null || currentCol === undefined) {
          // Column never written. Only a no-default column can be NULL (a column
          // with a non-null DEFAULT was backfilled on every row), so this is an
          // unambiguous legacy fill: write the blob value in, then strip.
          setCols.push({ col: m.col, type: m.type, val: coerced });
          counts.columnsSet++;
          stripKeys.push(m.key);
        } else if (colEquals(m.type, currentCol, coerced)) {
          // Column already holds this exact value — a true stale dup, safe to
          // strip whether the value is a genuine write or a migration default.
          counts.alreadySet++;
          stripKeys.push(m.key);
        } else {
          // Column holds a NON-NULL value that DISAGREES with the blob. This can
          // never be auto-resolved: a non-null value may be a genuine post-cutover
          // write OR a migration-time default, and the two are indistinguishable
          // (auto_scheduled is DEFAULT false, yet pinRescheduledSource() also
          // writes false on purpose — apps/workers/app-api/src/services/calendar-events.ts).
          // Overwriting could clobber a real value; stripping could drop real
          // legacy data. So touch nothing — leave the key and flag it for manual
          // reconciliation.
          counts.conflicts++;
          if (conflictSamples.length < 10) {
            conflictSamples.push(`${table}.${row.id}.${m.key}: blob=${JSON.stringify(blob[m.key])} col=${JSON.stringify(currentCol)}`);
          }
        }
      }

      if (stripKeys.length === 0) continue;
      counts.rows++;
      counts.keysStripped += stripKeys.length;

      if (execute) {
        const params: unknown[] = [];
        const setClauses = setCols.map((s) => {
          params.push(s.val);
          const cast = s.type === 'bool' ? '::boolean' : s.type === 'ts' ? '::timestamp' : '::text';
          return `"${s.col}" = $${params.length}${cast}`;
        });
        params.push(stripKeys);
        const stripParam = `$${params.length}::text[]`;
        params.push(row.id);
        const idParam = `$${params.length}`;
        const setSql = [...setClauses, `custom_fields = custom_fields - ${stripParam}`].join(', ');
        await sql.unsafe(`UPDATE ${table} SET ${setSql} WHERE id = ${idParam}`, params as never[]);
      }
    }
  }

  if (verbose && (counts.rows > 0 || counts.conflicts > 0 || counts.invalid > 0)) {
    console.log(
      `    ${table}: rows=${counts.rows} keysFound=${counts.keysFound} columnsSet=${counts.columnsSet} ` +
        `alreadySet=${counts.alreadySet} stripped=${counts.keysStripped} conflicts=${counts.conflicts} invalid=${counts.invalid}`,
    );
    for (const s of conflictSamples) console.log(`      conflict (left in blob): ${s}`);
    for (const s of invalidSamples) console.log(`      invalid (left in blob): ${s}`);
  }
  return counts;
}

async function sweepTenant(label: string, databaseUrl: string, options: CliOptions): Promise<Counts> {
  const counts = newCounts();
  const sql = postgres(databaseUrl, { max: 1, ssl: 'require', prepare: false });
  try {
    const targets = options.table ? TABLE_MAPPINGS.filter((t) => t.table === options.table) : TABLE_MAPPINGS;
    for (const mapping of targets) {
      addCounts(counts, await sweepTable(sql, mapping, options.execute, options.verbose));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (counts.keysFound > 0 || counts.missingCols > 0) {
    console.log(
      `  ${label}: rows=${counts.rows} keysFound=${counts.keysFound} columnsSet=${counts.columnsSet} ` +
        `alreadySet=${counts.alreadySet} stripped=${counts.keysStripped} conflicts=${counts.conflicts} invalid=${counts.invalid} missingCols=${counts.missingCols}`,
    );
  }
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
    `Custom fields Pile A column backfill — mode: ${options.execute ? 'EXECUTE' : 'dry-run'}` +
      (options.table ? ` — table: ${options.table}` : ''),
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

  console.log(
    `\nTOTAL: rows=${total.rows} keysFound=${total.keysFound} columnsSet=${total.columnsSet} ` +
      `alreadySet=${total.alreadySet} stripped=${total.keysStripped} conflicts=${total.conflicts} invalid=${total.invalid} ` +
      `missingCols=${total.missingCols} failedTenants=${total.failedTenants}`,
  );

  if (total.conflicts > 0) {
    console.log(
      `\nWarning: ${total.conflicts} key(s) had a real column value DISAGREEING with the blob and were ` +
        'LEFT in the blob (--verbose lists samples). Reconcile them manually before Phase 4 — they still fail the audit.',
    );
  }
  if (total.invalid > 0) {
    console.log(
      `\nWarning: ${total.invalid} blob value(s) failed coercion and were LEFT in the blob ` +
        '(--verbose lists samples). Resolve them before Phase 4 — they would still fail the audit.',
    );
  }
  if (options.execute) {
    console.log(
      total.invalid === 0 && total.conflicts === 0 && total.failedTenants === 0
        ? '\nDone — mapped keys moved to columns and stripped from the blobs. Re-run audit:blobs to confirm zero.'
        : '\nDone with issues — see warnings above. The sweep is idempotent; re-run after resolving.',
    );
  } else {
    console.log(
      `\nDry-run only. ${total.keysStripped} key(s) across ${total.rows} row(s) would be stripped ` +
        `(${total.columnsSet} column(s) filled, ${total.alreadySet} already set` +
        `${total.conflicts > 0 ? `, ${total.conflicts} conflict(s) left for review` : ''}). Re-run with --execute to write.`,
    );
  }

  process.exit(total.failedTenants === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Pile A column backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
