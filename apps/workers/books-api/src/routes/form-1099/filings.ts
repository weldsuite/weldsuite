/**
 * 1099 filings: /api/form-1099/filings (mounted by ./index.ts).
 *
 *   GET    /                         filings of the entity (?year=&formType=&status=)
 *   POST   /                         {taxYear, formType} draft with one line per recipient
 *   GET    /:id                      the filing with its lines
 *   PATCH  /:id                      {notes}
 *   DELETE /:id                      draft only
 *   POST   /:id/refresh              recompute from the books, keeping adjustments and exclusions
 *   PATCH  /:id/lines/:lineId        adjustments, include/exclude with a reason, state fields
 *   POST   /:id/review               draft -> reviewed
 *   POST   /:id/generate             snapshot recipients and TINs -> generated   (taxes:file)
 *   GET    /:id/iris-csv             IRIS upload files with full TINs            (taxes:file + tax_ids:reveal)
 *   POST   /:id/iris-csv             same, with {templateHeaders} in the body
 *   GET    /:id/lines/:lineId/copies layout data for the recipient copies (?copies=B,1,2,C)
 *   POST   /:id/mark-filed           {confirmationNumber, filedAt?}              (taxes:file)
 *   POST   /:id/lines/:lineId/correct {boxes, reason}                            (taxes:file)
 *   POST   /:id/lines/:lineId/delivered {method: print|email}
 *
 * Permissions: taxes:read | create | update | delete | file, and tax_ids:reveal
 * for the IRIS file. Entity events never carry recipients or TINs.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { Form1099Error } from '../../services/form-1099/errors';
import {
  correctLine,
  createFiling,
  deleteFiling,
  filingEventData,
  generateFiling,
  listFilings,
  loadFilingDetail,
  markFiled,
  markLineDelivered,
  refreshFiling,
  reviewFiling,
  updateLine,
} from '../../services/form-1099/filings';
import { buildCopies, buildIrisFiles, parseCopies, parseTemplateHeaders } from '../../services/form-1099/outputs';
import { VendorTaxKeyError } from '../../services/vendor-tax-data';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const currentYear = () => new Date().getUTCFullYear();

const createSchema = z.object({
  taxYear: z.number().int().min(2020).max(currentYear() + 1),
  formType: z.enum(['nec', 'misc']),
});

const updateFilingSchema = z.object({ notes: z.string().max(5000).nullable() });

const boxCode = z.string().regex(/^(nec|misc)_\d{1,2}$/);

const linePatchSchema = z.object({
  adjustments: z
    .array(z.object({ box: boxCode, amount: z.number().finite().refine((n) => n !== 0, 'Not zero'), reason: z.string().trim().min(1).max(255) }))
    .max(50)
    .optional(),
  status: z.enum(['included', 'excluded']).optional(),
  excludedReason: z.string().trim().max(255).nullable().optional(),
  stateCode: z.string().trim().length(2).nullable().optional(),
  stateIdNumber: z.string().trim().max(50).nullable().optional(),
  stateIncome: z.number().finite().min(0).nullable().optional(),
  stateWithheld: z.number().finite().min(0).nullable().optional(),
  boxes: z.record(boxCode, z.number().finite().min(0)).optional(),
});

const markFiledSchema = z.object({
  confirmationNumber: z.string().trim().min(1).max(255),
  filedAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
});

const correctSchema = z.object({
  boxes: z.record(boxCode, z.number().finite().min(0)),
  reason: z.string().trim().min(1).max(255),
  /** Take the recipient's name, address and TIN from the vendor again (a TIN or name correction). */
  refreshRecipient: z.boolean().optional(),
});

const deliveredSchema = z.object({ method: z.enum(['print', 'email']) });

const irisBodySchema = z.object({
  templateHeaders: z.union([z.array(z.string().max(200)).max(300), z.string().max(60_000)]).optional(),
});

function userIdOf(c: AppContext): string {
  return c.get('userId') ?? 'unknown';
}

function respondError(c: AppContext, err: unknown, what: string) {
  if (err instanceof Form1099Error) {
    switch (err.kind) {
      case 'not_found':
        return c.json({ error: { code: 'NOT_FOUND', message: err.message, details: err.details } }, 404);
      case 'conflict':
        return error.conflict(c, err.message, err.details);
      case 'unavailable':
        return error.unavailable(c, err.message);
      default:
        return error.badRequest(c, err.message, err.details);
    }
  }
  if (err instanceof VendorTaxKeyError) return error.unavailable(c, err.message);
  // Never log the error object itself: it could carry a decrypted value.
  console.error(`[books-api/form-1099] ${what} failed:`, err instanceof Error ? err.message : 'unknown error');
  return error.internal(c, `Failed to ${what}`);
}

