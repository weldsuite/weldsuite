/**
 * Sales tax returns, the Sales Tax Center's API — /api/tax-returns.
 *
 *   GET    /periods?agencyId=&from=&to=   periods per agency with due dates, return status, unfiled/overdue flags
 *   GET    /overview                       one line per registered agency: next due period, estimate, last filed
 *   GET    /                               returns (agencyId, status, from, to; cursor pagination)
 *   POST   /                               {agencyId, periodStart?, periodEnd?} open a return (the next period when no dates)
 *   GET    /:id                            the return with its agency and amendments
 *   PATCH  /:id                            {adjustments?, notes?} (adjustments only before filing)
 *   DELETE /:id                            open, calculated or reviewed returns only
 *   POST   /:id/calculate                  builds the worksheet from the agency's tax-ledger rows
 *   POST   /:id/review                     calculated -> reviewed
 *   GET    /:id/documents                  the documents behind the return, with jurisdiction rows and certificates
 *   GET    /:id/pre-file-check             net sales on the return against income, documents behind a difference
 *   GET    /:id/liability-check            the agency's payable in the ledger against what is owed
 *   GET    /:id/exceptions                 changes to the filed period posted after filing
 *   GET    /:id/export?format=csv          the worksheet as a CSV file
 *   POST   /:id/file                       {confirmationNumber, filedAt?}: stamps the rows, marks filed
 *   POST   /:id/payment                    {bankAccountId, amount, date, reference?, differenceReason?}: posts the payment
 *   POST   /:id/amend                      a new return for the same period that counts the exceptions
 *   POST   /:id/carry-forward              {taxLineIds?}: the next return counts the exceptions
 *
 * Permissions: taxes:read | taxes:create | taxes:update | taxes:delete; taxes:file for filing and payment.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { ClosedPeriodError, LockedPeriodError, writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { resolveEntityId } from '../../lib/entity-context';
import { PostingError } from '../../services/accounting-posting';
import { schema } from '@weldsuite/worker-kit/db';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ADJUSTMENT_TYPES,
  TaxReturnError,
  FILED_STATUSES,
  num,
  todayIn,
  type ReturnRow,
} from '../../services/sales-tax-returns/common';
import { loadAgency, loadReturnContext, loadUsEntity, type ReturnContext } from '../../services/sales-tax-returns/context';
import { calculateReturn } from '../../services/sales-tax-returns/calculate';
import { calculateAndStore, createReturn, deleteReturn, listReturns, patchReturn, reviewReturn } from '../../services/sales-tax-returns/lifecycle';
import { listPeriods, salesTaxOverview } from '../../services/sales-tax-returns/overview';
import { agencyLiability, preFileCheck } from '../../services/sales-tax-returns/checks';
import { carryForward, amendReturn, fileReturn, listExceptions } from '../../services/sales-tax-returns/filing';
import { recordReturnPayment } from '../../services/sales-tax-returns/payment';
import { loadCertificateRefs, returnDocuments } from '../../services/sales-tax-returns/documents';
import { loadFiledRows } from '../../services/sales-tax-returns/rows';
import { exportReturn } from '../../services/sales-tax-returns/export';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');
const id30 = z.string().min(1).max(30);

const adjustmentSchema = z.object({
  type: z.enum(ADJUSTMENT_TYPES),
  /** Positive increases what is paid, negative reduces it. */
  amount: z.number().finite(),
  note: z.string().max(255).optional(),
  /** `other` adjustments: the ledger account they post to (default: the agency's sales tax payable). */
  accountId: id30.optional(),
  auto: z.boolean().optional(),
});

const createSchema = z.object({
  agencyId: id30,
  periodStart: day.optional(),
  periodEnd: day.optional(),
});

