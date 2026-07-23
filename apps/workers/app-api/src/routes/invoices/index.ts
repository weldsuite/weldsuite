/**
 * Invoice routes — flat /api/invoices/* surface backed by `invoices`.
 *
 * Full port of the legacy api-worker accounting/invoices route: entity-scoped
 * list/detail, line-item tax calculation on create/update, gapless sequence
 * numbers via entityNumberSequences, finalize (dual journal entry + account
 * balances), duplicate, credit note, payment recording, printable HTML, and
 * invoice-from-commerce-order.
 *
 * Integrity rules (administratieplicht — do not weaken):
 *   - Only draft invoices may be edited or deleted; finalized/sent invoices
 *     are immutable — corrections go through POST /:id/credit-note.
 *   - Finalize, credit-note, and record-payment are blocked inside closed
 *     fiscal periods (assertPeriodOpen).
 *   - Every mutation is written to the accounting audit log.
 *
 * Permissions: invoices:read | invoices:create | invoices:update | invoices:delete
 * (record-payment keeps the legacy banking:create key).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent, computeChanges } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';
import { nextEntityNumber, resolveEntityId } from '../../lib/entity-context';
import {
  assertPeriodOpen,
  ClosedPeriodError,
  writeAccountingAudit,
} from '../../services/accounting-guards';
import { generateInvoiceHtml } from '../../services/accounting-invoice-html';
import {
  buildComplianceNotices,
  collectInvoiceTaxCategories,
  getContactVatNumber,
  invoiceUsesReverseCharge,
  validateInvoiceForFinalize,
} from '../../services/accounting-compliance';

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
  productId: z.string().max(30).optional(),
  period: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  sortOrder: z.number().optional(),
});

const createInvoiceSchema = z.object({
  type: z.enum(['standard', 'credit_note', 'proforma', 'correction']).optional().default('standard'),
  contactId: z.string().min(1),
  contactName: z.string().optional(),
  contactEmail: z.string().optional(),
  issueDate: z.string(),
  dueDate: z.string(),
  currency: z.string().length(3).optional(),
  paymentTermsDays: z.number().optional(),
  reference: z.string().max(255).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  billingAddress: z.object({
    street: z.string().optional(),
    houseNumber: z.string().optional(),
    postalCode: z.string().optional(),
    city: z.string().optional(),
    province: z.string().optional(),
    country: z.string().optional(),
  }).optional(),
  revenueAccountId: z.string().max(30).optional(),
  creditNoteForInvoiceId: z.string().max(30).optional(),
  items: z.array(lineItemSchema).min(1),
});

const updateInvoiceSchema = createInvoiceSchema.partial();

const recordPaymentSchema = z.object({
  amount: z.string(),
  date: z.string(),
  paymentMethod: z.string().optional(),
  reference: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().optional(),
});

function calculateInvoiceTotals(items: Array<{
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRate?: string | null;
}>) {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;

  const taxBreakdown: Record<string, { taxRateId: string; taxRateName: string; taxRate: number; taxableAmount: number; taxAmount: number }> = {};

  const processedItems = items.map((item) => {
    const qty = parseFloat(item.quantity) || 1;
    const price = parseFloat(item.unitPrice) || 0;
    const discount = parseFloat(item.discountPercent) || 0;
    const rate = parseFloat(item.taxRate || '0');

    const lineGross = qty * price;
    const lineDiscount = lineGross * (discount / 100);
    const lineTotal = lineGross - lineDiscount;
    const lineTax = lineTotal * (rate / 100);
    const lineTotalWithTax = lineTotal + lineTax;

    subtotal += lineTotal;
    discountTotal += lineDiscount;
    taxTotal += lineTax;

    const rateKey = String(rate);
    if (!taxBreakdown[rateKey]) {
      taxBreakdown[rateKey] = { taxRateId: '', taxRateName: `${rate}%`, taxRate: rate, taxableAmount: 0, taxAmount: 0 };
    }
    taxBreakdown[rateKey].taxableAmount += lineTotal;
    taxBreakdown[rateKey].taxAmount += lineTax;

    return {
      lineTotal: lineTotal.toFixed(2),
      lineTotalWithTax: lineTotalWithTax.toFixed(2),
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
    taxBreakdown: Object.values(taxBreakdown),
    processedItems,
  };
}

/**
 * Auto-promote a contact's `role` when it gets its first invoice.
 * Idempotent — the role only ever moves forward:
 *   none → customer, supplier → both, both/customer → no-op.
 * (Inline port of api-worker's accounting/promote-role helper.)
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

/** Apply each journal line's net change to its account's running balance. */
async function applyBalances(
  db: Database,
  lines: Array<{ accountId: string; debit: string | null; credit: string | null }>,
) {
  const { accounts } = schema;
  for (const line of lines) {
    const debit = parseFloat(line.debit || '0');
    const credit = parseFloat(line.credit || '0');
    const netChange = debit - credit;
    if (netChange !== 0) {
      await db
        .update(accounts)
        .set({
          currentBalance: sql`(${accounts.currentBalance}::numeric + ${netChange})::text`,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, line.accountId));
    }
  }
}

