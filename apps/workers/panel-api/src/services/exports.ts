/**
 * Raw exports: a project's Basin tables copied to the customer's
 * S3-compatible bucket as gzipped JSON Lines, hourly or daily.
 *
 * The runner walks windows of at most an hour from `exported_until` (or
 * `start_at`, never before the plan's retention) up to now − 15 minutes (the
 * Basin lag), and for each window writes every chosen table: pages of rows
 * through the scoped reader in `@weldsuite/panel-domain/query/export` (erased
 * people left out), one file per page at
 *
 *   <prefix>/<table>/dt=YYYY-MM-DD/hour=HH/<exportId>-<windowFrom>.jsonl.gz
 *
 * (`windowFrom` in ISO 8601 basic form, `20261114T100000Z`; a second page adds
 * `-1`, `-2`, …). One `panel_export_runs` row per table and window. Only when
 * every table of a window is written does `exported_until` move to its end, so
 * a failure is retried from the same window and nothing is skipped (a retried
 * file overwrites the same key). Three failed attempts in a row mark the
 * export `failing` and email the member who set it up; it keeps retrying, and
 * the first success makes it `active` again.
 *
 * Exported data is the customer's: an erasure after export does not reach it.
 */

import { and, count, desc, eq, isNull, lt, type SQL } from 'drizzle-orm';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelExport, PanelExportRun, PanelExportTable } from '@weldsuite/db/schema';
import type {
  PanelExportDto,
  PanelExportRunDto,
  PanelExportTestDto,
  ParsedCreatePanelExport,
  ParsedPanelExportDestination,
  ParsedUpdatePanelExport,
} from '@weldsuite/app-api-client/schemas/weldpanel-monitor';
import { eventRetentionDays, normalizeRows, type PanelQueryContext, type PanelSqlExecutor } from '@weldsuite/panel-domain/query';
import { exportCursorOf, exportPageQuery, PANEL_EXPORT_PAGE_SIZE, type ExportCursor } from '@weldsuite/panel-domain/query/export';
import { projectObjectStub } from '@weldsuite/panel-domain/project-object';
import type { Env } from '../types';
import { deleteObject, gzip, putObject, type S3CallOptions, type S3Credentials, type S3Destination } from './s3';
import { openSecret } from './secrets';
import { appUrl, memberRecipients } from './delivery';
import { sendSystemEmail, type EmailTransport } from '@weldsuite/emails';
import { workerTransport } from '@weldsuite/emails/transports/binding';
import { EXPORT_LAG_MS, nextExportRun } from './schedule';
import { QueryUnavailableError } from './query-engine';

const { panelExportRuns, panelExports } = schema;
const { plans, workspaces } = masterSchema;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Most windows one run writes for one export (a day of hours); the rest waits for the next cron. */
export const MAX_WINDOWS_PER_RUN = 24;
/** Most pages one table writes for one window; past it the window fails rather than run for ever. */
export const MAX_PAGES_PER_WINDOW = 200;
/** Failed attempts in a row before an export is marked failing. */
export const FAILURES_BEFORE_FAILING = 3;

// ---------------------------------------------------------------------------
// Rows and DTOs
// ---------------------------------------------------------------------------