async function entityOr400(c: AppContext): Promise<string | Response> {
  const entityId = await resolveEntityId(c, c.get('tenantDb'));
  return entityId ?? error.badRequest(c, 'No accounting entity resolved');
}

async function audit(c: AppContext, entityId: string, filingId: string, action: string, changes?: Record<string, { old: unknown; new: unknown }>) {
  await writeAccountingAudit(c, c.get('tenantDb'), {
    accountingEntityId: entityId,
    entityType: 'form_1099_filing',
    entityId: filingId,
    action,
    changes,
  });
}

async function readOptionalJson(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

// GET /: filings of the entity
app.get('/', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return list(c, [], cursorPagination(0, false, null));
    const q = c.req.query();
    const year = q.year ? Number.parseInt(q.year, 10) : undefined;
    const rows = await listFilings(db, entityId, {
      taxYear: year && Number.isInteger(year) ? year : undefined,
      formType: q.formType === 'nec' || q.formType === 'misc' ? q.formType : undefined,
      status: q.status,
    });
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    return respondError(c, err, 'fetch 1099 filings');
  }
});

// POST /: draft filing from the yearly computation
app.post('/', requirePermission('taxes:create'), zValidator('json', createSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const created = await createFiling(db, { entityId, taxYear: data.taxYear, formType: data.formType, userId: c.get('userId') ?? null });
    const detail = await loadFilingDetail(db, entityId, created.filingId);
    await audit(c, entityId, created.filingId, 'created');
    publishEntityEvent({
      c,
      entityType: 'form_1099_filing',
      entityId: created.filingId,
      action: 'created',
      data: filingEventData(detail.filing, { lineCount: created.lineCount }),
    });
    return success(c, { ...detail, warnings: created.warnings }, 201);
  } catch (err) {
    return respondError(c, err, 'create the 1099 filing');
  }
});

// GET /:id
app.get('/:id', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    return success(c, await loadFilingDetail(db, entityId, c.req.param('id')));
  } catch (err) {
    return respondError(c, err, 'fetch the 1099 filing');
  }
});

// PATCH /:id: notes
app.patch('/:id', requirePermission('taxes:update'), zValidator('json', updateFilingSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const before = await loadFilingDetail(db, entityId, id);
    await db
      .update(schema.form1099Filings)
      .set({ notes: data.notes, updatedAt: new Date() })
      .where(eq(schema.form1099Filings.id, id));
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'updated', { notes: { old: before.filing.notes, new: data.notes } });
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'updated', data: filingEventData(detail.filing) });
    return success(c, detail);
  } catch (err) {
    return respondError(c, err, 'update the 1099 filing');
  }
});

// DELETE /:id: draft only
app.delete('/:id', requirePermission('taxes:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const filing = await deleteFiling(db, entityId, id);
    await audit(c, entityId, id, 'deleted');
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'deleted', data: filingEventData(filing) });
    return noContent(c);
  } catch (err) {
    return respondError(c, err, 'delete the 1099 filing');
  }
});

// POST /:id/refresh
app.post('/:id/refresh', requirePermission('taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const result = await refreshFiling(db, entityId, id);
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'refreshed');
    publishEntityEvent({
      c,
      entityType: 'form_1099_filing',
      entityId: id,
      action: 'updated',
      data: filingEventData(detail.filing, { refreshed: true, added: result.added }),
    });
    return success(c, { ...detail, refresh: result });
  } catch (err) {
    return respondError(c, err, 'refresh the 1099 filing');
  }
});

// PATCH /:id/lines/:lineId
app.patch('/:id/lines/:lineId', requirePermission('taxes:update'), zValidator('json', linePatchSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const data = c.req.valid('json');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const detail = await updateLine(db, entityId, id, lineId, data, c.get('userId') ?? null);
    await audit(c, entityId, id, 'line_updated', {
      [lineId]: {
        old: null,
        new: Object.keys(data).join(','),
      },
    });
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'updated', data: filingEventData(detail.filing, { lineUpdated: lineId }) });
    return success(c, detail);
  } catch (err) {
    return respondError(c, err, 'update the filing line');
  }
});

// POST /:id/review
app.post('/:id/review', requirePermission('taxes:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const result = await reviewFiling(db, entityId, id);
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'reviewed');
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'updated', data: filingEventData(detail.filing) });
    return success(c, { ...detail, unresolved: result.unresolved });
  } catch (err) {
    return respondError(c, err, 'review the 1099 filing');
  }
});

