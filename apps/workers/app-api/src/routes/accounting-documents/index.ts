/**
 * Document routes — flat /api/accounting-documents/* surface backed by `documents`.
 *
 * Ported from apps/api-worker/src/routes/accounting/documents.ts (WeldBooks
 * document inbox: upload → OCR via Claude Sonnet through AI Gateway → vendor
 * match → link to bill/invoice/journal-entry or reject).
 *
 * Every state change on a document is written to the accounting audit log
 * (administratieplicht) in addition to the platform entity-event fan-out.
 *
 * Permissions: invoices:read | invoices:create | invoices:update | invoices:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { writeAccountingAudit } from '../../services/accounting-guards';
import {
  processDocumentOcr,
  matchVendorToContact,
  InsufficientCreditsError,
  OCR_MODEL_ID,
  type OcrResult,
} from '../../services/accounting-ocr';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.documents;

type DocumentRow = typeof t.$inferSelect;

const createDocumentSchema = z.object({
  type: z
    .enum(['purchase_invoice', 'receipt', 'bank_statement', 'contract', 'expense_report', 'other'])
    .optional(),
  fileName: z.string().min(1),
  originalFileName: z.string().optional(),
  fileKey: z.string().min(1),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
  source: z.enum(['upload', 'email', 'scan', 'api']).optional(),
  emailFrom: z.string().optional(),
  emailSubject: z.string().optional(),
  emailMessageId: z.string().optional(),
});

const linkDocumentSchema = z.object({
  linkedEntityType: z.enum(['bill', 'invoice', 'journal_entry', 'expense']),
  linkedEntityId: z.string().min(1),
});

// GET /
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const conditions = [isNull(t.deletedAt)];

    const statusFilter = c.req.query('status');
    if (statusFilter) conditions.push(eq(t.status, statusFilter));
    const typeFilter = c.req.query('type');
    if (typeFilter) conditions.push(eq(t.type, typeFilter));
    const sourceFilter = c.req.query('source');
    if (sourceFilter) conditions.push(eq(t.source, sourceFilter));

    const results = await db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.createdAt))
      .limit(100);
    return success(c, results);
  } catch (err) {
    console.error('[app-api/accounting-documents] list failed:', err);
    return error.internal(c, 'Failed to fetch documents');
  }
});

// GET /stats — counts per status (registered before /:id so 'stats' never matches as an id)
app.get('/stats', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const stats = await db
      .select({
        status: t.status,
        count: sql<number>`count(*)::int`,
      })
      .from(t)
      .where(isNull(t.deletedAt))
      .groupBy(t.status);

    return success(c, stats);
  } catch (err) {
    console.error('[app-api/accounting-documents] stats failed:', err);
    return error.internal(c, 'Failed to fetch document stats');
  }
});

// POST / — create document record after R2 upload
app.post('/', requirePermission('invoices:create'), zValidator('json', createDocumentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');

  try {
    const newDoc = {
      id: generateId('doc'),
      type: data.type || 'purchase_invoice',
      fileName: data.fileName,
      originalFileName: data.originalFileName || null,
      fileKey: data.fileKey,
      fileSize: data.fileSize || null,
      mimeType: data.mimeType || null,
      source: data.source || 'upload',
      status: 'pending' as const,
      emailFrom: data.emailFrom || null,
      emailSubject: data.emailSubject || null,
      emailMessageId: data.emailMessageId || null,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await db.insert(t).values(newDoc);

    publishEntityEvent({
      c,
      entityType: 'accounting_document',
      entityId: newDoc.id,
      action: 'created',
      data: newDoc as unknown as Record<string, unknown>,
    });

    return success(c, newDoc, 201);
  } catch (err) {
    console.error('[app-api/accounting-documents] create failed:', err);
    return error.internal(c, 'Failed to create document');
  }
});

// GET /:id
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [doc] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!doc) return error.notFound(c, 'Document', id);
    return success(c, doc);
  } catch (err) {
    console.error('[app-api/accounting-documents] get failed:', err);
    return error.internal(c, 'Failed to fetch document');
  }
});

// POST /:id/process — trigger OCR processing via Claude through AI Gateway
app.post('/:id/process', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  // workspaceId here is the Clerk orgId — that is what the OCR credit
  // tracking (weldagent_usage + credit consume) keys on, matching the
  // legacy api-worker semantics.
  const workspaceId = c.get('workspaceId');
  const userId = c.get('userId');
  if (!workspaceId || !userId) return error.unauthorized(c);

  try {
    const id = c.req.param('id');
    const [doc] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!doc) return error.notFound(c, 'Document', id);

    // Mark as processing
    await db.update(t).set({ status: 'processing', updatedAt: new Date() }).where(eq(t.id, id));

    try {
      const ocrResult = await processDocumentOcr(c.env, {
        fileKey: doc.fileKey,
        mimeType: doc.mimeType,
        workspaceId,
        userId,
        documentId: id,
        tenantDb: db,
      });

      const matchedContactId = await matchVendorToContact(db, schema, ocrResult);

      await db.update(t).set({
        status: 'processed',
        ocrResult: ocrResult as unknown as DocumentRow['ocrResult'],
        ocrProcessedAt: new Date(),
        ocrModel: OCR_MODEL_ID,
        matchedContactId,
        updatedAt: new Date(),
      }).where(eq(t.id, id));

      await writeAccountingAudit(c, db, {
        accountingEntityId: doc.entityId,
        entityType: 'accounting_document',
        entityId: id,
        action: 'processed',
        changes: {
          status: { old: doc.status, new: 'processed' },
          matchedContactId: { old: doc.matchedContactId, new: matchedContactId },
        },
      });
      publishEntityEvent({
        c,
        entityType: 'accounting_document',
        entityId: id,
        action: 'updated',
        data: { id, status: 'processed', matchedContactId },
      });

      return success(c, { id, status: 'processed', ocrResult, matchedContactId });
    } catch (ocrErr) {
      await db.update(t).set({ status: 'failed', updatedAt: new Date() }).where(eq(t.id, id));

      if (ocrErr instanceof InsufficientCreditsError) {
        return error.insufficientCredits(c, { currentBalance: ocrErr.currentBalance });
      }
      const message = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
      return error.internal(c, `OCR processing failed: ${message}`);
    }
  } catch (err) {
    console.error('[app-api/accounting-documents] process failed:', err);
    return error.internal(c, 'Failed to process document');
  }
});

// POST /:id/rematch — re-run vendor matching after a new supplier is created
app.post('/:id/rematch', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const id = c.req.param('id');
    const [doc] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!doc) return error.notFound(c, 'Document', id);
    if (!doc.ocrResult) return error.badRequest(c, 'Document has no OCR result to match against');

    const matchedContactId = await matchVendorToContact(db, schema, doc.ocrResult as unknown as OcrResult);

    await db.update(t).set({ matchedContactId, updatedAt: new Date() }).where(eq(t.id, id));
    return success(c, { id, matchedContactId });
  } catch (err) {
    console.error('[app-api/accounting-documents] rematch failed:', err);
    return error.internal(c, 'Failed to rematch document');
  }
});

// POST /:id/create-bill — create bill from OCR result
app.post('/:id/create-bill', requirePermission('invoices:create'), async (c) => {
  // Redirect to bills/from-document/:documentId (no mutation happens here).
  return error.badRequest(c, 'Use POST /api/bills/from-document/:documentId instead');
});

// PATCH /:id/link
app.patch('/:id/link', requirePermission('invoices:update'), zValidator('json', linkDocumentSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [doc] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!doc) return error.notFound(c, 'Document', id);

    await db.update(t).set({
      linkedEntityType: data.linkedEntityType,
      linkedEntityId: data.linkedEntityId,
      status: 'linked',
      updatedAt: new Date(),
    }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: doc.entityId,
      entityType: 'accounting_document',
      entityId: id,
      action: 'linked',
      changes: {
        status: { old: doc.status, new: 'linked' },
        linkedEntityType: { old: doc.linkedEntityType, new: data.linkedEntityType },
        linkedEntityId: { old: doc.linkedEntityId, new: data.linkedEntityId },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_document',
      entityId: id,
      action: 'updated',
      data: { id, status: 'linked', linkedEntityType: data.linkedEntityType, linkedEntityId: data.linkedEntityId },
    });

    return success(c, { id, status: 'linked' });
  } catch (err) {
    console.error('[app-api/accounting-documents] link failed:', err);
    return error.internal(c, 'Failed to link document');
  }
});

// PATCH /:id/reject
app.patch('/:id/reject', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [doc] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!doc) return error.notFound(c, 'Document', id);

    await db.update(t).set({ status: 'rejected', updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: doc.entityId,
      entityType: 'accounting_document',
      entityId: id,
      action: 'rejected',
      changes: { status: { old: doc.status, new: 'rejected' } },
    });
    publishEntityEvent({
      c,
      entityType: 'accounting_document',
      entityId: id,
      action: 'updated',
      data: { id, status: 'rejected' },
    });

    return success(c, { message: 'Document rejected' });
  } catch (err) {
    console.error('[app-api/accounting-documents] reject failed:', err);
    return error.internal(c, 'Failed to reject document');
  }
});

// DELETE /:id — soft delete (app-api addition; legacy had no document delete)
app.delete('/:id', requirePermission('invoices:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(and(eq(t.id, id), isNull(t.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Document', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'accounting_document',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'accounting_document', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/accounting-documents] delete failed:', err);
    return error.internal(c, 'Failed to delete document');
  }
});

export const accountingDocumentsRoutes = app;