export function toExportDto(e: PanelExport, nextRunAt: Date | null): PanelExportDto {
  return {
    id: e.id,
    projectId: e.projectId,
    name: e.name,
    destination: {
      provider: e.destination.provider,
      endpoint: e.destination.endpoint,
      region: e.destination.region,
      bucket: e.destination.bucket,
      prefix: e.destination.prefix,
      accessKeyId: e.destination.accessKeyId,
      pathStyle: e.destination.pathStyle,
    },
    tables: [...e.tables],
    frequency: e.frequency,
    startAt: e.startAt.toISOString(),
    exportedUntil: e.exportedUntil?.toISOString() ?? null,
    status: e.status,
    lastRunAt: e.lastRunAt?.toISOString() ?? null,
    lastError: e.lastError,
    nextRunAt: e.status === 'paused' ? null : (nextRunAt?.toISOString() ?? null),
    createdByUserId: e.createdByUserId,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

export function toExportRunDto(r: PanelExportRun): PanelExportRunDto {
  return {
    id: r.id,
    exportId: r.exportId,
    table: r.table,
    windowFrom: r.windowFrom.toISOString(),
    windowTo: r.windowTo.toISOString(),
    status: r.status,
    rows: r.rows,
    bytes: r.bytes,
    files: r.files,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** The entity-event payload: never the credentials. */
export function exportEventData(e: PanelExport) {
  return { id: e.id, projectId: e.projectId, name: e.name, provider: e.destination.provider, bucket: e.destination.bucket, status: e.status };
}

export function exportsPath(): string {
  return '/weldpanel/settings?tab=exports';
}

/** When an export runs next; null while paused or deleted. */
export function nextRunOf(e: Pick<PanelExport, 'status' | 'deletedAt' | 'frequency'>, now: Date): Date | null {
  if (e.status === 'paused' || e.deletedAt) return null;
  return nextExportRun(e.frequency, now);
}

export async function listExports(db: Database, projectId: string): Promise<PanelExport[]> {
  return db
    .select()
    .from(panelExports)
    .where(and(eq(panelExports.projectId, projectId), isNull(panelExports.deletedAt)))
    .orderBy(desc(panelExports.createdAt))
    .limit(100);
}

export async function getExport(db: Database, id: string): Promise<PanelExport | null> {
  const [row] = await db.select().from(panelExports).where(and(eq(panelExports.id, id), isNull(panelExports.deletedAt))).limit(1);
  return row ?? null;
}

function destinationOf(d: ParsedPanelExportDestination): PanelExport['destination'] {
  return { provider: d.provider, endpoint: d.endpoint ?? null, region: d.region, bucket: d.bucket, prefix: d.prefix, accessKeyId: d.accessKeyId, pathStyle: d.pathStyle };
}

export async function createExport(db: Database, input: ParsedCreatePanelExport, secretCiphertext: string, userId: string, startAt: Date): Promise<PanelExport> {
  const [row] = await db
    .insert(panelExports)
    .values({
      id: generateId('pnex'),
      projectId: input.projectId,
      name: input.name,
      destination: destinationOf(input.destination),
      secretCiphertext,
      tables: input.tables,
      frequency: input.frequency,
      startAt,
      status: 'active',
      createdByUserId: userId,
    })
    .returning();
  return row as PanelExport;
}

export async function updateExport(db: Database, id: string, input: ParsedUpdatePanelExport, secretCiphertext: string | null): Promise<PanelExport | null> {
  const [row] = await db
    .update(panelExports)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.destination !== undefined && { destination: destinationOf(input.destination) }),
      ...(secretCiphertext !== null && { secretCiphertext }),
      ...(input.tables !== undefined && { tables: input.tables }),
      ...(input.frequency !== undefined && { frequency: input.frequency }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelExports.id, id), isNull(panelExports.deletedAt)))
    .returning();
  return row ?? null;
}

export async function setExportStatus(db: Database, id: string, status: PanelExport['status']): Promise<PanelExport | null> {
  const [row] = await db
    .update(panelExports)
    .set({ status, updatedAt: new Date(), ...(status === 'active' && { lastError: null }) })
    .where(and(eq(panelExports.id, id), isNull(panelExports.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteExport(db: Database, id: string): Promise<PanelExport | null> {
  const [row] = await db
    .update(panelExports)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelExports.id, id), isNull(panelExports.deletedAt)))
    .returning();
  return row ?? null;
}

/** An export's runs, newest first; the cursor is the last run's `startedAt` (ISO). */
export async function listExportRuns(db: Database, exportId: string, cursor: Date | null, limit: number): Promise<PanelExportRun[]> {
  const conds: SQL[] = [eq(panelExportRuns.exportId, exportId)];
  if (cursor) conds.push(lt(panelExportRuns.startedAt, cursor));
  return db.select().from(panelExportRuns).where(and(...conds)).orderBy(desc(panelExportRuns.startedAt)).limit(limit);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** `2026-11-14T10:00:00.000Z` → `20261114T100000Z` (ISO 8601 basic: no `:` in object keys). */
export function basicIso(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The object key of one page of one table and window. */
export function exportObjectKey(prefix: string, table: PanelExportTable, exportId: string, windowFrom: Date, page: number): string {
  const iso = windowFrom.toISOString();
  const part = page > 0 ? `-${page}` : '';
  const name = `${exportId}-${basicIso(windowFrom)}${part}.jsonl.gz`;
  const path = `${table}/dt=${iso.slice(0, 10)}/hour=${iso.slice(11, 13)}/${name}`;
  return prefix ? `${prefix}/${path}` : path;
}

/** JSON Lines: one object per row, `properties` parsed back into an object. */
export function toJsonLines(rows: readonly Record<string, unknown>[]): string {
  return rows
    .map((row) => {
      const out: Record<string, unknown> = { ...row };
      if (typeof out.properties === 'string') {
        try {
          out.properties = JSON.parse(out.properties) as unknown;
        } catch {
          // Keep the text as stored.
        }
      }
      return JSON.stringify(out);
    })
    .join('\n')
    .concat(rows.length > 0 ? '\n' : '');
}

/** The end of the hour `from` falls in, or `end` if sooner. */
export function windowEnd(from: Date, end: Date): Date {
  const next = Math.floor(from.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS;
  return new Date(Math.min(next, end.getTime()));
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

async function planRetentionDays(masterDb: AnyMasterDatabase, workspaceId: string): Promise<number> {
  const [row] = await masterDb
    .select({ slug: plans.slug })
    .from(workspaces)
    .leftJoin(plans, eq(plans.id, workspaces.planId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return eventRetentionDays(row?.slug ?? null);
}

/**
 * The scope an export reads with: the workspace and project, the plan's
 * retention, and the erased ids from the project's Durable Object (without it
 * the export does not run, like a query would not).
 */
export async function exportContext(env: Env, masterDb: AnyMasterDatabase, workspaceId: string, projectId: string, now: Date): Promise<PanelQueryContext> {
  if (!env.PANEL_PROJECT) throw new QueryUnavailableError('Analytics queries are not configured here');
  const [erasedIds, retentionDays] = await Promise.all([projectObjectStub(env.PANEL_PROJECT, projectId).erasedIds(), planRetentionDays(masterDb, workspaceId)]);
  return { workspaceId, projectId, retentionDays, hasIdentifiedUsers: false, erasedIds, now };
}

export interface ExportRunDeps {
  db: Database;
  env: Env;
  now: Date;
  /** Stop starting windows after this (epoch ms). */
  deadline: number;
  execute: PanelSqlExecutor;
  context: () => Promise<PanelQueryContext>;
  s3?: S3CallOptions;
  /** Tells the member who set the export up that it is failing. */
  notifyFailing: (exp: PanelExport, error: string) => Promise<void>;
}

export interface ExportRunResult {
  export: PanelExport;
  windows: number;
  /** Everything up to now − lag is written; false when the run stopped early (limit, deadline or failure). */
  caughtUp: boolean;
  error: string | null;
}

async function writeTableWindow(
  deps: ExportRunDeps,
  exp: PanelExport,
  ctx: PanelQueryContext,
  credentials: S3Credentials,
  table: PanelExportTable,
  from: Date,
  to: Date,
): Promise<void> {
  const [run] = await deps.db
    .insert(panelExportRuns)
    .values({ id: generateId('pner'), exportId: exp.id, projectId: exp.projectId, table, windowFrom: from, windowTo: to, status: 'running', startedAt: new Date() })
    .returning();
  let rows = 0;
  let bytes = 0;
  let files = 0;
  try {
    let after: ExportCursor | null = null;
    for (let page = 0; page < MAX_PAGES_PER_WINDOW; page += 1) {
      const query = exportPageQuery(ctx, { table, from, to, after });
      const result = await deps.execute(query);
      const pageRows = normalizeRows(result.rows, query.columns);
      if (pageRows.length > 0) {
        const body = await gzip(toJsonLines(pageRows));
        const destination: S3Destination = exp.destination;
        await putObject(destination, credentials, exportObjectKey(exp.destination.prefix, table, exp.id, from, page), body, { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' }, deps.s3);
        rows += pageRows.length;
        bytes += body.byteLength;
        files += 1;
      }
      if (pageRows.length < PANEL_EXPORT_PAGE_SIZE) {
        await deps.db.update(panelExportRuns).set({ status: 'succeeded', rows, bytes, files, finishedAt: new Date() }).where(eq(panelExportRuns.id, run!.id));
        return;
      }
      after = exportCursorOf(table, pageRows[pageRows.length - 1]!);
    }
    throw new Error('Too many rows in one hour for one export run');
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    await deps.db.update(panelExportRuns).set({ status: 'failed', rows, bytes, files, error: message, finishedAt: new Date() }).where(eq(panelExportRuns.id, run!.id));
    throw err;
  }
}

/**
 * Failed attempts at the window the export is stuck on. The cursor only moves
 * once a whole window is written, so every attempt since the last success
 * failed on this window: this is the number of failures in a row.
 */
async function failuresAt(db: Database, exportId: string, windowFrom: Date): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(panelExportRuns)
    .where(and(eq(panelExportRuns.exportId, exportId), eq(panelExportRuns.windowFrom, windowFrom), eq(panelExportRuns.status, 'failed')));
  return Number(row?.n ?? 0);
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Records a failed attempt at `windowFrom`; the third in a row marks the export failing and mails its creator. */
async function recordFailure(deps: ExportRunDeps, exp: PanelExport, error: string, windowFrom: Date): Promise<ExportRunResult> {
  const { db, now } = deps;
  const failing = exp.status !== 'failing' && (await failuresAt(db, exp.id, windowFrom)) >= FAILURES_BEFORE_FAILING;
  const [row] = await db
    .update(panelExports)
    .set({ lastError: error.slice(0, 1000), lastRunAt: now, updatedAt: now, ...(failing && { status: 'failing' as const }) })
    .where(eq(panelExports.id, exp.id))
    .returning();
  if (failing && row) {
    await deps.notifyFailing(row, error).catch((err: unknown) => console.error(`[panel-api] export ${exp.id} failing mail failed: ${errorMessage(err)}`));
  }
  return { export: row ?? exp, windows: 0, caughtUp: false, error };
}

type Prepared = { ok: true; ctx: PanelQueryContext; credentials: S3Credentials } | { ok: false; error: string };

/** The read scope and the opened secret key; a failure here is not the destination's, so it adds no run row. */
async function prepare(deps: ExportRunDeps, exp: PanelExport): Promise<Prepared> {
  try {
    const ctx = await deps.context();
    const secretAccessKey = await openSecret(deps.env, exp.secretCiphertext);
    return { ok: true, ctx, credentials: { accessKeyId: exp.destination.accessKeyId, secretAccessKey } };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Every table of one window, then the cursor moves to its end. */
async function writeWindow(deps: ExportRunDeps, exp: PanelExport, prepared: Extract<Prepared, { ok: true }>, from: Date, to: Date): Promise<PanelExport> {
  for (const table of exp.tables) await writeTableWindow(deps, exp, prepared.ctx, prepared.credentials, table, from, to);
  const [row] = await deps.db
    .update(panelExports)
    .set({ exportedUntil: to, lastRunAt: deps.now, lastError: null, updatedAt: deps.now, ...(exp.status === 'failing' && { status: 'active' as const }) })
    .where(eq(panelExports.id, exp.id))
    .returning();
  return row ?? exp;
}

/** Writes the export's due windows (bounded per run). Never throws: a failure is recorded on the export. */
export async function runExport(deps: ExportRunDeps, exp: PanelExport): Promise<ExportRunResult> {
  const { db, now } = deps;
  if (exp.status === 'paused' || exp.deletedAt) return { export: exp, windows: 0, caughtUp: true, error: null };

  const prepared = await prepare(deps, exp);
  if (!prepared.ok) {
    await db.update(panelExports).set({ lastError: prepared.error.slice(0, 1000), lastRunAt: now, updatedAt: now }).where(eq(panelExports.id, exp.id));
    return { export: exp, windows: 0, caughtUp: false, error: prepared.error };
  }

  const floor = now.getTime() - prepared.ctx.retentionDays * DAY_MS;
  const end = new Date(now.getTime() - EXPORT_LAG_MS);
  let cursor = new Date(Math.max((exp.exportedUntil ?? exp.startAt).getTime(), floor));
  let windows = 0;
  let current = exp;

  while (cursor.getTime() < end.getTime() && windows < MAX_WINDOWS_PER_RUN && Date.now() < deps.deadline) {
    const to = windowEnd(cursor, end);
    try {
      current = await writeWindow(deps, current, prepared, cursor, to);
    } catch (err) {
      return recordFailure(deps, current, errorMessage(err), cursor);
    }
    cursor = to;
    windows += 1;
  }

  if (windows === 0) {
    const [row] = await db.update(panelExports).set({ lastRunAt: now, updatedAt: now }).where(eq(panelExports.id, exp.id)).returning();
    if (row) current = row;
  }
  return { export: current, windows, caughtUp: cursor.getTime() >= end.getTime(), error: null };
}

/** Writes `_weldpanel_test.txt` under the prefix and deletes it again. */
export async function testDestination(destination: ParsedPanelExportDestination, credentials: S3Credentials, options: S3CallOptions = {}): Promise<PanelExportTestDto> {
  const key = destination.prefix ? `${destination.prefix}/_weldpanel_test.txt` : '_weldpanel_test.txt';
  const body = new TextEncoder().encode('WeldPanel export test. This file is deleted right after it is written.\n');
  const dest: S3Destination = { ...destination, endpoint: destination.endpoint ?? null };
  try {
    await putObject(dest, credentials, key, body, { 'content-type': 'text/plain' }, options);
  } catch (err) {
    return { ok: false, wrote: false, deleted: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await deleteObject(dest, credentials, key, options);
  } catch (err) {
    return { ok: false, wrote: true, deleted: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, wrote: true, deleted: true, error: null };
}

/** Emails the member who set the export up that it is failing (in their language). */
export async function sendExportFailingMail(
  ctx: { env: Env; db: Database; clerkOrgId: string; transport?: EmailTransport | null },
  exp: PanelExport,
  lastError: string,
): Promise<number> {
  const transport = ctx.transport === undefined ? workerTransport(ctx.env) : ctx.transport;
  if (!transport) return 0;
  const [recipient] = await memberRecipients(ctx.db, [exp.createdByUserId]);
  if (!recipient?.email) return 0;
  const [project] = await ctx.db.select({ name: schema.panelProjects.name }).from(schema.panelProjects).where(eq(schema.panelProjects.id, exp.projectId)).limit(1);
  await sendSystemEmail(transport, {
    template: 'panel.export-failing',
    props: {
      exportName: exp.name,
      projectName: project?.name ?? '',
      bucket: exp.destination.prefix ? `${exp.destination.bucket}/${exp.destination.prefix}` : exp.destination.bucket,
      failures: FAILURES_BEFORE_FAILING,
      lastError: lastError.slice(0, 300),
      url: appUrl({ env: ctx.env, clerkOrgId: ctx.clerkOrgId }, exportsPath()),
    },
    to: recipient.email,
    locale: recipient.locale,
    brand: { kind: 'weldsuite', module: 'WeldPanel' },
  });
  return 1;
}