// POST /:id/generate: snapshot the recipients and copy their TINs in, encrypted
app.post('/:id/generate', requirePermission('taxes:file'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const result = await generateFiling(db, c.env, entityId, id);
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'generated');
    publishEntityEvent({
      c,
      entityType: 'form_1099_filing',
      entityId: id,
      action: 'generated',
      data: filingEventData(detail.filing, { lineCount: result.lineCount }),
    });
    return success(c, detail);
  } catch (err) {
    return respondError(c, err, 'generate the 1099 filing');
  }
});

// GET|POST /:id/iris-csv: the IRIS upload files. The only response with full TINs; one reveal row per recipient.
async function irisCsv(c: AppContext, templateHeaders: unknown) {
  const db = c.get('tenantDb');
  const id = c.req.param('id') ?? '';
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const result = await buildIrisFiles(db, c.env, {
      entityId,
      filingId: id,
      userId: userIdOf(c),
      templateHeaders: parseTemplateHeaders(templateHeaders),
    });
    const recordCount = result.files.reduce((sum, f) => sum + f.recordCount, 0);
    await audit(c, entityId, id, 'iris_file_created', { records: { old: null, new: recordCount } });
    c.header('Cache-Control', 'no-store');
    return success(c, result);
  } catch (err) {
    return respondError(c, err, 'create the IRIS file');
  }
}

app.get('/:id/iris-csv', requirePermission('taxes:file'), requirePermission('tax_ids:reveal'), (c) =>
  irisCsv(c, c.req.query('templateHeaders')),
);

app.post('/:id/iris-csv', requirePermission('taxes:file'), requirePermission('tax_ids:reveal'), async (c) => {
  const body = irisBodySchema.safeParse(await readOptionalJson(c));
  if (!body.success) return error.badRequest(c, 'Invalid request body', body.error.flatten());
  return irisCsv(c, body.data.templateHeaders ?? c.req.query('templateHeaders'));
});

// GET /:id/lines/:lineId/copies: layout data for the recipient copies (last four digits of the TIN only)
app.get('/:id/lines/:lineId/copies', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const result = await buildCopies(db, c.env, c, {
      entityId,
      filingId: c.req.param('id'),
      lineId: c.req.param('lineId'),
      copies: parseCopies(c.req.query('copies')),
      userId: userIdOf(c),
    });
    c.header('Cache-Control', 'no-store');
    return success(c, result);
  } catch (err) {
    return respondError(c, err, 'build the form copies');
  }
});

// POST /:id/mark-filed
app.post('/:id/mark-filed', requirePermission('taxes:file'), zValidator('json', markFiledSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    await markFiled(db, entityId, id, {
      confirmationNumber: data.confirmationNumber,
      filedAt: data.filedAt ? new Date(data.filedAt) : undefined,
    });
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'filed', { confirmationNumber: { old: null, new: data.confirmationNumber } });
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'filed', data: filingEventData(detail.filing, { confirmationNumber: data.confirmationNumber }) });
    return success(c, detail);
  } catch (err) {
    return respondError(c, err, 'mark the 1099 filing as filed');
  }
});

// POST /:id/lines/:lineId/correct
app.post('/:id/lines/:lineId/correct', requirePermission('taxes:file'), zValidator('json', correctSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const data = c.req.valid('json');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const created = await correctLine(db, c.env, entityId, id, lineId, data, c.get('userId') ?? null);
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'line_corrected', { [lineId]: { old: null, new: created.lineId } });
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'updated', data: filingEventData(detail.filing, { corrected: true }) });
    return success(c, { ...detail, correctionLineId: created.lineId }, 201);
  } catch (err) {
    return respondError(c, err, 'correct the filing line');
  }
});

// POST /:id/lines/:lineId/delivered: records that a copy went to the recipient. Sending the PDF by email is not done here.
app.post('/:id/lines/:lineId/delivered', requirePermission('taxes:update'), zValidator('json', deliveredSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const data = c.req.valid('json');
  try {
    const entityId = await entityOr400(c);
    if (typeof entityId !== 'string') return entityId;
    const result = await markLineDelivered(db, entityId, id, lineId, data.method);
    const detail = await loadFilingDetail(db, entityId, id);
    await audit(c, entityId, id, 'line_delivered', { [lineId]: { old: null, new: data.method } });
    publishEntityEvent({ c, entityType: 'form_1099_filing', entityId: id, action: 'updated', data: filingEventData(detail.filing, { delivered: lineId }) });
    return success(c, { ...result, ...detail });
  } catch (err) {
    return respondError(c, err, 'record the delivery');
  }
});

export const form1099FilingsRoutes = app;
export { respondError as respondForm1099Error };