// GET / — list invoices (entity-scoped, filters)
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices } = schema;

  const page = parseInt(c.req.query('page') || '1', 10);
  const pageSize = Math.min(Math.max(parseInt(c.req.query('pageSize') || '25', 10), 1), 100);
  const offset = (page - 1) * pageSize;

  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list — not an error.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const conditions: SQL[] = [isNull(invoices.deletedAt), eq(invoices.entityId, entityId)];

    const statusFilter = c.req.query('status');
    if (statusFilter) conditions.push(eq(invoices.status, statusFilter));

    const typeFilter = c.req.query('type');
    if (typeFilter) conditions.push(eq(invoices.type, typeFilter));

    const contactFilter = c.req.query('contactId');
    if (contactFilter) conditions.push(eq(invoices.contactId, contactFilter));

    const fromDate = c.req.query('from');
    if (fromDate) conditions.push(gte(invoices.issueDate, new Date(fromDate)));

    const toDate = c.req.query('to');
    if (toDate) conditions.push(lte(invoices.issueDate, new Date(toDate)));

    const overdueOnly = c.req.query('overdue');
    if (overdueOnly === 'true') {
      conditions.push(sql`${invoices.balanceDue}::numeric > 0`);
      conditions.push(lte(invoices.dueDate, new Date()));
    }

    const search = c.req.query('search');
    if (search) {
      const term = `%${search}%`;
      conditions.push(or(
        like(invoices.invoiceNumber, term),
        like(invoices.contactName, term),
        like(invoices.reference, term),
      )!);
    }

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(invoices).where(where)
        .orderBy(desc(invoices.issueDate))
        .limit(pageSize).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(invoices).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/invoices] list failed:', err);
    return error.internal(c, 'Failed to fetch invoices');
  }
});

// GET /:id — invoice detail with items + payments
app.get('/:id', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices, invoiceItems, payments: paymentsTable } = schema;
  const invoiceId = c.req.param('id');

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    const items = await db
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt)))
      .orderBy(invoiceItems.sortOrder);

    const invoicePayments = await db
      .select()
      .from(paymentsTable)
      .where(and(eq(paymentsTable.invoiceId, invoiceId), isNull(paymentsTable.deletedAt)))
      .orderBy(desc(paymentsTable.date));

    return success(c, { ...invoice, items, payments: invoicePayments });
  } catch (err) {
    console.error('[app-api/invoices] get failed:', err);
    return error.internal(c, 'Failed to fetch invoice');
  }
});