const patchSchema = z
  .object({
    adjustments: z.array(adjustmentSchema).max(50).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.adjustments !== undefined || v.notes !== undefined, { message: 'Nothing to update' });

const fileSchema = z.object({
  confirmationNumber: z.string().trim().min(1).max(255),
  filedAt: z.union([day, z.string().datetime({ offset: true })]).optional(),
});

const paymentSchema = z.object({
  bankAccountId: id30,
  amount: z.number().finite(),
  date: day,
  reference: z.string().max(255).optional(),
  differenceReason: z.string().max(500).optional(),
});

const carrySchema = z.object({ taxLineIds: z.array(id30).max(5000).optional() });

/** What the return events carry: no amounts per customer, nothing personal. */
function eventData(ret: ReturnRow): Record<string, unknown> {
  return {
    id: ret.id,
    agencyId: ret.agencyId,
    stateCode: ret.stateCode,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    status: ret.status,
    totalDue: num(ret.totalDue),
    amendsReturnId: ret.amendsReturnId,
  };
}

function publishReturnEvent(c: Ctx, ret: ReturnRow, action: 'created' | 'updated' | 'deleted' | 'filed' | 'paid') {
  publishEntityEvent({ c, entityType: 'tax_return', entityId: ret.id, action, data: eventData(ret) });
}

async function audit(c: Ctx, ret: ReturnRow, action: string, changes?: Record<string, { old: unknown; new: unknown }>) {
  await writeAccountingAudit(c, c.get('tenantDb'), {
    accountingEntityId: ret.entityId,
    entityType: 'tax_return',
    entityId: ret.id,
    action,
    changes,
  });
}

function serialize(ret: ReturnRow) {
  return { ...ret, totalDue: num(ret.totalDue), paymentAmount: ret.paymentAmount === null ? null : num(ret.paymentAmount) };
}

function fail(c: Ctx, label: string, err: unknown): Response {
  if (err instanceof TaxReturnError) {
    if (err.kind === 'not_found') return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
    if (err.kind === 'conflict') return error.conflict(c, err.message, err.details);
    return error.badRequest(c, err.message, err.details);
  }
  if (err instanceof PostingError || err instanceof ClosedPeriodError || err instanceof LockedPeriodError) {
    return error.badRequest(c, err.message);
  }
  console.error(`[books-api/tax-returns] ${label} failed:`, err);
  return error.internal(c, `Failed to ${label}`);
}

async function entityOf(c: Ctx): Promise<string> {
  const entityId = await resolveEntityId(c, c.get('tenantDb'));
  if (!entityId) throw new TaxReturnError('No accounting entity resolved');
  return entityId;
}

async function contextOf(c: Ctx): Promise<ReturnContext & { entityId: string }> {
  const entityId = await entityOf(c);
  return { entityId, ...(await loadReturnContext(c.get('tenantDb'), entityId, c.req.param('id') ?? '')) };
}

// GET /periods
app.get('/periods', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    for (const key of ['from', 'to'] as const) {
      if (q[key] && !/^\d{4}-\d{2}-\d{2}$/.test(q[key])) return error.badRequest(c, `${key} must be a YYYY-MM-DD date`);
    }
    const entity = await loadUsEntity(db, await entityOf(c));
    return success(c, await listPeriods(db, entity, { agencyId: q.agencyId, from: q.from, to: q.to }));
  } catch (err) {
    return fail(c, 'fetch periods', err);
  }
});

// GET /overview
app.get('/overview', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await loadUsEntity(db, await entityOf(c));
    return success(c, await salesTaxOverview(db, entity));
  } catch (err) {
    return fail(c, 'fetch the sales tax overview', err);
  }
});

// GET / — returns, newest period first
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const limit = Math.min(Math.max(Number.parseInt(q.limit || '25', 10) || 25, 1), 100);
    const result = await listReturns(db, entityId, {
      agencyId: q.agencyId,
      status: q.status,
      from: q.from,
      to: q.to,
      limit,
      cursor: q.cursor,
    });
    return list(c, result.rows.map(serialize), cursorPagination(result.totalCount, result.hasMore, result.cursor));
  } catch (err) {
    return fail(c, 'fetch tax returns', err);
  }
});

// POST / — open a return for a period (the next one without a return when no dates are given)
app.post('/', requirePermission('taxes:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await loadUsEntity(db, await entityOf(c));
    const agency = await loadAgency(db, entity.id, data.agencyId);
    const ret = await createReturn(db, { entity, agency, periodStart: data.periodStart, periodEnd: data.periodEnd });
    await audit(c, ret, 'created');
    publishReturnEvent(c, ret, 'created');
    return success(c, serialize(ret), 201);
  } catch (err) {
    return fail(c, 'create the tax return', err);
  }
});

