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
 *   - Approving a bill posts it (Dr expense + deductible input tax / Cr
 *     payable) in one atomic posting, refused inside closed periods and on or
 *     before the purchase lock date. Rejecting an approved bill reverses it.
 *   - US bills: sales tax the vendor charged is part of each line's cost; a
 *     line marked "accrue use tax" accrues use tax at the delivery address
 *     (Dr the line's account / Cr Use Tax Payable), recalculated on approval.
 *   - Only drafts may be edited or deleted.
 *   - Every mutation is written to the accounting audit log.
 *
 * Permissions: bills:read | bills:create | bills:update | bills:delete.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { nextEntityNumber, resolveEntityBaseCurrency, resolveEntityId } from '../../lib/entity-context';
import {
  ClosedPeriodError,
  LockedPeriodError,
  writeAccountingAudit,
} from '@weldsuite/books-domain/accounting-guards';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { calculateDocumentTax, TaxCalculationError, type DocumentTaxItem } from '../../services/accounting-tax-resolve';
import { postBill, PostingError } from '../../services/accounting-document-posting';
import { assertDimensionsBelongToEntity, reverseJournalEntry } from '../../services/accounting-posting';
import { salesTaxErrorResponse } from '../../services/sales-tax/errors';
import { loadSalesTaxEntity, usesSalesTax } from '../../services/sales-tax/document-tax';
import {
  billDocumentContext,
  billItemToTaxItem,
  hasUseTaxLines,
  refreshBillUseTax,
} from '../../services/sales-tax/bill-tax';
import { salesTaxRuntimeFromEnv } from '../../services/sales-tax/runtime';
import { lineItemsForBill, normalizeOcrResult } from '../../services/accounting-ocr';
import { streamDocumentAttachment } from '../../lib/document-attachment';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** 400 for errors the user can fix (closed period, lock date, posting rules, tax rates). */
function accountingErrorResponse(c: Context<{ Bindings: Env; Variables: Variables }>, err: unknown): Response | undefined {
  // Sales tax refusals carry their own code (TAX_ENGINE_UNAVAILABLE, TAX_RATES_NOT_CONFIGURED, ...).
  const salesTax = salesTaxErrorResponse(c, err);
  if (salesTax) return salesTax;
  if (
    err instanceof ClosedPeriodError ||
    err instanceof LockedPeriodError ||
    err instanceof PostingError ||
    err instanceof TaxCalculationError
  ) {
    return error.badRequest(c, err.message);
  }
  return undefined;
}

/** Accepts the shared address shape and the legacy Dutch one (street + houseNumber, province). */
const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  county: z.string().optional(),
  street: z.string().optional(),
  houseNumber: z.string().optional(),
  province: z.string().optional(),
});

const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.string().optional().default('1'),
  unitPrice: z.string(),
  unit: z.string().max(20).optional(),
  discountPercent: z.string().optional().default('0'),
  taxRateId: z.string().max(30).nullable().optional(),
  taxRate: z.string().optional(),
  accountId: z.string().max(30).nullable().optional(),
  sortOrder: z.number().optional(),
  productId: z.string().max(30).nullable().optional(),
  // US: the product tax code (for use tax), accrue use tax when the vendor charged none, 1099 box, dimensions.
  taxCode: z.string().max(30).nullable().optional(),
  accrueUseTax: z.boolean().optional(),
  form1099Box: z.string().max(20).nullable().optional(),
  classId: z.string().max(30).nullable().optional(),
  locationId: z.string().max(30).nullable().optional(),
});

type BillLineInput = z.infer<typeof lineItemSchema>;