// GET /:id/pdf — generate printable HTML invoice
app.get('/:id/pdf', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices, invoiceItems } = schema;
  const invoiceId = c.req.param('id');

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    const items = await db
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt)))
      .orderBy(invoiceItems.sortOrder);

    const [entityRow] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, invoice.entityId), isNull(schema.entities.deletedAt)))
      .limit(1);

    if (!entityRow) return error.notFound(c, 'Entity', invoice.entityId);

    // Legally required statements (BTW verlegd / KOR) + buyer VAT number
    const taxCategories = await collectInvoiceTaxCategories(db, invoiceId);
    const complianceNotices = buildComplianceNotices(entityRow, taxCategories);
    const contactVatNumber = invoiceUsesReverseCharge(taxCategories)
      ? await getContactVatNumber(db, invoice.contactId)
      : null;

    const html = generateInvoiceHtml(
      {
        invoiceNumber: invoice.invoiceNumber || invoiceId,
        type: invoice.type || 'standard',
        issueDate: invoice.issueDate?.toISOString() || new Date().toISOString(),
        dueDate: invoice.dueDate?.toISOString() || new Date().toISOString(),
        currency: invoice.currency || entityRow.baseCurrency || 'EUR',
        contactName: invoice.contactName || '',
        contactEmail: invoice.contactEmail,
        contactVatNumber,
        complianceNotices,
        billingAddress: invoice.billingAddress,
        reference: invoice.reference,
        notes: invoice.notes,
        items: items.map((i) => ({
          description: i.description || '',
          quantity: i.quantity || '1',
          unitPrice: i.unitPrice || '0',
          unit: i.unit ?? undefined,
          discountPercent: i.discountPercent ?? undefined,
          taxRate: i.taxRate ?? undefined,
          lineTotal: i.lineTotal || '0',
          lineTotalWithTax: i.lineTotalWithTax ?? undefined,
          taxAmount: i.taxAmount ?? undefined,
        })),
        subtotal: invoice.subtotal || '0',
        discountTotal: invoice.discountTotal || '0',
        taxTotal: invoice.taxTotal || '0',
        total: invoice.total || '0',
        amountPaid: invoice.amountPaid ?? undefined,
        balanceDue: invoice.balanceDue ?? undefined,
        taxBreakdown: invoice.taxBreakdown || [],
      },
      entityRow,
    );

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename="${invoice.invoiceNumber || 'invoice'}.html"`,
      },
    });
  } catch (err) {
    console.error('[app-api/invoices] pdf failed:', err);
    return error.internal(c, 'Failed to generate invoice document');
  }
});

// POST / — create invoice with items
app.post('/', requirePermission('invoices:create'), zValidator('json', createInvoiceSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const { invoices, invoiceItems } = schema;

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved — set X-Accounting-Entity-Id or configure a default entity.');
    const { formatted: invoiceNumber } = await nextEntityNumber(db, entityId, 'invoice');

    // Calculate totals
    const totals = calculateInvoiceTotals(data.items.map(item => ({
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent || '0',
      taxRate: item.taxRate,
    })));

    const invoiceId = generateId('inv');
    const newInvoice = {
      id: invoiceId,
      entityId,
      invoiceNumber,
      type: data.type || 'standard',
      status: 'draft' as const,
      contactId: data.contactId,
      contactName: data.contactName || null,
      contactEmail: data.contactEmail || null,
      issueDate: new Date(data.issueDate),
      dueDate: new Date(data.dueDate),
      currency: data.currency || 'EUR',
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      amountPaid: '0',
      balanceDue: totals.balanceDue,
      paymentTermsDays: data.paymentTermsDays || null,
      reference: data.reference || null,
      notes: data.notes || null,
      internalNotes: data.internalNotes || null,
      billingAddress: data.billingAddress || null,
      revenueAccountId: data.revenueAccountId || null,
      creditNoteForInvoiceId: data.creditNoteForInvoiceId || null,
      taxBreakdown: totals.taxBreakdown,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.insert(invoices).values(newInvoice);

    // Create line items
    const itemRecords = data.items.map((item, idx) => ({
      id: generateId('ili'),
      entityId,
      invoiceId,
      description: item.description,
      quantity: item.quantity || '1',
      unitPrice: item.unitPrice,
      unit: item.unit || null,
      discountPercent: item.discountPercent || '0',
      taxRateId: item.taxRateId || null,
      taxRate: item.taxRate || null,
      taxAmount: totals.processedItems[idx].taxAmount,
      lineTotal: totals.processedItems[idx].lineTotal,
      lineTotalWithTax: totals.processedItems[idx].lineTotalWithTax,
      accountId: item.accountId || null,
      productId: item.productId || null,
      period: item.period || null,
      sortOrder: item.sortOrder ?? idx,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    if (itemRecords.length > 0) {
      await db.insert(invoiceItems).values(itemRecords);
    }

    // Promote the contact's role — first invoice flips role=none→customer,
    // or supplier→both. No-op if already correct.
    await promoteAccountingRole(db, data.contactId, 'customer');

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'created',
      data: {
        id: invoiceId,
        invoiceNumber,
        status: 'draft',
        total: totals.total,
        currency: newInvoice.currency,
        contactId: data.contactId,
        issueDate: newInvoice.issueDate.toISOString(),
        dueDate: newInvoice.dueDate.toISOString(),
      },
    });

    return success(c, { ...newInvoice, items: itemRecords }, 201);
  } catch (err) {
    console.error('[app-api/invoices] create failed:', err);
    return error.internal(c, 'Failed to create invoice');
  }
});

// PUT/PATCH /:id — update invoice (draft only; finalized invoices are immutable)
app.on(['PUT', 'PATCH'], '/:id', requirePermission('invoices:update'), zValidator('json', updateInvoiceSchema), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const data = c.req.valid('json');
  const { invoices, invoiceItems } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);
    if (invoice.status !== 'draft') {
      return error.badRequest(
        c,
        'Only draft invoices can be edited — finalized invoices are immutable. Corrections go through a credit note (POST /:id/credit-note).',
      );
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (data.contactId) updateData.contactId = data.contactId;
    if (data.contactName !== undefined) updateData.contactName = data.contactName;
    if (data.contactEmail !== undefined) updateData.contactEmail = data.contactEmail;
    if (data.issueDate) updateData.issueDate = new Date(data.issueDate);
    if (data.dueDate) updateData.dueDate = new Date(data.dueDate);
    if (data.currency) updateData.currency = data.currency;
    if (data.paymentTermsDays !== undefined) updateData.paymentTermsDays = data.paymentTermsDays;
    if (data.reference !== undefined) updateData.reference = data.reference;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.internalNotes !== undefined) updateData.internalNotes = data.internalNotes;
    if (data.billingAddress !== undefined) updateData.billingAddress = data.billingAddress;
    if (data.revenueAccountId !== undefined) updateData.revenueAccountId = data.revenueAccountId;

    if (data.items) {
      // Replace all line items
      await db
        .update(invoiceItems)
        .set({ deletedAt: new Date() })
        .where(eq(invoiceItems.invoiceId, invoiceId));

      const totals = calculateInvoiceTotals(data.items.map(item => ({
        quantity: item.quantity || '1',
        unitPrice: item.unitPrice,
        discountPercent: item.discountPercent || '0',
        taxRate: item.taxRate,
      })));

      updateData.subtotal = totals.subtotal;
      updateData.discountTotal = totals.discountTotal;
      updateData.taxTotal = totals.taxTotal;
      updateData.total = totals.total;
      updateData.balanceDue = String(parseFloat(totals.total) - parseFloat(invoice.amountPaid || '0'));
      updateData.taxBreakdown = totals.taxBreakdown;

      const newItems = data.items.map((item, idx) => ({
        id: generateId('ili'),
        entityId: invoice.entityId,
        invoiceId,
        description: item.description,
        quantity: item.quantity || '1',
        unitPrice: item.unitPrice,
        unit: item.unit || null,
        discountPercent: item.discountPercent || '0',
        taxRateId: item.taxRateId || null,
        taxRate: item.taxRate || null,
        taxAmount: totals.processedItems[idx].taxAmount,
        lineTotal: totals.processedItems[idx].lineTotal,
        lineTotalWithTax: totals.processedItems[idx].lineTotalWithTax,
        accountId: item.accountId || null,
        productId: item.productId || null,
        period: item.period || null,
        sortOrder: item.sortOrder ?? idx,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      if (newItems.length > 0) {
        await db.insert(invoiceItems).values(newItems);
      }
    }

    await db
      .update(invoices)
      .set(updateData)
      .where(eq(invoices.id, invoiceId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'updated',
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'updated',
      data: {
        id: invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        total: (updateData.total as string | undefined) ?? invoice.total ?? '0',
        currency: (updateData.currency as string | undefined) ?? invoice.currency,
        contactId: (updateData.contactId as string | undefined) ?? invoice.contactId,
      },
    });

    return success(c, { ...invoice, ...updateData });
  } catch (err) {
    console.error('[app-api/invoices] update failed:', err);
    return error.internal(c, 'Failed to update invoice');
  }
});

// DELETE /:id — soft delete (draft only; finalized invoices are immutable)
app.delete('/:id', requirePermission('invoices:delete'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const { invoices } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);
    if (invoice.status !== 'draft') {
      return error.badRequest(
        c,
        'Only draft invoices can be deleted — finalized invoices are immutable. Corrections go through a credit note (POST /:id/credit-note).',
      );
    }

    await db
      .update(invoices)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'deleted',
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'deleted',
      data: { id: invoiceId, invoiceNumber: invoice.invoiceNumber, status: invoice.status, total: invoice.total || '0' },
    });

    return success(c, { message: 'Invoice deleted' });
  } catch (err) {
    console.error('[app-api/invoices] delete failed:', err);
    return error.internal(c, 'Failed to delete invoice');
  }
});

// PATCH /:id/send — mark as sent
app.patch('/:id/send', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const { invoices } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    const now = new Date();
    await db
      .update(invoices)
      .set({ status: 'sent', sentAt: now, updatedAt: now })
      .where(eq(invoices.id, invoiceId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'sent',
      changes: { status: { old: invoice.status, new: 'sent' } },
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'updated',
      data: {
        id: invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        status: 'sent',
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
      changes: computeChanges(
        invoice as unknown as Record<string, unknown>,
        { status: 'sent', sentAt: now } as unknown as Record<string, unknown>,
      ),
    });

    return success(c, { ...invoice, status: 'sent', sentAt: now });
  } catch (err) {
    console.error('[app-api/invoices] send failed:', err);
    return error.internal(c, 'Failed to send invoice');
  }
});

// PATCH /:id/status — change status
app.patch('/:id/status', requirePermission('invoices:update'), zValidator('json', z.object({ status: z.enum(['cancelled', 'uncollectible']) })), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const { status: newStatus } = c.req.valid('json');
  const { invoices } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    await db
      .update(invoices)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'updated',
      changes: { status: { old: invoice.status, new: newStatus } },
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'updated',
      data: {
        id: invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        status: newStatus,
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
    });

    return success(c, { ...invoice, status: newStatus });
  } catch (err) {
    console.error('[app-api/invoices] status failed:', err);
    return error.internal(c, 'Failed to update invoice status');
  }
});

// POST /:id/finalize — post journal entry and lock
app.post('/:id/finalize', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const userId = c.get('userId');
  const { invoices, journalEntries, journalLines, accounts } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);
    if (invoice.status !== 'draft') {
      return error.badRequest(c, 'Can only finalize draft invoices');
    }

    // Bookings in closed fiscal periods are not allowed.
    await assertPeriodOpen(db, invoice.entityId, invoice.issueDate);

    // Factuureisen: finalizing turns the draft into a legal document, so the
    // jurisdiction's invoice requirements are enforced here (entity BTW/KvK/
    // IBAN present, VIES-valid buyer VAT number on reverse-charge invoices,
    // no VAT under KOR).
    const [entityRow] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, invoice.entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entityRow) return error.notFound(c, 'Entity', invoice.entityId);

    const taxCategories = await collectInvoiceTaxCategories(db, invoiceId);
    const compliance = await validateInvoiceForFinalize(db, entityRow, invoice, taxCategories);
    if (!compliance.ok) {
      return error.badRequest(c, compliance.errors.join(' '));
    }
    for (const warning of compliance.warnings) {
      console.warn(`[app-api/invoices] finalize warning for ${invoiceId}: ${warning}`);
    }

    const { formatted: entryNumber } = await nextEntityNumber(db, invoice.entityId, 'journal');

    // Find system accounts (scoped to the invoice's entity — codes repeat
    // across administrations in the multi-entity model)
    const debiteurenAccount = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, '1300'), eq(accounts.entityId, invoice.entityId), isNull(accounts.deletedAt)))
      .limit(1);

    const revenueAccount = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, '8000'), eq(accounts.entityId, invoice.entityId), isNull(accounts.deletedAt)))
      .limit(1);

    const btwTeBetalenAccount = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.code, '1700'), eq(accounts.entityId, invoice.entityId), isNull(accounts.deletedAt)))
      .limit(1);

    if (!debiteurenAccount[0] || !revenueAccount[0]) {
      return error.badRequest(c, 'System accounts not found. Please run seed first.');
    }

    const total = parseFloat(invoice.total || '0');
    const taxTotal = parseFloat(invoice.taxTotal || '0');
    const subtotal = total - taxTotal;

    // Create journal entry
    const journalEntryId = generateId('je');
    await db.insert(journalEntries).values({
      id: journalEntryId,
      entityId: invoice.entityId,
      entryNumber,
      date: invoice.issueDate,
      status: 'posted',
      description: `Invoice ${invoice.invoiceNumber} - ${invoice.contactName || ''}`,
      sourceType: 'invoice',
      sourceId: invoiceId,
      totalDebit: total.toFixed(2),
      totalCredit: total.toFixed(2),
      isAutomatic: true,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Debit: Debiteuren (total incl. tax)
    const lines = [
      {
        id: generateId('jl'),
        entityId: invoice.entityId,
        journalEntryId,
        accountId: debiteurenAccount[0].id,
        description: `Invoice ${invoice.invoiceNumber}`,
        debit: total.toFixed(2),
        credit: '0',
        contactId: invoice.contactId,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      // Credit: Revenue (subtotal excl. tax)
      {
        id: generateId('jl'),
        entityId: invoice.entityId,
        journalEntryId,
        accountId: invoice.revenueAccountId || revenueAccount[0].id,
        description: `Revenue ${invoice.invoiceNumber}`,
        debit: '0',
        credit: subtotal.toFixed(2),
        contactId: invoice.contactId,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // Credit: BTW te betalen (tax amount)
    if (taxTotal > 0 && btwTeBetalenAccount[0]) {
      lines.push({
        id: generateId('jl'),
        entityId: invoice.entityId,
        journalEntryId,
        accountId: btwTeBetalenAccount[0].id,
        description: `BTW ${invoice.invoiceNumber}`,
        debit: '0',
        credit: taxTotal.toFixed(2),
        contactId: invoice.contactId,
        sortOrder: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    await db.insert(journalLines).values(lines);

    // Update invoice status and link journal entry
    await db
      .update(invoices)
      .set({ status: 'sent', journalEntryId, updatedAt: new Date() })
      .where(eq(invoices.id, invoiceId));

    // The journal entry is born posted, so apply every line's balance effect
    // (the legacy route only updated the debiteuren account and left the
    // revenue/BTW balances stale).
    await applyBalances(db, lines);

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'finalized',
      changes: {
        status: { old: 'draft', new: 'sent' },
        journalEntryId: { old: null, new: journalEntryId },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'updated',
      data: {
        id: invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        status: 'sent',
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
    });

    return success(c, { invoiceId, journalEntryId, entryNumber, status: 'sent' });
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/invoices] finalize failed:', err);
    return error.internal(c, 'Failed to finalize invoice');
  }
});

// POST /:id/duplicate — create copy as draft
app.post('/:id/duplicate', requirePermission('invoices:create'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const userId = c.get('userId');
  const { invoices, invoiceItems } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    const items = await db
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt)));

    const newId = generateId('inv');
    const now = new Date();

    await db.insert(invoices).values({
      ...invoice,
      id: newId,
      invoiceNumber: null,
      status: 'draft',
      issueDate: now,
      dueDate: new Date(now.getTime() + (invoice.paymentTermsDays || 30) * 24 * 60 * 60 * 1000),
      paidAt: null,
      sentAt: null,
      viewedAt: null,
      amountPaid: '0',
      balanceDue: invoice.total,
      journalEntryId: null,
      originalInvoiceId: invoiceId,
      emailHistory: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    if (items.length > 0) {
      await db.insert(invoiceItems).values(
        items.map(item => ({
          ...item,
          id: generateId('ili'),
          invoiceId: newId,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: newId,
      action: 'created',
      changes: { originalInvoiceId: { old: null, new: invoiceId } },
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: newId,
      action: 'created',
      data: {
        id: newId,
        status: 'draft',
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
    });

    return success(c, { id: newId }, 201);
  } catch (err) {
    console.error('[app-api/invoices] duplicate failed:', err);
    return error.internal(c, 'Failed to duplicate invoice');
  }
});

// POST /:id/credit-note — create credit note
app.post('/:id/credit-note', requirePermission('invoices:create'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const userId = c.get('userId');
  const { invoices, invoiceItems } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    // The credit note inherits the original issue date — block if that
    // date falls inside a closed fiscal period.
    await assertPeriodOpen(db, invoice.entityId, invoice.issueDate);

    const items = await db
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt)));

    const { formatted: creditNoteNumber } = await nextEntityNumber(db, invoice.entityId, 'creditNote');

    const newId = generateId('inv');
    const now = new Date();

    await db.insert(invoices).values({
      ...invoice,
      id: newId,
      invoiceNumber: creditNoteNumber,
      type: 'credit_note',
      status: 'draft',
      creditNoteForInvoiceId: invoiceId,
      paidAt: null,
      sentAt: null,
      viewedAt: null,
      amountPaid: '0',
      journalEntryId: null,
      emailHistory: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    if (items.length > 0) {
      await db.insert(invoiceItems).values(
        items.map(item => ({
          ...item,
          id: generateId('ili'),
          invoiceId: newId,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: newId,
      action: 'credit_note',
      changes: { creditNoteForInvoiceId: { old: null, new: invoiceId } },
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: newId,
      action: 'created',
      data: {
        id: newId,
        invoiceNumber: creditNoteNumber,
        status: 'draft',
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
    });

    return success(c, { id: newId, invoiceNumber: creditNoteNumber }, 201);
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/invoices] credit-note failed:', err);
    return error.internal(c, 'Failed to create credit note');
  }
});

// POST /:id/record-payment — record payment against invoice
app.post('/:id/record-payment', requirePermission('banking:create'), zValidator('json', recordPaymentSchema), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const { invoices, payments } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    // Payments dated inside a closed fiscal period are not allowed.
    await assertPeriodOpen(db, invoice.entityId, data.date);

    const paymentAmount = parseFloat(data.amount);
    const currentPaid = parseFloat(invoice.amountPaid || '0');
    const invoiceTotal = parseFloat(invoice.total || '0');
    const newAmountPaid = currentPaid + paymentAmount;
    const newBalanceDue = invoiceTotal - newAmountPaid;
    const isFullyPaid = newBalanceDue <= 0;

    const paymentId = generateId('pay');
    await db.insert(payments).values({
      id: paymentId,
      entityId: invoice.entityId,
      type: 'received',
      amount: data.amount,
      date: new Date(data.date),
      paymentMethod: data.paymentMethod || null,
      reference: data.reference || null,
      invoiceId,
      contactId: invoice.contactId,
      bankAccountId: data.bankAccountId || null,
      notes: data.notes || null,
      isPartial: !isFullyPaid,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db
      .update(invoices)
      .set({
        amountPaid: newAmountPaid.toFixed(2),
        balanceDue: Math.max(0, newBalanceDue).toFixed(2),
        status: isFullyPaid ? 'paid' : 'partial',
        paidAt: isFullyPaid ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(invoices.id, invoiceId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'payment_recorded',
      changes: {
        amountPaid: { old: invoice.amountPaid, new: newAmountPaid.toFixed(2) },
        status: { old: invoice.status, new: isFullyPaid ? 'paid' : 'partial' },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: paymentId,
      action: 'created',
      data: {
        id: paymentId,
        invoiceId,
        amount: data.amount,
        date: data.date,
        method: data.paymentMethod ?? null,
      },
    });

    return success(c, {
      paymentId,
      amountPaid: newAmountPaid.toFixed(2),
      balanceDue: Math.max(0, newBalanceDue).toFixed(2),
      status: isFullyPaid ? 'paid' : 'partial',
    }, 201);
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/invoices] record-payment failed:', err);
    return error.internal(c, 'Failed to record payment');
  }
});

// POST /from-order/:orderId — create a draft invoice from a commerce order
app.post('/from-order/:orderId', requirePermission('invoices:create'), async (c) => {
  const db = c.get('tenantDb');
  const orderId = c.req.param('orderId');
  const userId = c.get('userId');
  const { invoices, invoiceItems, orders, orderItems } = schema;

  try {
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), isNull(orders.deletedAt)))
      .limit(1);

    if (!order) return error.notFound(c, 'Order', orderId);

    const contactId = order.counterpartyId || order.customerId;
    if (!contactId) {
      return error.badRequest(c, 'Order has no customer to invoice');
    }

    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved — set X-Accounting-Entity-Id or configure a default entity.');

    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    if (items.length === 0) {
      return error.badRequest(c, 'Order has no line items to invoice');
    }

    // Reconstruct per-line tax rates / discount percentages from the order's
    // absolute amounts so the invoice's line-item math matches the order.
    const lineInputs = items.map((item) => {
      const qty = item.quantity || 1;
      const price = parseFloat(item.unitPrice || '0');
      const gross = qty * price;
      const discountAmount = parseFloat(item.discountAmount || '0');
      const net = gross - discountAmount;
      const taxAmount = parseFloat(item.taxAmount || '0');
      const discountPercent = gross > 0 ? ((discountAmount / gross) * 100).toFixed(2) : '0';
      const taxRate = net > 0 && taxAmount > 0 ? ((taxAmount / net) * 100).toFixed(2) : '0';
      return {
        description: item.name + (item.description ? ` — ${item.description}` : ''),
        quantity: String(qty),
        unitPrice: item.unitPrice || '0',
        discountPercent,
        taxRate,
        productId: item.productId,
      };
    });

    const shippingTotal = parseFloat(order.shippingTotal || '0');
    if (shippingTotal > 0) {
      lineInputs.push({
        description: 'Shipping',
        quantity: '1',
        unitPrice: shippingTotal.toFixed(2),
        discountPercent: '0',
        taxRate: '0',
        productId: null,
      });
    }

    const totals = calculateInvoiceTotals(lineInputs);
    const { formatted: invoiceNumber } = await nextEntityNumber(db, entityId, 'invoice');

    const invoiceId = generateId('inv');
    const now = new Date();
    const billing = order.billingAddress || order.shippingAddress;

    const newInvoice = {
      id: invoiceId,
      entityId,
      invoiceNumber,
      type: 'standard',
      status: 'draft' as const,
      contactId,
      contactName: order.customerName || null,
      contactEmail: order.customerEmail || null,
      issueDate: now,
      dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      currency: order.currency || 'EUR',
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      amountPaid: '0',
      balanceDue: totals.balanceDue,
      reference: order.orderNumber,
      billingAddress: billing
        ? {
            street: billing.line1,
            postalCode: billing.postalCode,
            city: billing.city,
            province: billing.state,
            country: billing.country,
          }
        : null,
      commerceOrderId: orderId,
      taxBreakdown: totals.taxBreakdown,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(invoices).values(newInvoice);

    const itemRecords = lineInputs.map((item, idx) => ({
      id: generateId('ili'),
      entityId,
      invoiceId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      taxRate: item.taxRate,
      taxAmount: totals.processedItems[idx].taxAmount,
      lineTotal: totals.processedItems[idx].lineTotal,
      lineTotalWithTax: totals.processedItems[idx].lineTotalWithTax,
      productId: item.productId || null,
      sortOrder: idx,
      createdAt: now,
      updatedAt: now,
    }));

    await db.insert(invoiceItems).values(itemRecords);

    await promoteAccountingRole(db, contactId, 'customer');

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'created',
      changes: { commerceOrderId: { old: null, new: orderId } },
    });
    publishEntityEvent({
      c,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'created',
      data: {
        id: invoiceId,
        invoiceNumber,
        status: 'draft',
        total: totals.total,
        currency: newInvoice.currency,
        contactId,
        issueDate: now.toISOString(),
        dueDate: newInvoice.dueDate.toISOString(),
      },
    });

    return success(c, { invoiceId, invoiceNumber }, 201);
  } catch (err) {
    console.error('[app-api/invoices] from-order failed:', err);
    return error.internal(c, 'Failed to create invoice from order');
  }
});

export const invoicesRoutes = app;