// GET /:id
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const amendments = await db
      .select({ id: schema.taxReturns.id, status: schema.taxReturns.status, filedAt: schema.taxReturns.filedAt })
      .from(schema.taxReturns)
      .where(and(eq(schema.taxReturns.amendsReturnId, ret.id), isNull(schema.taxReturns.deletedAt)));
    const today = todayIn(entity.timezone);
    const filed = FILED_STATUSES.includes(ret.status);
    return success(c, {
      ...serialize(ret),
      agency: {
        id: agency.id,
        name: agency.name,
        stateCode: agency.stateCode,
        filingFrequency: agency.filingFrequency,
        dueDay: agency.dueDay,
        reportingBasis: agency.reportingBasis,
        registrationNumber: agency.registrationNumber,
        portalUrl: agency.portalUrl,
      },
      amendments,
      overdue: !filed && Boolean(ret.dueDate && ret.periodEnd < today && ret.dueDate < today),
    });
  } catch (err) {
    return fail(c, 'fetch the tax return', err);
  }
});

// PATCH /:id — adjustments (before filing) and notes
app.patch('/:id', requirePermission('taxes:update'), zValidator('json', patchSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const { ret } = await contextOf(c);
    const updated = await patchReturn(db, ret, data);
    await audit(c, updated, 'updated', {
      ...(data.adjustments ? { adjustments: { old: ret.adjustments, new: data.adjustments } } : {}),
      ...(data.notes !== undefined ? { notes: { old: ret.notes, new: data.notes } } : {}),
    });
    publishReturnEvent(c, updated, 'updated');
    return success(c, serialize(updated));
  } catch (err) {
    return fail(c, 'update the tax return', err);
  }
});

// DELETE /:id — a return that is not filed
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { ret } = await contextOf(c);
    await deleteReturn(db, ret);
    await audit(c, ret, 'deleted');
    publishReturnEvent(c, { ...ret, status: 'deleted' }, 'deleted');
    return noContent(c);
  } catch (err) {
    return fail(c, 'delete the tax return', err);
  }
});

// POST /:id/calculate
app.post('/:id/calculate', requirePermission('taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const { ret: updated } = await calculateAndStore(db, { entity, agency, ret });
    await audit(c, updated, 'calculated', { totalDue: { old: num(ret.totalDue), new: num(updated.totalDue) } });
    publishReturnEvent(c, updated, 'updated');
    return success(c, serialize(updated));
  } catch (err) {
    return fail(c, 'calculate the tax return', err);
  }
});

// POST /:id/review
app.post('/:id/review', requirePermission('taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { ret } = await contextOf(c);
    const updated = await reviewReturn(db, ret);
    await audit(c, updated, 'reviewed', { status: { old: ret.status, new: updated.status } });
    publishReturnEvent(c, updated, 'updated');
    return success(c, serialize(updated));
  } catch (err) {
    return fail(c, 'review the tax return', err);
  }
});

// GET /:id/documents — invoices, credit memos, bills and entries behind the return
app.get('/:id/documents', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  try {
    const { entity, ret, agency } = await contextOf(c);
    const basis = agency.reportingBasis === 'cash' ? 'cash' : 'accrual';
    const rows = FILED_STATUSES.includes(ret.status)
      ? await loadFiledRows(db, {
          entityId: entity.id,
          agency,
          returnId: ret.id,
          periodStart: ret.periodStart,
          periodEnd: ret.periodEnd,
          reportingBasis: basis,
          filedAt: ret.filedAt,
        })
      : (await calculateReturn(db, { entity, agency, ret })).rows;
    const documents = await returnDocuments(db, entity.id, rows.entries);

    const limit = Math.min(Math.max(Number.parseInt(q.limit || '100', 10) || 100, 1), 500);
    const offset = Math.max(Number.parseInt(q.cursor || '0', 10) || 0, 0);
    const page = documents.slice(offset, offset + limit);
    const certificates = await loadCertificateRefs(db, entity.id, page.flatMap((d) => d.certificateIds));
    const byId = new Map(certificates.map((cert) => [cert.id, cert]));
    const hasMore = offset + limit < documents.length;
    return list(
      c,
      page.map((d) => ({ ...d, certificates: d.certificateIds.map((id) => byId.get(id)).filter(Boolean) })),
      cursorPagination(documents.length, hasMore, hasMore ? String(offset + limit) : null),
    );
  } catch (err) {
    return fail(c, 'fetch the return documents', err);
  }
});

// GET /:id/pre-file-check
app.get('/:id/pre-file-check', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { entity, ret, agency } = await contextOf(c);
    return success(c, await preFileCheck(db, { entity, agency, ret }));
  } catch (err) {
    return fail(c, 'run the pre-file check', err);
  }
});

