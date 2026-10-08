/**
 * Payroll imports: /api/payroll/imports.
 *
 *   GET    /            list (status, source, from, to, limit, cursor), newest pay date first
 *   GET    /:id         the import with its journal entry lines
 *   POST   /csv         { csv, mapping?, saveMapping?, periodStart?, periodEnd?, sourceFileName?, batchLabel?, dryRun? }
 *   DELETE /:id         reverse the payroll's entry (?date=YYYY-MM-DD, default the pay date); the import becomes `reversed`
 *
 * Permissions: journal:read | journal:create | journal:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { writeAccountingAudit, ClosedPeriodError, LockedPeriodError } from '@weldsuite/books-domain/accounting-guards';
import { isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { PostingError } from '../../services/accounting-posting';
import { PayrollCsvValidationError, importPayrollCsv } from '../../services/payroll/csv-import';
import { loadImport, reversePayrollImport } from '../../services/payroll/imports';
import { PayrollImportError } from '../../services/payroll/journal';
import { loadSavedCsvMapping, saveCsvMapping } from '../../services/payroll/connections';
import { csvMappingSchema } from '../../services/payroll/mapping';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.payrollImports;
const LOG = '[books-api/payroll]';

const csvImportSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  /** The mapping to use; omitted → the entity's saved CSV mapping. */
  mapping: csvMappingSchema.optional(),
  /** Save `mapping` as the entity's CSV mapping once the file imports. */
  saveMapping: z.boolean().optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  sourceFileName: z.string().max(255).nullish(),
  batchLabel: z.string().max(100).nullish(),
  dryRun: z.boolean().optional(),
});

/** Map a failure to the response; anything unexpected is a 500. */
export function failPayroll(c: Context, err: unknown, what: string) {
  if (err instanceof PayrollCsvValidationError) return error.badRequest(c, err.message, { problems: err.problems });
  if (err instanceof PayrollImportError || err instanceof PostingError || err instanceof ClosedPeriodError || err instanceof LockedPeriodError) {
    if (err instanceof PostingError && /not found$/.test(err.message)) return error.notFound(c, err.message.replace(/ not found$/, ''));
    return error.badRequest(c, err.message);
  }
  console.error(`${LOG} ${what} failed:`, err);
  return error.internal(c, `Failed to ${what}`);
}

function encodeCursor(row: { payDate: string; id: string }): string {
  return btoa(encodeURIComponent(JSON.stringify([row.payDate, row.id])));
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(cursor))) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') return [parsed[0], parsed[1]];
  } catch {
    // fall through
  }
  return null;
}

function eventData(row: typeof t.$inferSelect) {
  return {
    id: row.id,
    entityId: row.entityId,
    source: row.source,
    payDate: row.payDate,
    status: row.status,
    journalEntryId: row.journalEntryId,
  } as Record<string, unknown>;
}

// GET /
app.get('/', requirePermission('journal:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(Math.max(Number.parseInt(q.limit || '50', 10) || 50, 1), 200);
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const conditions: SQL[] = [eq(t.entityId, entityId)];
    if (q.status) conditions.push(eq(t.status, q.status));
    if (q.source) conditions.push(eq(t.source, q.source));
    if (q.from) {
      if (!isIsoDate(q.from)) return error.badRequest(c, 'from must be a date (YYYY-MM-DD)');
      conditions.push(gte(t.payDate, q.from));
    }
    if (q.to) {
      if (!isIsoDate(q.to)) return error.badRequest(c, 'to must be a date (YYYY-MM-DD)');
      conditions.push(lte(t.payDate, q.to));
    }
    const total = await db.select({ count: sql<number>`count(*)::int` }).from(t).where(and(...conditions));
    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) return error.badRequest(c, 'Invalid cursor');
      conditions.push(sql`(${t.payDate}, ${t.id}) < (${decoded[0]}::date, ${decoded[1]})`);
    }
    const rows = await db.select().from(t).where(and(...conditions)).orderBy(desc(t.payDate), desc(t.id)).limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return list(c, page, cursorPagination(Number(total[0]?.count ?? 0), hasMore, hasMore ? encodeCursor(page[page.length - 1]!) : null));
  } catch (err) {
    return failPayroll(c, err, 'list payroll imports');
  }
});

