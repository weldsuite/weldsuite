/**
 * Bill routes — flat /api/bills/* surface backed by `bills`.
 *
 * Ported from apps/api-worker/src/routes/accounting/bills.ts:
 *   - Entity scoping via resolveEntityId (header/query/default).
 *   - Gapless bill numbering via nextEntityNumber(db, entityId, 'bill').
 *   - Approval workflow (PATCH /:id/approve | /:id/reject).
 *   - OCR document linking (sourceDocumentId + POST /from-document/:documentId).
 *   - Supplier role promotion on first bill for a contact.
 *
 * Integrity rules (administratieplicht — do not weaken):
 *   - Approving a bill is blocked inside closed fiscal periods.
 *   - Every mutation is written to the accounting audit log.
 *
 * Permissions: bills:read | bills:create | bills:update | bills:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';
import { nextEntityNumber, resolveEntityId } from '../../lib/entity-context';
import {
  assertPeriodOpen,
  ClosedPeriodError,
  writeAccountingAudit,
} from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.string().optional().default('1'),
  unitPrice: z.string(),
  unit: z.string().max(20).optional(),
  discountPercent: z.string().optional().default('0'),
  taxRateId: z.string().max(30).optional(),
  taxRate: z.string().optional(),
  accountId: z.string().max(30).optional(),
  sortOrder: z.number().optional(),
});

const createBillSchema = z.object({
  /** Optional explicit entity — falls back to header/query/default resolution. */
  entityId: z.string().max(30).optional(),
  /** Optional explicit number (e.g. supplier's) — falls back to the entity sequence. */
  billNumber: z.string().max(50).optional(),
  contactId: z.string().min(1),
  contactName: z.string().optional(),
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string().length(3).optional(),
  externalReference: z.string().max(255).optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  expenseAccountId: z.string().max(30).optional(),
  sourceDocumentId: z.string().max(30).optional(),
  items: z.array(lineItemSchema).default([]),
});

const updateBillSchema = createBillSchema.partial();

function calculateBillTotals(
  items: Array<{ quantity: string; unitPrice: string; discountPercent: string; taxRate?: string | null }>,
) {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;

  const processedItems = items.map((item) => {
    const qty = parseFloat(item.quantity) || 1;
    const price = parseFloat(item.unitPrice) || 0;
    const discount = parseFloat(item.discountPercent) || 0;
    const rate = parseFloat(item.taxRate || '0');
    const lineGross = qty * price;
    const lineDiscount = lineGross * (discount / 100);
    const lineTotal = lineGross - lineDiscount;
    const lineTax = lineTotal * (rate / 100);
    subtotal += lineTotal;
    discountTotal += lineDiscount;
    taxTotal += lineTax;
    return {
      lineTotal: lineTotal.toFixed(2),
      lineTotalWithTax: (lineTotal + lineTax).toFixed(2),
      taxAmount: lineTax.toFixed(2),
    };
  });

  const total = subtotal + taxTotal;
  return {
    subtotal: subtotal.toFixed(2),
    discountTotal: discountTotal.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    total: total.toFixed(2),
    balanceDue: total.toFixed(2),
    processedItems,
  };
}

/**
 * Auto-promote a contact's `role` when it gets its first bill.
 * Idempotent — the role only moves forward:
 *   none → supplier, customer → both, supplier/both → no-op.
 * (Inlined from api-worker's promote-role.ts.)
 */
async function promoteAccountingRole(
  db: Database,
  contactId: string,
  promoteTo: 'customer' | 'supplier',
): Promise<void> {
  const { parties } = schema;

  const [contact] = await db
    .select({ role: parties.role })
    .from(parties)
    .where(eq(parties.id, contactId))
    .limit(1);

  if (!contact) return;

  const current = contact.role ?? 'none';
  if (current === 'both' || current === promoteTo) return;

  const next = current === 'none' ? promoteTo : 'both';

  await db
    .update(parties)
    .set({ role: next, updatedAt: new Date() })
    .where(eq(parties.id, contactId));
}

// GET /
app.get('/', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const q = c.req.query();
  const page = Math.max(parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(q.pageSize || '25', 10), 1), 100);

  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list — not an error.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const conditions = [isNull(bills.deletedAt), eq(bills.entityId, entityId)];
    if (q.status) conditions.push(eq(bills.status, q.status));
    if (q.contactId) conditions.push(eq(bills.contactId, q.contactId));
    if (q.from) conditions.push(gte(bills.issueDate, new Date(q.from)));
    if (q.to) conditions.push(lte(bills.issueDate, new Date(q.to)));
    if (q.search) {
      const term = `%${q.search}%`;
      conditions.push(
        or(like(bills.billNumber, term), like(bills.contactName, term), like(bills.externalReference, term))!,
      );
    }

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(bills).where(where).orderBy(desc(bills.issueDate))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(bills).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/bills] list failed:', err);
    return error.internal(c, 'Failed to fetch bills');
  }
});