/** Bill line rows with the server-calculated tax for each line. */
function buildBillItemRecords(
  entityId: string,
  billId: string,
  itemIds: string[],
  items: BillLineInput[],
  processedItems: Array<{ taxAmount: string; lineTotal: string; lineTotalWithTax: string; taxRateId: string | null; taxRate: string | null }>,
) {
  const now = new Date();
  return items.map((item, idx) => ({
    id: itemIds[idx],
    entityId,
    billId,
    description: item.description,
    quantity: item.quantity || '1',
    unitPrice: item.unitPrice,
    unit: item.unit || null,
    discountPercent: item.discountPercent || '0',
    taxRateId: processedItems[idx].taxRateId,
    taxRate: processedItems[idx].taxRate,
    taxAmount: processedItems[idx].taxAmount,
    lineTotal: processedItems[idx].lineTotal,
    lineTotalWithTax: processedItems[idx].lineTotalWithTax,
    accountId: item.accountId || null,
    productId: item.productId || null,
    sortOrder: item.sortOrder ?? idx,
    taxCode: item.taxCode || null,
    accrueUseTax: item.accrueUseTax ?? false,
    form1099Box: item.form1099Box || null,
    classId: item.classId || null,
    locationId: item.locationId || null,
    createdAt: now,
    updatedAt: now,
  }));
}

/** Line ids first: the use tax rows of the breakdown refer to them. */
function withLineIds(items: BillLineInput[]): { itemIds: string[]; taxItems: DocumentTaxItem[] } {
  const itemIds = items.map(() => generateId('bli'));
  return { itemIds, taxItems: items.map((item, idx) => ({ ...item, id: itemIds[idx], sortOrder: item.sortOrder ?? idx })) };
}

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
  vendorAddress: addressSchema.nullable().optional(),
  /** US: where the goods were delivered; sets the use tax rate. Defaults to the entity's address. */
  deliveryAddress: addressSchema.nullable().optional(),
  sourceDocumentId: z.string().max(30).optional(),
  items: z.array(lineItemSchema).default([]),
});

const updateBillSchema = createBillSchema.partial();

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
  const page = Math.max(Number.parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(Number.parseInt(q.pageSize || '25', 10), 1), 100);

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