// POST /csv
app.post('/csv', requirePermission('journal:create'), zValidator('json', csvImportSchema), async (c) => {
  const db: Database = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const mapping = data.mapping ?? (await loadSavedCsvMapping(db, entityId));
    if (!mapping) return error.badRequest(c, 'Send a mapping, or save one first (PUT /api/payroll/csv-mapping)');

    const result = await importPayrollCsv(db, {
      entityId,
      userId: c.get('userId') ?? null,
      csv: data.csv,
      mapping,
      periodStart: data.periodStart,
      periodEnd: data.periodEnd,
      sourceFileName: data.sourceFileName,
      batchLabel: data.batchLabel,
      dryRun: data.dryRun,
    });

    if (!data.dryRun) {
      for (const imported of result.imports) {
        if (!imported.importId) continue;
        await writeAccountingAudit(c, db, { accountingEntityId: entityId, entityType: 'payroll_import', entityId: imported.importId, action: 'created' });
        publishEntityEvent({
          c,
          entityType: 'payroll_import',
          entityId: imported.importId,
          action: 'created',
          data: { id: imported.importId, entityId, source: 'csv', payDate: imported.payDate, status: 'posted', journalEntryId: imported.journalEntryId },
        });
      }
      if (data.saveMapping && data.mapping && result.imports.length + result.duplicates.length > 0) {
        const saved = await saveCsvMapping(db, entityId, data.mapping);
        publishEntityEvent({
          c,
          entityType: 'payroll_connection',
          entityId: saved.row.id,
          action: saved.created ? 'created' : 'updated',
          data: { id: saved.row.id, entityId, provider: 'csv', status: saved.row.status },
        });
      }
    }
    return success(c, result, data.dryRun ? 200 : 201);
  } catch (err) {
    return failPayroll(c, err, 'import the payroll CSV');
  }
});

// GET /:id
app.get('/:id', requirePermission('journal:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const row = await loadImport(db, id);
    if (!row) return error.notFound(c, 'Payroll import', id);
    const lines = row.journalEntryId
      ? await db
          .select({
            accountId: schema.journalLines.accountId,
            accountCode: schema.accounts.code,
            accountName: schema.accounts.name,
            debit: schema.journalLines.debit,
            credit: schema.journalLines.credit,
            description: schema.journalLines.description,
          })
          .from(schema.journalLines)
          .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
          .where(eq(schema.journalLines.journalEntryId, row.journalEntryId))
          .orderBy(schema.journalLines.sortOrder)
      : [];
    return success(c, { ...row, lines });
  } catch (err) {
    return failPayroll(c, err, 'fetch the payroll import');
  }
});

// DELETE /:id — reverses the entry; the import stays as `reversed`
app.delete('/:id', requirePermission('journal:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const date = c.req.query('date');
  try {
    if (date && !isIsoDate(date)) return error.badRequest(c, 'date must be a date (YYYY-MM-DD)');
    const row = await loadImport(db, id);
    if (!row) return error.notFound(c, 'Payroll import', id);
    const reversed = await reversePayrollImport(db, { importId: id, userId: c.get('userId') ?? null, date });
    await writeAccountingAudit(c, db, {
      accountingEntityId: row.entityId,
      entityType: 'payroll_import',
      entityId: id,
      action: 'reversed',
      changes: { status: { old: row.status, new: 'reversed' } },
    });
    publishEntityEvent({ c, entityType: 'payroll_import', entityId: id, action: 'deleted', data: eventData(reversed) });
    return success(c, reversed);
  } catch (err) {
    return failPayroll(c, err, 'reverse the payroll import');
  }
});

export const payrollImportsRoutes = app;