// GET /:id — includes items + payments
app.get('/:id', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bills, billItems, payments: paymentsTable } = schema;
  const billId = c.req.param('id');
  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);

    const items = await db.select().from(billItems)
      .where(and(eq(billItems.billId, billId), isNull(billItems.deletedAt)))
      .orderBy(billItems.sortOrder);
    const billPayments = await db.select().from(paymentsTable)
      .where(and(eq(paymentsTable.billId, billId), isNull(paymentsTable.deletedAt)))
      .orderBy(desc(paymentsTable.date));

    return success(c, { ...bill, items, payments: billPayments });
  } catch (err) {
    console.error('[app-api/bills] get failed:', err);
    return error.internal(c, 'Failed to fetch bill');
  }
});

// POST /
/** Surface missing/invalid fields by name — `error.message` names each offending path. */
const billValidationHook = (
  result: { success: boolean; error?: { issues: Array<{ path: Array<string | number>; message: string }> } },
  c: Parameters<typeof error.badRequest>[0],
) => {
  if (!result.success) {
    const message = (result.error?.issues ?? [])
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return error.badRequest(c, message || 'Invalid request body');
  }
};

app.post('/', requirePermission('bills:create'), zValidator('json', createBillSchema, billValidationHook as never), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const { bills, billItems } = schema;

  try {
    const entityId = data.entityId ?? (await resolveEntityId(c, db));
    if (!entityId) {
      return error.badRequest(c, 'No accounting entity resolved — set X-Accounting-Entity-Id or configure a default entity.');
    }
    const billNumber = data.billNumber ?? (await nextEntityNumber(db, entityId, 'bill')).formatted;

    const totals = calculateBillTotals(
      data.items.map((i) => ({
        quantity: i.quantity || '1',
        unitPrice: i.unitPrice,
        discountPercent: i.discountPercent || '0',
        taxRate: i.taxRate,
      })),
    );
    const { processedItems, ...billTotals } = totals;
    const billId = generateId('bil');

    const newBill = {
      id: billId,
      entityId,
      billNumber,
      type: 'standard' as const,
      status: 'draft' as const,
      contactId: data.contactId,
      contactName: data.contactName || null,
      issueDate: new Date(data.issueDate),
      dueDate: new Date(data.dueDate),
      currency: data.currency || 'EUR',
      ...billTotals,
      amountPaid: '0',
      externalReference: data.externalReference || null,
      reference: data.reference || null,
      notes: data.notes || null,
      internalNotes: data.internalNotes || null,
      expenseAccountId: data.expenseAccountId || null,
      sourceDocumentId: data.sourceDocumentId || null,
      approvalStatus: 'pending' as const,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(bills).values(newBill);

    const itemRecords = data.items.map((item, idx) => ({
      id: generateId('bli'),
      entityId,
      billId,
      description: item.description,
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice,
      unit: item.unit || null,
      discountPercent: item.discountPercent || '0',
      taxRateId: item.taxRateId || null,
      taxRate: item.taxRate || null,
      taxAmount: processedItems[idx].taxAmount,
      lineTotal: processedItems[idx].lineTotal,
      lineTotalWithTax: processedItems[idx].lineTotalWithTax,
      accountId: item.accountId || null,
      sortOrder: item.sortOrder ?? idx,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (itemRecords.length > 0) {
      await db.insert(billItems).values(itemRecords);
    }

    // Link source document (from OCR flow) to the newly created bill
    if (data.sourceDocumentId) {
      const { documents } = schema;
      await db.update(documents).set({
        status: 'linked',
        linkedEntityType: 'bill',
        linkedEntityId: billId,
        updatedAt: new Date(),
      }).where(eq(documents.id, data.sourceDocumentId));
    }

    // First bill flips role=none→supplier, or customer→both. No-op otherwise.
    await promoteAccountingRole(db, data.contactId, 'supplier');

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'bill',
      entityId: billId,
      action: 'created',
      data: {
        id: billId,
        billNumber,
        status: 'draft',
        total: newBill.total,
        currency: newBill.currency,
        contactId: data.contactId,
        issueDate: data.issueDate,
        dueDate: data.dueDate,
      },
    });

    return success(c, { ...newBill, items: itemRecords }, 201);
  } catch (err) {
    console.error('[app-api/bills] create failed:', err);
    return error.internal(c, 'Failed to create bill');
  }
});

// POST /from-document/:documentId — pre-fill bill data from a processed OCR document
app.post('/from-document/:documentId', requirePermission('bills:create'), async (c) => {
  const db = c.get('tenantDb');
  const documentId = c.req.param('documentId');

  try {
    const { documents } = schema;
    const [doc] = await db.select().from(documents)
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt))).limit(1);
    if (!doc) return error.notFound(c, 'Document', documentId);
    if (!doc.ocrResult) return error.badRequest(c, 'Document has not been processed yet');

    const ocr = doc.ocrResult;

    // Return pre-filled bill data for the frontend to review before creating
    return success(c, {
      contactName: ocr.vendor?.name || null,
      externalReference: ocr.invoiceNumber || null,
      issueDate: ocr.invoiceDate || null,
      dueDate: ocr.dueDate || null,
      currency: ocr.currency || 'EUR',
      items: (ocr.lineItems || []).map((li, idx) => ({
        description: li.description || '',
        quantity: String(li.quantity || 1),
        unitPrice: String(li.unitPrice || 0),
        taxRate: li.taxRate ? String(li.taxRate) : null,
        sortOrder: idx,
      })),
      subtotal: ocr.subtotal,
      taxTotal: ocr.totalTax,
      total: ocr.total,
      sourceDocumentId: documentId,
      matchedContactId: doc.matchedContactId,
      confidence: ocr.confidence,
    });
  } catch (err) {
    console.error('[app-api/bills] create from document failed:', err);
    return error.internal(c, 'Failed to create bill from document');
  }
});

