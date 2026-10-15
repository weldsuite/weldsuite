/**
 * NF-e received from suppliers: /api/received-fiscal-documents.
 *
 *   POST /sync               fetch what Focus NFe received for the entity's CNPJ since the last sync
 *   POST /upload             { xml } or multipart (file field "file" or "xml"): add an NF-e from its XML
 *   GET  /                   list, ?status=new|imported|ignored &search= &page= &pageSize=
 *   GET  /:id                one note with its parsed items (and the XML)
 *   POST /:id/manifest       { type: ciencia|confirmacao|desconhecimento|nao_realizada, reason? }
 *   POST /:id/create-bill    { contactId?, expenseAccountId?, dueDate? } draft bill from the note
 *   POST /:id/ignore         mark the note as not needed
 *
 * Reading needs bills:read, everything else bills:create (fetching, adding,
 * turning into a bill, ignoring) or bills:update (manifestação). Every change is
 * written to the accounting audit log and published as a
 * `received_fiscal_document` entity event.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { FiscalDocumentError, fiscalErrorResponse } from '../../services/br-fiscal/errors';
import { requireFiscalEntity } from '../../services/br-fiscal/fiscal-documents';
import {
  createBillFromReceived,
  getReceivedFiscalDocument,
  ignoreReceivedDocument,
  importNfeXml,
  manifestReceivedDocument,
  MANIFESTATION_TYPES,
  MAX_NFE_XML_BYTES,
  receivedEventData,
  syncReceivedFiscalDocuments,
  type ReceivedFiscalDocumentRow,
} from '../../services/br-fiscal/received';
import { ClosedPeriodError, LockedPeriodError } from '@weldsuite/books-domain/accounting-guards';
import { TaxCalculationError } from '../../services/accounting-tax-resolve';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type EntityRow = typeof schema.entities.$inferSelect;

const uploadSchema = z.object({ xml: z.string().min(1) });

const manifestSchema = z
  .object({
    type: z.enum(MANIFESTATION_TYPES),
    /** Required for nao_realizada (15 to 255 characters). */
    reason: z.string().trim().min(15).max(255).optional(),
  })
  .refine((v) => v.type !== 'nao_realizada' || Boolean(v.reason), { message: 'A reason of 15 to 255 characters is required when the operation was not carried out', path: ['reason'] });

const createBillSchema = z.object({
  contactId: z.string().min(1).max(30).optional(),
  expenseAccountId: z.string().max(30).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date as YYYY-MM-DD').optional(),
});

async function requireEntity(c: AppContext, db: Database): Promise<EntityRow> {
  const entityId = await resolveEntityId(c, db);
  if (!entityId) {
    throw new FiscalDocumentError('No accounting entity resolved. Set X-Accounting-Entity-Id or configure a default entity.');
  }
  return requireFiscalEntity(db, entityId);
}

/** The list view leaves out the XML and the parsed items (they can be large); the detail view has them. */
function receivedSummary(doc: ReceivedFiscalDocumentRow) {
  const { xml: _xml, parsed, ...rest } = doc;
  const summary = (parsed as { summary?: Record<string, unknown> } | null)?.summary ?? null;
  return { ...rest, hasXml: Boolean(doc.xml), summary };
}

async function auditAndPublish(
  c: AppContext,
  db: Database,
  doc: ReceivedFiscalDocumentRow,
  action: 'created' | 'updated',
  auditAction: string,
  changes?: Record<string, { old: unknown; new: unknown }>,
) {
  await writeAccountingAudit(c, db, {
    accountingEntityId: doc.entityId,
    entityType: 'received_fiscal_document',
    entityId: doc.id,
    action: auditAction,
    changes,
  });
  publishEntityEvent({ c, entityType: 'received_fiscal_document', entityId: doc.id, action, data: receivedEventData(doc) });
}

// GET / — list
app.get('/', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  const { receivedFiscalDocuments: received } = schema;
  const page = Math.max(Number.parseInt(c.req.query('page') || '1', 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(c.req.query('pageSize') || '25', 10) || 25, 1), 100);
  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list: not an error.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const conditions: SQL[] = [eq(received.entityId, entityId)];
    const status = c.req.query('status');
    if (status) conditions.push(eq(received.status, status));
    const search = c.req.query('search');
    if (search) {
      const term = `%${search}%`;
      conditions.push(or(like(received.issuerName, term), like(received.number, term), like(received.accessKey, term), like(received.issuerTaxId, term))!);
    }
    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(received).where(where).orderBy(desc(received.issueDate), desc(received.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(received).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows.map(receivedSummary), cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[books-api/received-fiscal-documents] list failed:', err);
    return error.internal(c, 'Failed to fetch received NF-e');
  }
});