// GET /:id/attachments/:index — stream a synced Moneybird (or other) file from R2
app.get('/:id/attachments/:index', requirePermission('bills:read'), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const billId = c.req.param('id');
  const index = Number(c.req.param('index'));

  try {
    const [bill] = await db
      .select({ attachmentKeys: bills.attachmentKeys })
      .from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt)))
      .limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);

    return streamDocumentAttachment(c, {
      attachmentKeys: bill.attachmentKeys,
      index,
      workspaceId: c.get('workspaceId') || c.get('orgId'),
    });
  } catch (err) {
    console.error('[app-api/bills] attachment download failed:', err);
    return error.internal(c, 'Failed to download attachment');
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
    const currency = data.currency || (await resolveEntityBaseCurrency(db, entityId));

    const billId = generateId('bil');
    const { itemIds, taxItems } = withLineIds(data.items);
    await assertDimensionsBelongToEntity(db, entityId, data.items);
    const deliveryAddress = normalizePostalAddress(data.deliveryAddress);
    const vendorAddress = normalizePostalAddress(data.vendorAddress);
    const totals = await calculateDocumentTax(db, {
      entityId,
      direction: 'purchase',
      items: taxItems,
      runtime: salesTaxRuntimeFromEnv(c.env),
      document: {
        kind: 'bill',
        documentId: billId,
        documentNumber: billNumber,
        contactId: data.contactId,
        issueDate: new Date(data.issueDate),
        currency,
        billingAddress: vendorAddress,
        deliveryAddress,
      },
    });
    const { processedItems, taxBreakdown, salesTax: _salesTax, ...billTotals } = totals;

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
      currency,
      ...billTotals,
      taxBreakdown,
      amountPaid: '0',
      externalReference: data.externalReference || null,
      reference: data.reference || null,
      notes: data.notes || null,
      internalNotes: data.internalNotes || null,
      expenseAccountId: data.expenseAccountId || null,
      vendorAddress,
      deliveryAddress,
      sourceDocumentId: data.sourceDocumentId || null,
      approvalStatus: 'pending' as const,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(bills).values(newBill);

    const itemRecords = buildBillItemRecords(entityId, billId, itemIds, data.items, processedItems);

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
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
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

    const ocr = normalizeOcrResult(doc.ocrResult as Record<string, unknown>);

    // Return pre-filled bill data for the frontend to review before creating
    return success(c, {
      contactName: ocr.vendor.name || null,
      externalReference: ocr.invoiceNumber || null,
      issueDate: ocr.invoiceDate || null,
      dueDate: ocr.dueDate || null,
      currency: ocr.currency || null,
      items: lineItemsForBill(ocr),
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

// PATCH /:id/approve — approve and post the bill
app.patch('/:id/approve', requirePermission('bills:update'), async (c) => {
  const db = c.get('tenantDb');
  const { bills, billItems } = schema;
  const billId = c.req.param('id');
  const userId = c.get('userId') ?? null;

  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);
    if (bill.journalEntryId) {
      // Already approved and posted — approving again is a no-op.
      return success(c, bill);
    }
    if (bill.status === 'cancelled' || bill.approvalStatus === 'rejected') {
      return error.badRequest(c, 'A rejected bill cannot be approved. Create a new bill instead.');
    }

    const items = await db.select().from(billItems)
      .where(and(eq(billItems.billId, billId), isNull(billItems.deletedAt)));

    // US: the use tax that posts is the engine's answer for what is saved now (an engine that can't answer refuses).
    const ready = await refreshBillUseTax(db, bill, items, salesTaxRuntimeFromEnv(c.env));
    const posted = await postBill(db, ready, items, { userId });

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'approved',
      changes: {
        approvalStatus: { old: bill.approvalStatus, new: 'approved' },
        status: { old: bill.status, new: 'approved' },
        journalEntryId: { old: null, new: posted.journalEntryId },
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
    if (posted.journalEntryId && !posted.alreadyPosted) {
      publishEntityEvent({
        c,
        entityType: 'journal_entry',
        entityId: posted.journalEntryId,
        action: 'created',
        data: { id: posted.journalEntryId, sourceType: 'bill', sourceId: billId },
      });
    }

    return success(c, {
      ...bill,
      approvalStatus: 'approved',
      status: 'approved',
      approvedBy: userId,
      journalEntryId: posted.journalEntryId,
    });
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/bills] approve failed:', err);
    return error.internal(c, 'Failed to approve bill');
  }
});

// PATCH /:id/reject — reject a bill; an approved (posted) one is reversed
app.patch('/:id/reject', requirePermission('bills:update'), zValidator('json', z.object({ reason: z.string().min(1) })), async (c) => {
  const db = c.get('tenantDb');
  const { bills } = schema;
  const billId = c.req.param('id');
  const { reason } = c.req.valid('json');
  const userId = c.get('userId') ?? null;

  try {
    const [bill] = await db.select().from(bills)
      .where(and(eq(bills.id, billId), isNull(bills.deletedAt))).limit(1);
    if (!bill) return error.notFound(c, 'Bill', billId);
    if (Number.parseFloat(bill.amountPaid ?? '0') > 0) {
      return error.badRequest(c, 'This bill has payments. Void the payments before rejecting it.');
    }

    const now = new Date();
    const rejectedValues = {
      approvalStatus: 'rejected',
      status: 'cancelled',
      rejectedBy: userId,
      rejectedAt: now,
      rejectionReason: reason,
      updatedAt: now,
    };
    let reversalId: string | null = null;
    if (bill.journalEntryId) {
      const reversal = await reverseJournalEntry(db, {
        entryId: bill.journalEntryId,
        date: now,
        createdBy: userId,
        lockKind: 'purchase',
        description: `Rejected bill ${bill.billNumber ?? billId}`,
        alsoWrite: (h) => [h.update(bills).set(rejectedValues).where(eq(bills.id, billId))],
      });
      reversalId = reversal.journalEntryId;
    } else {
      await db.update(bills).set(rejectedValues).where(eq(bills.id, billId));
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'rejected',
      changes: {
        approvalStatus: { old: bill.approvalStatus, new: 'rejected' },
        status: { old: bill.status, new: 'cancelled' },
        rejectionReason: { old: bill.rejectionReason, new: reason },
        ...(reversalId ? { reversalEntryId: { old: null, new: reversalId } } : {}),
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
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/bills] reject failed:', err);
    return error.internal(c, 'Failed to reject bill');
  }
});

// PUT /:id (PATCH alias kept for app-api clients) — drafts only
app.on(['PUT', 'PATCH'], '/:id', requirePermission('bills:update'), zValidator('json', updateBillSchema), async (c) => {
  const db = c.get('tenantDb');
  const { bills, billItems } = schema;
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
    if (data.currency) updateData.currency = data.currency;
    if (data.externalReference !== undefined) updateData.externalReference = data.externalReference;
    if (data.reference !== undefined) updateData.reference = data.reference;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.internalNotes !== undefined) updateData.internalNotes = data.internalNotes;
    if (data.expenseAccountId !== undefined) updateData.expenseAccountId = data.expenseAccountId || null;
    if (data.vendorAddress !== undefined) updateData.vendorAddress = normalizePostalAddress(data.vendorAddress);
    if (data.deliveryAddress !== undefined) updateData.deliveryAddress = normalizePostalAddress(data.deliveryAddress);

    let newItems: ReturnType<typeof buildBillItemRecords> | undefined;
    if (data.items) {
      const { itemIds, taxItems } = withLineIds(data.items);
      await assertDimensionsBelongToEntity(db, bill.entityId, data.items);
      const effective = { ...bill, ...updateData } as typeof bill;
      const { processedItems, taxBreakdown, salesTax: _salesTax, ...billTotals } = await calculateDocumentTax(db, {
        entityId: bill.entityId,
        direction: 'purchase',
        items: taxItems,
        runtime: salesTaxRuntimeFromEnv(c.env),
        document: billDocumentContext(effective),
      });
      Object.assign(updateData, billTotals, {
        taxBreakdown,
        balanceDue: String(Number.parseFloat(billTotals.total) - Number.parseFloat(bill.amountPaid || '0')),
      });
      newItems = buildBillItemRecords(bill.entityId, billId, itemIds, data.items, processedItems);
    } else if (
      (data.deliveryAddress !== undefined || data.issueDate !== undefined || data.contactId !== undefined) &&
      usesSalesTax(await loadSalesTaxEntity(db, bill.entityId))
    ) {
      // The use tax rate follows the delivery address and the date: re-tax the saved lines.
      const stored = await db
        .select()
        .from(billItems)
        .where(and(eq(billItems.billId, billId), isNull(billItems.deletedAt)));
      if (hasUseTaxLines(stored)) {
        const effective = { ...bill, ...updateData } as typeof bill;
        const calc = await calculateDocumentTax(db, {
          entityId: bill.entityId,
          direction: 'purchase',
          items: stored.map(billItemToTaxItem),
          runtime: salesTaxRuntimeFromEnv(c.env),
          document: billDocumentContext(effective),
        });
        updateData.taxBreakdown = calc.taxBreakdown;
      }
    }

    const now = new Date();
    await atomically(db, (h) => [
      h.update(bills).set(updateData).where(eq(bills.id, billId)),
      ...(newItems
        ? [
            h.update(billItems).set({ deletedAt: now }).where(and(eq(billItems.billId, billId), isNull(billItems.deletedAt))),
            ...(newItems.length > 0 ? [h.insert(billItems).values(newItems)] : []),
          ]
        : []),
    ]);

    await writeAccountingAudit(c, db, {
      accountingEntityId: bill.entityId,
      entityType: 'bill',
      entityId: billId,
      action: 'updated',
      changes: Object.fromEntries(
        Object.entries(updateData)
          .filter(([k]) => k !== 'updatedAt' && k !== 'taxBreakdown')
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
        total: (updateData.total as string | undefined) ?? bill.total ?? '0',
        currency: (updateData.currency as string | undefined) ?? bill.currency,
        contactId: data.contactId ?? bill.contactId,
      },
    });

    return success(c, { ...bill, ...updateData, ...(newItems ? { items: newItems } : {}) });
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/bills] update failed:', err);
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