// GET /:id/liability-check
app.get('/:id/liability-check', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const liability = await agencyLiability(db, { entityId: entity.id, agency, asOf: todayIn(entity.timezone) });
    return success(c, { returnId: ret.id, ...liability });
  } catch (err) {
    return fail(c, 'run the liability check', err);
  }
});

// GET /:id/exceptions
app.get('/:id/exceptions', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { entity, ret, agency } = await contextOf(c);
    return success(c, await listExceptions(db, { entity, agency, ret }));
  } catch (err) {
    return fail(c, 'fetch the return exceptions', err);
  }
});

// GET /:id/export?format=csv
app.get('/:id/export', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const format = c.req.query('format') ?? 'csv';
  try {
    if (format !== 'csv' && format !== 'json') return error.badRequest(c, 'format must be csv or json');
    const { entity, ret, agency } = await contextOf(c);
    const artifact = await exportReturn(db, { entity, agency, ret });
    if (format === 'json') return success(c, artifact);
    return new Response(artifact.content, {
      headers: {
        'Content-Type': `${artifact.mimeType}; charset=utf-8`,
        'Content-Disposition': `attachment; filename="${artifact.filename}"`,
      },
    });
  } catch (err) {
    return fail(c, 'export the tax return', err);
  }
});

// POST /:id/file — stamp the rows and mark the return filed
app.post('/:id/file', requirePermission('taxes:file'), zValidator('json', fileSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const filedAt = data.filedAt ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(data.filedAt) ? `${data.filedAt}T12:00:00Z` : data.filedAt) : undefined;
    const result = await fileReturn(db, {
      entity,
      agency,
      ret,
      confirmationNumber: data.confirmationNumber,
      filedAt,
      userId: c.get('userId') ?? null,
    });
    await audit(c, result.ret, 'filed', {
      status: { old: ret.status, new: 'filed' },
      confirmationNumber: { old: null, new: data.confirmationNumber },
    });
    publishReturnEvent(c, result.ret, 'filed');
    return success(c, { ...serialize(result.ret), warnings: result.warnings });
  } catch (err) {
    return fail(c, 'file the tax return', err);
  }
});

// POST /:id/payment — post the payment of a filed return
app.post('/:id/payment', requirePermission('taxes:file'), zValidator('json', paymentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const result = await recordReturnPayment(db, {
      entity,
      agency,
      ret,
      bankAccountId: data.bankAccountId,
      amount: data.amount,
      date: data.date,
      reference: data.reference,
      differenceReason: data.differenceReason,
      userId: c.get('userId') ?? null,
    });
    await audit(c, result.ret, 'paid', {
      status: { old: ret.status, new: 'paid' },
      paymentAmount: { old: null, new: data.amount },
      journalEntryId: { old: null, new: result.journalEntryId },
    });
    publishReturnEvent(c, result.ret, 'paid');
    return success(c, {
      ...serialize(result.ret),
      payment: { journalEntryId: result.journalEntryId, totalDue: result.totalDue, difference: result.difference, lines: result.lines },
    });
  } catch (err) {
    return fail(c, 'record the tax payment', err);
  }
});

// POST /:id/amend — a new return for the filed period that counts the exceptions
app.post('/:id/amend', requirePermission('taxes:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const result = await amendReturn(db, { entity, agency, ret, userId: c.get('userId') ?? null });
    await audit(c, result.ret, 'amended', { amendsReturnId: { old: null, new: ret.id } });
    publishReturnEvent(c, result.ret, 'created');
    return success(c, { ...serialize(result.ret), exceptionRows: result.exceptionRows }, 201);
  } catch (err) {
    return fail(c, 'amend the tax return', err);
  }
});

// POST /:id/carry-forward — the next return of the agency counts the exceptions
app.post('/:id/carry-forward', requirePermission('taxes:update'), zValidator('json', carrySchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const { entity, ret, agency } = await contextOf(c);
    const result = await carryForward(db, { entity, agency, ret, taxLineIds: data.taxLineIds, userId: c.get('userId') ?? null });
    await audit(c, result.ret, 'carried_forward', { rows: { old: 0, new: result.carriedRows } });
    publishReturnEvent(c, result.ret, 'updated');
    return success(c, {
      ...serialize(result.ret),
      carriedRows: result.carriedRows,
      taxAmount: result.taxAmount,
      recalculate: result.recalculate,
    });
  } catch (err) {
    return fail(c, 'carry the exceptions forward', err);
  }
});

export const taxReturnsRoutes = app;