// POST /sync
app.post('/sync', requirePermission('bills:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireEntity(c, db);
    const result = await syncReceivedFiscalDocuments(db, c.env, entity.id);
    await writeAccountingAudit(c, db, {
      accountingEntityId: entity.id,
      entityType: 'received_fiscal_document',
      entityId: entity.id,
      action: 'synced',
      changes: { created: { old: null, new: result.created }, updated: { old: null, new: result.updated } },
    });
    return success(c, result);
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/received-fiscal-documents] sync failed:', err);
    return error.internal(c, 'Failed to fetch received NF-e');
  }
});

/** The XML text of an upload: JSON { xml }, or the "file" / "xml" part of a multipart form. */
async function readUploadedXml(c: AppContext): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? 0);
  // A little room over the XML itself for the multipart envelope.
  if (declared > MAX_NFE_XML_BYTES + 4096) throw new FiscalDocumentError('The XML file is too large');
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const part = form.get('file') ?? form.get('xml');
    if (part === null) throw new FiscalDocumentError('Send the NF-e XML in the "file" field');
    if (typeof part === 'string') return part;
    // An uploaded file: the form-data typings of the build only know the string case.
    return (part as unknown as Blob).text();
  }
  const parsed = uploadSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new FiscalDocumentError('Send { "xml": "<NF-e XML>" } or a multipart form with the file');
  return parsed.data.xml;
}

// POST /upload
app.post('/upload', requirePermission('bills:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireEntity(c, db);
    const xml = await readUploadedXml(c);
    const { row, created } = await importNfeXml(db, entity.id, xml);
    await auditAndPublish(c, db, row, created ? 'created' : 'updated', created ? 'uploaded' : 'reuploaded');
    return success(c, receivedSummary(row), created ? 201 : 200);
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/received-fiscal-documents] upload failed:', err);
    return error.internal(c, 'Failed to read the NF-e');
  }
});

// GET /:id
app.get('/:id', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.notFound(c, 'Received fiscal document', c.req.param('id'));
    return success(c, await getReceivedFiscalDocument(db, entityId, c.req.param('id')));
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/received-fiscal-documents] get failed:', err);
    return error.internal(c, 'Failed to fetch the received NF-e');
  }
});

// POST /:id/manifest
app.post('/:id/manifest', requirePermission('bills:update'), zValidator('json', manifestSchema), async (c) => {
  const db = c.get('tenantDb');
  const { type, reason } = c.req.valid('json');
  try {
    const entity = await requireEntity(c, db);
    const doc = await getReceivedFiscalDocument(db, entity.id, c.req.param('id'));
    const saved = await manifestReceivedDocument(db, c.env, doc, type, reason);
    await auditAndPublish(c, db, saved, 'updated', 'manifested', { manifestation: { old: doc.manifestation, new: type } });
    return success(c, receivedSummary(saved));
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/received-fiscal-documents] manifest failed:', err);
    return error.internal(c, 'Failed to send the manifestation');
  }
});

// POST /:id/create-bill
app.post('/:id/create-bill', requirePermission('bills:create'), zValidator('json', createBillSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  try {
    const entity = await requireEntity(c, db);
    const doc = await getReceivedFiscalDocument(db, entity.id, c.req.param('id'));
    const { bill, document, warnings } = await createBillFromReceived(db, c.env, entity, doc, { ...data, userId: c.get('userId') });

    await writeAccountingAudit(c, db, { accountingEntityId: entity.id, entityType: 'bill', entityId: bill.id, action: 'created' });
    publishEntityEvent({
      c,
      entityType: 'bill',
      entityId: bill.id,
      action: 'created',
      data: {
        id: bill.id,
        billNumber: bill.billNumber,
        status: 'draft',
        total: bill.total,
        currency: bill.currency,
        contactId: bill.contactId,
        issueDate: bill.issueDate.toISOString(),
        dueDate: bill.dueDate.toISOString(),
      },
    });
    await auditAndPublish(c, db, document, 'updated', 'imported', { status: { old: doc.status, new: document.status } });
    return success(c, { bill, document: receivedSummary(document), warnings }, 201);
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    if (err instanceof ClosedPeriodError || err instanceof LockedPeriodError || err instanceof TaxCalculationError) {
      return error.badRequest(c, err.message);
    }
    console.error('[books-api/received-fiscal-documents] create bill failed:', err);
    return error.internal(c, 'Failed to create the bill');
  }
});

// POST /:id/ignore
app.post('/:id/ignore', requirePermission('bills:create'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entity = await requireEntity(c, db);
    const doc = await getReceivedFiscalDocument(db, entity.id, c.req.param('id'));
    const saved = await ignoreReceivedDocument(db, doc);
    await auditAndPublish(c, db, saved, 'updated', 'ignored', { status: { old: doc.status, new: saved.status } });
    return success(c, receivedSummary(saved));
  } catch (err) {
    const handled = fiscalErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/received-fiscal-documents] ignore failed:', err);
    return error.internal(c, 'Failed to ignore the NF-e');
  }
});

export const receivedFiscalDocumentsRoutes = app;