// PATCH /:id/approve
app.patch('/:id/approve', requirePermission('bills:update'), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const billId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);

    // Approving books the expense — blocked inside closed fiscal periods.
    await assertPeriodOpen(db, bill.entityId, bill.issueDate ?? new Date());

    await db.update(bills).set({
      approvalStatus: 'approved',
      status: 'approved',
      approvedBy: userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(bills.id, billId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'approved',
      changes: {
        approvalStatus: { old: bill.approvalStatus, new: 'approved' },
        status: { old: bill.status, new: 'approved' },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'bill',
      entityId: billId,
      action: 'updated',
      data: {
        id: billId,
        billNumber: bill.billNumber,
        status: 'approved',
        total: bill.total || '0',
        currency: bill.currency,
        contactId: bill.contactId,
      },
    });

    return success(c, { ...bill, approvalStatus: 'approved', status: 'approved' });
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/bills] approve failed:', err);
    return error.internal(c, 'Failed to approve bill');
  }
});

// PATCH /:id/reject
app.patch('/:id/reject', requirePermission('bills:update'), zValidator('json', z.object({ reason: z.string().min(1) })), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const billId = c.req.param('id');
  const { reason } = c.req.valid('json');
  const userId = c.get('userId');

  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);

    await db.update(bills).set({
      approvalStatus: 'rejected',
      status: 'cancelled',
      rejectedBy: userId,
      rejectedAt: new Date(),
      rejectionReason: reason,
      updatedAt: new Date(),
    }).where(eq(bills.id, billId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'rejected',
      changes: {
        approvalStatus: { old: bill.approvalStatus, new: 'rejected' },
        status: { old: bill.status, new: 'cancelled' },
        rejectionReason: { old: bill.rejectionReason, new: reason },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'bill',
      entityId: billId,
      action: 'updated',
      data: {
        id: billId,
        billNumber: bill.billNumber,
        status: 'cancelled',
        total: bill.total || '0',
        currency: bill.currency,
        contactId: bill.contactId,
      },
    });

    return success(c, { ...bill, approvalStatus: 'rejected', status: 'cancelled' });
  } catch (err) {
    console.error('[app-api/bills] reject failed:', err);
    return error.internal(c, 'Failed to reject bill');
  }
});

// PUT /:id (PATCH alias kept for app-api clients) — drafts only
app.on(['PUT', 'PATCH'], '/:id', requirePermission('bills:update'), zValidator('json', updateBillSchema), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const billId = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);
    if (bill.status !== 'draft') return error.badRequest(c, 'Can only edit draft bills');

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (data.contactId) updateData.contactId = data.contactId;
    if (data.contactName !== undefined) updateData.contactName = data.contactName;
    if (data.issueDate) updateData.issueDate = new Date(data.issueDate);
    if (data.dueDate) updateData.dueDate = new Date(data.dueDate);
    if (data.externalReference !== undefined) updateData.externalReference = data.externalReference;
    if (data.reference !== undefined) updateData.reference = data.reference;
    if (data.notes !== undefined) updateData.notes = data.notes;

    await db.update(bills).set(updateData).where(eq(bills.id, billId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(updateData)
          .filter(([k]) => k !== 'updatedAt')
          .map(([k, v]) => [k, { old: (bill as Record<string, unknown>)[k], new: v }]),
      ),
    });
    publishEntityEvent({
      c,
      entityType: 'bill',
      entityId: billId,
      action: 'updated',
      data: {
        id: billId,
        billNumber: bill.billNumber,
        status: bill.status || 'draft',
        total: bill.total || '0',
        currency: bill.currency,
        contactId: data.contactId ?? bill.contactId,
      },
    });

    return success(c, { ...bill, ...updateData });
  } catch (err) {
    console.error('[app-api/bills] update failed:', err);
    return error.internal(c, 'Failed to update bill');
  }
});

// DELETE /:id — drafts only
app.delete('/:id', requirePermission('bills:delete'), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const billId = c.req.param('id');

  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);
    if (bill.status !== 'draft') return error.badRequest(c, 'Can only delete draft bills');

    await db.update(bills).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(bills.id, billId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'deleted',
    });
    publishEntityEvent({
      c,
      entityType: 'bill',
      entityId: billId,
      action: 'deleted',
      data: { id: billId, billNumber: bill.billNumber, status: bill.status || 'draft', total: bill.total || '0' },
    });

    return noContent(c);
  } catch (err) {
    console.error('[app-api/bills] delete failed:', err);
    return error.internal(c, 'Failed to delete bill');
  }
});

export const billsRoutes = app;
