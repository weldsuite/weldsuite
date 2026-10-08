/**
 * Invoice routes — flat /api/invoices/* surface backed by `invoices`.
 *
 * Entity-scoped list/detail, server-side tax calculation on create/update
 * (services/accounting-tax-resolve), gapless sequence numbers, finalize (one
 * atomic posting through services/accounting-posting: journal entry, tax
 * ledger, account balances), duplicate, credit note, payment recording,
 * write-off, printable HTML, and invoice-from-commerce-order.
 *
 * Integrity rules (administratieplicht — do not weaken):
 *   - Only draft invoices may be edited or deleted; finalized/sent invoices
 *     are immutable — corrections go through POST /:id/credit-note.
 *   - Every posting is refused inside closed fiscal periods and on/before the
 *     entity's lock dates (assertPostingAllowed), and posts at most once.
 *   - Every mutation is written to the accounting audit log.
 *
 * Permissions: invoices:read | invoices:create | invoices:update | invoices:delete
 * (record-payment keeps the legacy banking:create key).
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, like, lte, or, sql, type SQL } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent, computeChanges } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { nextEntityNumber, resolveEntityBaseCurrency, resolveEntityId } from '../../lib/entity-context';
import {
  ClosedPeriodError,
  LockedPeriodError,
  writeAccountingAudit,
} from '@weldsuite/books-domain/accounting-guards';
import { generateInvoiceHtml } from '@weldsuite/books-domain/accounting-invoice-html';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { streamDocumentAttachment } from '../../lib/document-attachment';
import {
  buildComplianceNotices,
  collectInvoiceTaxCategories,
  getContactVatNumber,
  invoiceUsesReverseCharge,
} from '@weldsuite/books-domain/accounting-compliance';
import { calculateDocumentTax, TaxCalculationError, type DocumentTaxItem } from '../../services/accounting-tax-resolve';
import { PostingError, postInvoiceWriteOff } from '../../services/accounting-document-posting';
import { assertDimensionsBelongToEntity } from '../../services/accounting-posting';
import { finalizeInvoice, InvoiceComplianceError } from '../../services/accounting-invoice-finalize';
import { recordPayment } from '../../services/accounting-payments';
import { salesTaxErrorResponse } from '../../services/sales-tax/errors';
import { loadSalesTaxEntity, mapCreditItemsToOriginal, usesSalesTax } from '../../services/sales-tax/document-tax';
import {
  calculateDraftTax,
  engineUnavailableWarning,
  invoiceDocumentContext,
  invoiceItemToTaxItem,
  invoiceKind,
  invoiceTaxColumns,
  itemTaxColumns,
  mergeSyncWarning,
} from '../../services/sales-tax/persist';
import { syncInvoiceWithProvider } from '../../services/sales-tax/provider-sync';
import { salesTaxRuntimeFromEnv } from '../../services/sales-tax/runtime';
import { orderInvoiceLines } from '../../services/sales-tax/order-invoice';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** 400 for errors the user can fix (closed period, lock date, posting rules, tax rates); undefined otherwise. */
function accountingErrorResponse(c: AppContext, err: unknown): Response | undefined {
  // Sales tax refusals carry their own code (ADDRESS_REQUIRED, TAX_ENGINE_UNAVAILABLE, ...).
  const salesTax = salesTaxErrorResponse(c, err);
  if (salesTax) return salesTax;
  if (
    err instanceof ClosedPeriodError ||
    err instanceof LockedPeriodError ||
    err instanceof PostingError ||
    err instanceof TaxCalculationError ||
    err instanceof InvoiceComplianceError
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
  productId: z.string().max(30).nullable().optional(),
  period: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
  sortOrder: z.number().optional(),
  // US sales tax: the line's tax code (else its product's), who uses it, tax-inclusive pricing, a hand-set tax.
  taxCode: z.string().max(30).nullable().optional(),
  taxUse: z.enum(['business', 'personal']).nullable().optional(),
  taxIncluded: z.boolean().optional(),
  taxOverrideAmount: z.union([z.string(), z.number()]).transform((v) => String(v)).nullable().optional(),
  taxOverrideReason: z.string().max(255).nullable().optional(),
  // Reporting dimensions (accounting_dimension_values).
  classId: z.string().max(30).nullable().optional(),
  locationId: z.string().max(30).nullable().optional(),
  /** Credit memos: the invoice line this one credits (matched by description when omitted). */
  originalLineId: z.string().max(30).nullable().optional(),
});

const invoiceStatusSchema = z.enum([
  'draft',
  'sent',
  'paid',
  'overdue',
  'partial',
  'cancelled',
  'uncollectible',
  'finalized',
]);

const createInvoiceSchema = z.object({
  type: z.enum(['standard', 'credit_note', 'proforma', 'correction']).optional().default('standard'),
  status: invoiceStatusSchema.optional(),
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
  billingAddress: addressSchema.nullable().optional(),
  shippingAddress: addressSchema.nullable().optional(),
  /** US sales tax: the origin for origin-sourced states, when it is not the entity's address. */
  shipFromAddress: addressSchema.nullable().optional(),
  /** Sold through a marketplace facilitator that collects the tax: no tax charged, the sale counts for nexus. */
  marketplaceFacilitated: z.boolean().optional(),
  revenueAccountId: z.string().max(30).optional(),
  creditNoteForInvoiceId: z.string().max(30).optional(),
  items: z.array(lineItemSchema).min(1),
});

// Status changes go through the dedicated send / finalize / payment routes.
// Omit it here so a PATCH body cannot silently drop a requested status.
const updateInvoiceSchema = createInvoiceSchema.omit({ status: true }).partial();

const recordPaymentSchema = z.object({
  amount: z.string(),
  date: z.string(),
  /** See PAYMENT_METHODS; older values (card, manual) are mapped. */
  paymentMethod: z.string().max(30).optional(),
  checkNumber: z.string().max(30).optional(),
  reference: z.string().optional(),
  bankAccountId: z.string().optional(),
  /** US: park the money in Undeposited Funds or debit the bank. Defaults by method (checks and cash wait). */
  depositTo: z.enum(['undeposited_funds', 'bank']).optional(),
  notes: z.string().optional(),
});

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

type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

/** Scalar (non-item) columns a PUT/PATCH body may change on a draft invoice. */
function buildInvoiceFieldUpdates(data: UpdateInvoiceInput): Record<string, unknown> {
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
  if (data.billingAddress !== undefined) updateData.billingAddress = normalizePostalAddress(data.billingAddress);
  if (data.shippingAddress !== undefined) updateData.shippingAddress = normalizePostalAddress(data.shippingAddress);
  if (data.shipFromAddress !== undefined) updateData.shipFromAddress = normalizePostalAddress(data.shipFromAddress);
  if (data.marketplaceFacilitated !== undefined) updateData.marketplaceFacilitated = data.marketplaceFacilitated;
  if (data.revenueAccountId !== undefined) updateData.revenueAccountId = data.revenueAccountId;

  return updateData;
}

/** The invoice fields a US draft's tax depends on besides its lines. */
const TAX_INPUT_FIELDS = [
  'contactId',
  'issueDate',
  'currency',
  'billingAddress',
  'shippingAddress',
  'shipFromAddress',
  'marketplaceFacilitated',
] as const;

/** The new line rows of an invoice, with the calculation's tax columns and the US inputs. */
function buildItemRecords(
  entityId: string,
  invoiceId: string,
  itemIds: string[],
  items: Array<z.infer<typeof lineItemSchema>>,
  calc: Parameters<typeof itemTaxColumns>[0],
) {
  const now = new Date();
  return items.map((item, idx) => ({
    id: itemIds[idx],
    entityId,
    invoiceId,
    description: item.description,
    quantity: item.quantity || '1',
    unitPrice: item.unitPrice,
    unit: item.unit || null,
    discountPercent: item.discountPercent || '0',
    ...itemTaxColumns(calc, idx),
    accountId: item.accountId || null,
    productId: item.productId || null,
    period: item.period || null,
    sortOrder: item.sortOrder ?? idx,
    taxCode: item.taxCode || null,
    taxUse: item.taxUse || null,
    taxIncluded: item.taxIncluded ?? false,
    taxOverrideAmount: item.taxOverrideAmount ?? null,
    taxOverrideReason: item.taxOverrideReason ?? null,
    classId: item.classId || null,
    locationId: item.locationId || null,
    createdAt: now,
    updatedAt: now,
  }));
}

/** Address that decides place of supply: shipping, else billing. */
function taxAddress(
  shipping: Parameters<typeof normalizePostalAddress>[0],
  billing: Parameters<typeof normalizePostalAddress>[0],
) {
  const address = normalizePostalAddress(shipping) ?? normalizePostalAddress(billing);
  return { buyerCountry: address?.country, billingProvince: address?.state };
}

// GET / — list invoices (entity-scoped, filters)
app.get('/', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices } = schema;

  const page = Number.parseInt(c.req.query('page') || '1', 10);
  const pageSize = Math.min(Math.max(Number.parseInt(c.req.query('pageSize') || '25', 10), 1), 100);
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
      conditions.push(
        sql`${invoices.balanceDue}::numeric > 0`,
        lte(invoices.dueDate, new Date()),
      );
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

    // A credit memo's lines say which invoice line they credit (the tax is reversed per line).
    let itemRows: Array<(typeof items)[number] & { originalLineId?: string | null }> = items;
    if (invoice.type === 'credit_note' && invoice.creditNoteForInvoiceId) {
      const originalItems = await db
        .select()
        .from(invoiceItems)
        .where(and(eq(invoiceItems.invoiceId, invoice.creditNoteForInvoiceId), isNull(invoiceItems.deletedAt)));
      const mapping = mapCreditItemsToOriginal(items, originalItems);
      itemRows = items.map((item) => ({ ...item, originalLineId: mapping.get(item.id) ?? null }));
    }

    // Payments that settle this invoice: directly (older single-invoice
    // payments) or through an allocation (a payment covering several).
    const allocations = await db
      .select({ paymentId: schema.paymentAllocations.paymentId, amount: schema.paymentAllocations.amount })
      .from(schema.paymentAllocations)
      .where(and(eq(schema.paymentAllocations.invoiceId, invoiceId), isNull(schema.paymentAllocations.deletedAt)));
    const allocatedPaymentIds = allocations.map((a) => a.paymentId);
    const paymentRows = await db
      .select()
      .from(paymentsTable)
      .where(and(
        isNull(paymentsTable.deletedAt),
        allocatedPaymentIds.length > 0
          ? or(eq(paymentsTable.invoiceId, invoiceId), inArray(paymentsTable.id, allocatedPaymentIds))
          : eq(paymentsTable.invoiceId, invoiceId),
      ))
      .orderBy(desc(paymentsTable.date));
    const allocatedAmount = new Map(allocations.map((a) => [a.paymentId, a.amount]));
    const invoicePayments = paymentRows.map((p) => ({ ...p, allocatedAmount: allocatedAmount.get(p.id) ?? p.amount }));

    return success(c, { ...invoice, items: itemRows, payments: invoicePayments });
  } catch (err) {
    console.error('[app-api/invoices] get failed:', err);
    return error.internal(c, 'Failed to fetch invoice');
  }
});

// GET /:id/attachments/:index — stream a synced Moneybird (or other) file from R2
app.get('/:id/attachments/:index', requirePermission('invoices:read'), async (c) => {
  const db = c.get('tenantDb');
  const { invoices } = schema;
  const invoiceId = c.req.param('id');
  const index = Number(c.req.param('index'));

  try {
    const [invoice] = await db
      .select({ attachmentKeys: invoices.attachmentKeys })
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);
    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    return streamDocumentAttachment(c, {
      attachmentKeys: invoice.attachmentKeys,
      index,
      workspaceId: c.get('workspaceId') || c.get('orgId'),
    });
  } catch (err) {
    console.error('[app-api/invoices] attachment download failed:', err);
    return error.internal(c, 'Failed to download attachment');
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

    // An exempt US sale prints its certificate number.
    const certificateIds = [
      ...new Set((invoice.taxBreakdown ?? []).map((row) => row.certificateId).filter((id): id is string => Boolean(id))),
    ];
    const certificates =
      certificateIds.length > 0
        ? await db
            .select({ id: schema.exemptionCertificates.id, number: schema.exemptionCertificates.certificateNumber })
            .from(schema.exemptionCertificates)
            .where(inArray(schema.exemptionCertificates.id, certificateIds))
        : [];

    const html = generateInvoiceHtml(
      {
        certificateNumbers: Object.fromEntries(certificates.map((cert) => [cert.id, cert.number])),
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
        shippingAddress: invoice.shippingAddress,
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
    const currency = data.currency || (await resolveEntityBaseCurrency(db, entityId));

    const billingAddress = normalizePostalAddress(data.billingAddress);
    const shippingAddress = normalizePostalAddress(data.shippingAddress);
    const shipFromAddress = normalizePostalAddress(data.shipFromAddress);
    await assertDimensionsBelongToEntity(db, entityId, data.items);

    // Line ids first: the tax breakdown refers to them.
    const invoiceId = generateId('inv');
    const itemIds = data.items.map(() => generateId('ili'));
    const drafted = await calculateDraftTax(db, {
      entityId,
      direction: 'sales',
      items: data.items.map((item, idx) => ({ ...item, id: itemIds[idx], sortOrder: item.sortOrder ?? idx })),
      ...taxAddress(shippingAddress, billingAddress),
      runtime: salesTaxRuntimeFromEnv(c.env),
      document: {
        kind: invoiceKind({ type: data.type || 'standard' }),
        documentId: invoiceId,
        documentNumber: invoiceNumber,
        contactId: data.contactId,
        issueDate: new Date(data.issueDate),
        currency,
        billingAddress,
        shippingAddress,
        shipFromAddress,
        marketplaceFacilitated: data.marketplaceFacilitated,
        originalInvoiceId: data.creditNoteForInvoiceId,
      },
    });
    // The engine being down doesn't stop a draft; finalizing recalculates and refuses until it is back.
    const totals = drafted.calc;
    const status = data.status ?? 'draft';
    const newInvoice = {
      id: invoiceId,
      entityId,
      invoiceNumber,
      type: data.type || 'standard',
      status,
      contactId: data.contactId,
      contactName: data.contactName || null,
      contactEmail: data.contactEmail || null,
      issueDate: new Date(data.issueDate),
      dueDate: new Date(data.dueDate),
      currency,
      ...invoiceTaxColumns(totals),
      ...(drafted.ok ? {} : { taxWarnings: [engineUnavailableWarning(drafted.message)] }),
      amountPaid: '0',
      balanceDue: totals.balanceDue,
      paymentTermsDays: data.paymentTermsDays || null,
      reference: data.reference || null,
      notes: data.notes || null,
      internalNotes: data.internalNotes || null,
      billingAddress,
      shippingAddress,
      shipFromAddress,
      marketplaceFacilitated: data.marketplaceFacilitated ?? false,
      revenueAccountId: data.revenueAccountId || null,
      creditNoteForInvoiceId: data.creditNoteForInvoiceId || null,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Create line items
    const itemRecords = buildItemRecords(entityId, invoiceId, itemIds, data.items, totals);

    // Header and lines land together or not at all (neon-http has no transactions).
    await atomically(db, (h) => [
      h.insert(invoices).values(newInvoice),
      ...(itemRecords.length > 0 ? [h.insert(invoiceItems).values(itemRecords)] : []),
    ]);

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
        status,
        total: totals.total,
        currency: newInvoice.currency,
        contactId: data.contactId,
        issueDate: newInvoice.issueDate.toISOString(),
        dueDate: newInvoice.dueDate.toISOString(),
      },
    });

    return success(c, { ...newInvoice, items: itemRecords }, 201);
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
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

    const updateData: Record<string, unknown> = buildInvoiceFieldUpdates(data);

    // Tax is recalculated when the lines change, and on a US entity when anything the tax depends on does
    // (customer, date, addresses): the stored lines are re-taxed then.
    const salesTaxEntity = usesSalesTax(await loadSalesTaxEntity(db, invoice.entityId));
    const taxInputsChanged =
      data.items !== undefined || (salesTaxEntity && TAX_INPUT_FIELDS.some((field) => data[field] !== undefined));

    let newItems: ReturnType<typeof buildItemRecords> | undefined;
    const storedItemTax: Array<{ id: string; columns: ReturnType<typeof itemTaxColumns> }> = [];
    if (taxInputsChanged) {
      const effective = { ...invoice, ...updateData } as typeof invoice;
      const storedItems = data.items
        ? []
        : await db
            .select()
            .from(invoiceItems)
            .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt)))
            .orderBy(invoiceItems.sortOrder);
      const itemIds = data.items ? data.items.map(() => generateId('ili')) : storedItems.map((i) => i.id);
      const taxItems: DocumentTaxItem[] = data.items
        ? data.items.map((item, idx) => ({ ...item, id: itemIds[idx], sortOrder: item.sortOrder ?? idx }))
        : storedItems.map(invoiceItemToTaxItem);
      if (data.items) await assertDimensionsBelongToEntity(db, invoice.entityId, data.items);

      const drafted = await calculateDraftTax(db, {
        entityId: invoice.entityId,
        direction: 'sales',
        items: taxItems,
        ...taxAddress(effective.shippingAddress, effective.billingAddress),
        runtime: salesTaxRuntimeFromEnv(c.env),
        document: invoiceDocumentContext(effective),
      });

      if (drafted.ok || data.items) {
        // With new lines a failed calculation leaves them untaxed and flagged; the old tax belongs to the old lines.
        Object.assign(updateData, invoiceTaxColumns(drafted.calc));
        if (!drafted.ok) {
          Object.assign(updateData, {
            taxEngine: null,
            taxEngineRef: null,
            taxCalculatedAt: null,
            taxWarnings: [engineUnavailableWarning(drafted.message)],
          });
        }
        updateData.balanceDue = String(Number.parseFloat(drafted.calc.total) - Number.parseFloat(invoice.amountPaid || '0'));
        if (data.items) newItems = buildItemRecords(invoice.entityId, invoiceId, itemIds, data.items, drafted.calc);
        else storedItems.forEach((item, idx) => storedItemTax.push({ id: item.id, columns: itemTaxColumns(drafted.calc, idx) }));
      } else {
        // Unchanged lines keep their last calculation.
        updateData.taxWarnings = mergeSyncWarning(invoice.taxWarnings, engineUnavailableWarning(drafted.message));
      }
    }

    // Replace the lines and update the header together (neon-http has no transactions).
    const replacedAt = new Date();
    await atomically(db, (h) => [
      ...(newItems
        ? [
            h
              .update(invoiceItems)
              .set({ deletedAt: replacedAt })
              .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt))),
            ...(newItems.length > 0 ? [h.insert(invoiceItems).values(newItems)] : []),
          ]
        : []),
      ...storedItemTax.map((item) =>
        h.update(invoiceItems).set({ ...item.columns, updatedAt: replacedAt }).where(eq(invoiceItems.id, item.id)),
      ),
      h.update(invoices).set(updateData).where(eq(invoices.id, invoiceId)),
    ]);

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

    return success(c, { ...invoice, ...updateData, ...(newItems ? { items: newItems } : {}) });
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
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

// PATCH /:id/send — mark as sent. A draft is finalized (posted) first, so
// nothing reaches a customer without being in the ledger.
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
    if (invoice.status === 'cancelled') return error.badRequest(c, 'A cancelled invoice cannot be sent');

    const now = new Date();
    let journalEntryId = invoice.journalEntryId;
    if (invoice.status === 'draft') {
      const finalized = await finalizeInvoice(db, invoiceId, {
        userId: c.get('userId') ?? null,
        markSent: true,
        tax: salesTaxRuntimeFromEnv(c.env),
      });
      journalEntryId = finalized.journalEntryId;
    } else {
      await db
        .update(invoices)
        .set({ sentAt: now, updatedAt: now })
        .where(eq(invoices.id, invoiceId));
    }
    const status = invoice.status === 'draft' ? 'sent' : invoice.status;

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'sent',
      changes: {
        status: { old: invoice.status, new: status },
        ...(journalEntryId !== invoice.journalEntryId ? { journalEntryId: { old: null, new: journalEntryId } } : {}),
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
        status,
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
      changes: computeChanges(
        invoice as unknown as Record<string, unknown>,
        { status, sentAt: now } as unknown as Record<string, unknown>,
      ),
    });

    return success(c, { ...invoice, status, sentAt: now, journalEntryId });
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/invoices] send failed:', err);
    return error.internal(c, 'Failed to send invoice');
  }
});

// PATCH /:id/status — cancel an invoice that was never booked, or write a
// booked one off as uncollectible (bad debt). A booked invoice is corrected
// with a credit note, never cancelled.
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
    if (invoice.status === newStatus) return success(c, invoice);

    let journalEntryId: string | null = null;
    if (newStatus === 'cancelled') {
      if (invoice.journalEntryId) {
        return error.badRequest(
          c,
          'This invoice is booked and cannot be cancelled. Create a credit note (POST /:id/credit-note) to correct it.',
        );
      }
      await db.update(invoices).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(invoices.id, invoiceId));
    } else {
      if (!invoice.journalEntryId) {
        return error.badRequest(c, 'Only a finalized invoice can be written off as uncollectible');
      }
      if (Number.parseFloat(invoice.balanceDue ?? '0') <= 0) {
        return error.badRequest(c, 'This invoice has no open balance to write off');
      }
      const posted = await postInvoiceWriteOff(db, invoice, { userId: c.get('userId') ?? null });
      journalEntryId = posted.journalEntryId;
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: newStatus === 'uncollectible' ? 'written_off' : 'updated',
      changes: {
        status: { old: invoice.status, new: newStatus },
        ...(journalEntryId ? { writeOffEntryId: { old: null, new: journalEntryId } } : {}),
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
        status: newStatus,
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
    });

    return success(c, {
      ...invoice,
      status: newStatus,
      ...(newStatus === 'uncollectible' ? { balanceDue: '0.00', writeOffEntryId: journalEntryId } : {}),
    });
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/invoices] status failed:', err);
    return error.internal(c, 'Failed to update invoice status');
  }
});

// POST /:id/finalize — enforce the invoice requirements, post to the ledger, lock
app.post('/:id/finalize', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');

  try {
    const [invoice] = await db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);
    if (invoice.status !== 'draft') {
      return error.badRequest(c, 'Can only finalize draft invoices');
    }

    const result = await finalizeInvoice(db, invoiceId, { userId: c.get('userId') ?? null, tax: salesTaxRuntimeFromEnv(c.env) });
    for (const warning of result.warnings) {
      console.warn(`[books-api/invoices] finalize warning for ${invoiceId}: ${warning}`);
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'finalized',
      changes: {
        status: { old: 'draft', new: 'sent' },
        journalEntryId: { old: null, new: result.journalEntryId },
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
    if (result.journalEntryId && !result.alreadyPosted) {
      publishEntityEvent({
        c,
        entityType: 'journal_entry',
        entityId: result.journalEntryId,
        action: 'created',
        data: { id: result.journalEntryId, sourceType: invoice.type === 'credit_note' ? 'credit_note' : 'invoice', sourceId: invoiceId },
      });
    }

    return success(c, {
      invoiceId,
      journalEntryId: result.journalEntryId,
      entryNumber: result.entryNumber,
      status: 'sent',
      // Sales tax: engine warnings (not_registered_in_state, address_unverified, ...) and the provider sync outcome.
      warnings: result.warnings,
      taxSync: result.taxSync ?? null,
    });
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/invoices] finalize failed:', err);
    return error.internal(c, 'Failed to finalize invoice');
  }
});

// POST /:id/commit-tax — record a finalized invoice (or reverse a credit memo) with the provider
// sales tax engine. Finalizing does this itself; this retries it after a failure (see tax_warnings).
app.post('/:id/commit-tax', requirePermission('invoices:update'), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');

  try {
    const [invoice] = await db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
      .limit(1);
    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    const result = await syncInvoiceWithProvider(db, invoiceId, salesTaxRuntimeFromEnv(c.env));

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'tax_synced',
      changes: { status: { old: null, new: result.status } },
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
        total: invoice.total || '0',
        currency: invoice.currency,
        contactId: invoice.contactId,
      },
    });
    return success(c, result);
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/invoices] commit-tax failed:', err);
    return error.internal(c, 'Failed to record the invoice with the tax provider');
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
    // A copy of a credit note is a credit note; everything else is a new invoice.
    const { formatted: newNumber } = await nextEntityNumber(
      db,
      invoice.entityId,
      invoice.type === 'credit_note' ? 'creditNote' : 'invoice',
    );

    const duplicateItems = items.map(item => ({
      ...item,
      id: generateId('ili'),
      invoiceId: newId,
      createdAt: now,
      updatedAt: now,
    }));
    // The copy's tax rows follow its new line ids; its tax is recalculated when it is finalized.
    const newLineId = new Map(items.map((item, idx) => [item.id, duplicateItems[idx].id]));
    const duplicateRow = {
      ...invoice,
      id: newId,
      invoiceNumber: newNumber,
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
      taxBreakdown: (invoice.taxBreakdown ?? []).map((row) => ({ ...row, lineId: row.lineId ? (newLineId.get(row.lineId) ?? row.lineId) : row.lineId })),
      taxEngineRef: null,
      taxCalculatedAt: null,
      taxCommittedAt: null,
      taxWarnings: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    await atomically(db, (h) => [
      h.insert(invoices).values(duplicateRow),
      ...(duplicateItems.length > 0 ? [h.insert(invoiceItems).values(duplicateItems)] : []),
    ]);

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

    return success(c, { id: newId, invoiceNumber: newNumber }, 201);
  } catch (err) {
    console.error('[app-api/invoices] duplicate failed:', err);
    return error.internal(c, 'Failed to duplicate invoice');
  }
});

// POST /:id/credit-note — draft credit note mirroring a finalized invoice.
// It is a new document dated today (the correction lands in the current
// period, so a closed period never blocks a correction); finalizing it posts
// the invoice's entry in reverse.
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
    if (invoice.type === 'credit_note') return error.badRequest(c, 'A credit note cannot itself be credited');
    if (invoice.status === 'draft') {
      return error.badRequest(c, 'A draft invoice can simply be edited or deleted — no credit note needed');
    }

    const items = await db
      .select()
      .from(invoiceItems)
      .where(and(eq(invoiceItems.invoiceId, invoiceId), isNull(invoiceItems.deletedAt)));

    const { formatted: creditNoteNumber } = await nextEntityNumber(db, invoice.entityId, 'creditNote');

    const newId = generateId('inv');
    const now = new Date();

    let creditNoteRow: typeof invoice = {
      ...invoice,
      id: newId,
      invoiceNumber: creditNoteNumber,
      type: 'credit_note',
      status: 'draft',
      issueDate: now,
      dueDate: now,
      creditNoteForInvoiceId: invoiceId,
      paidAt: null,
      sentAt: null,
      viewedAt: null,
      amountPaid: '0',
      balanceDue: invoice.total,
      journalEntryId: null,
      emailHistory: null,
      // The provider records the memo itself (a reversal) when it is finalized.
      taxEngineRef: null,
      taxCommittedAt: null,
      taxWarnings: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };
    let creditNoteItems = items.map(item => ({
      ...item,
      id: generateId('ili'),
      invoiceId: newId,
      createdAt: now,
      updatedAt: now,
    }));

    // US sales tax: the memo reverses the invoice's tax line by line at the invoice's own rates,
    // never at today's. Its tax rows are keyed on the memo's own line ids.
    if (invoice.taxEngine && usesSalesTax(await loadSalesTaxEntity(db, invoice.entityId))) {
      const calc = await calculateDocumentTax(db, {
        entityId: invoice.entityId,
        direction: 'sales',
        items: creditNoteItems.map(invoiceItemToTaxItem),
        document: invoiceDocumentContext(creditNoteRow),
      });
      creditNoteRow = { ...creditNoteRow, ...invoiceTaxColumns(calc), balanceDue: calc.total };
      creditNoteItems = creditNoteItems.map((item, idx) => ({ ...item, ...itemTaxColumns(calc, idx) }));
    }

    await atomically(db, (h) => [
      h.insert(invoices).values(creditNoteRow),
      ...(creditNoteItems.length > 0 ? [h.insert(invoiceItems).values(creditNoteItems)] : []),
    ]);

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
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/invoices] credit-note failed:', err);
    return error.internal(c, 'Failed to create credit note');
  }
});

// POST /:id/record-payment — record a payment against this invoice (posted:
// Dr bank / Cr receivable, and the invoice's paid amount and status updated).
app.post('/:id/record-payment', requirePermission('banking:create'), zValidator('json', recordPaymentSchema), async (c) => {
  const db = c.get('tenantDb');
  const invoiceId = c.req.param('id');
  const data = c.req.valid('json');
  const userId = c.get('userId') ?? null;
  const { invoices } = schema;

  try {
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), isNull(invoices.deletedAt)))
      .limit(1);

    if (!invoice) return error.notFound(c, 'Invoice', invoiceId);

    const amount = Number.parseFloat(data.amount);
    const result = await recordPayment(db, {
      entityId: invoice.entityId,
      type: 'received',
      amount,
      currency: invoice.currency,
      exchangeRate: invoice.exchangeRate,
      date: new Date(data.date),
      paymentMethod: data.paymentMethod ?? null,
      checkNumber: data.checkNumber ?? null,
      depositTo: data.depositTo ?? null,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      contactId: invoice.contactId,
      bankAccountId: data.bankAccountId ?? null,
      allocations: [{ invoiceId, amount }],
      userId,
    });

    const [updated] = await db
      .select({ amountPaid: invoices.amountPaid, balanceDue: invoices.balanceDue, status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);

    await writeAccountingAudit(c, db, {
      accountingEntityId: invoice.entityId,
      entityType: 'invoice',
      entityId: invoiceId,
      action: 'payment_recorded',
      changes: {
        amountPaid: { old: invoice.amountPaid, new: updated?.amountPaid ?? null },
        status: { old: invoice.status, new: updated?.status ?? null },
      },
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: result.paymentId,
      action: 'created',
      data: {
        id: result.paymentId,
        invoiceId,
        amount: data.amount,
        date: data.date,
        method: data.paymentMethod ?? null,
      },
    });

    return success(c, {
      paymentId: result.paymentId,
      journalEntryId: result.journalEntryId,
      amountPaid: updated?.amountPaid ?? null,
      balanceDue: updated?.balanceDue ?? null,
      status: updated?.status ?? null,
    }, 201);
  } catch (err) {
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[books-api/invoices] record-payment failed:', err);
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

    // US entity: the engine taxes the order's lines (item by item, shipping as its own line) instead of a
    // rate rebuilt from each item's tax amount.
    if (usesSalesTax(await loadSalesTaxEntity(db, entityId))) {
      const lines = await orderInvoiceLines(db, order, items);
      const billingAddress = normalizePostalAddress(order.billingAddress ?? order.shippingAddress);
      const shippingAddress = normalizePostalAddress(order.shippingAddress);
      const { formatted: invoiceNumber } = await nextEntityNumber(db, entityId, 'invoice');
      const currency = order.currency || (await resolveEntityBaseCurrency(db, entityId));
      const invoiceId = generateId('inv');
      const itemIds = lines.map(() => generateId('ili'));
      const now = new Date();

      const drafted = await calculateDraftTax(db, {
        entityId,
        direction: 'sales',
        items: lines.map((line, idx) => ({ ...line, id: itemIds[idx], sortOrder: idx })),
        ...taxAddress(shippingAddress, billingAddress),
        runtime: salesTaxRuntimeFromEnv(c.env),
        document: {
          kind: 'invoice',
          documentId: invoiceId,
          documentNumber: invoiceNumber,
          contactId,
          issueDate: now,
          currency,
          billingAddress,
          shippingAddress,
        },
      });
      const calc = drafted.calc;
      const usInvoice = {
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
        currency,
        ...invoiceTaxColumns(calc),
        ...(drafted.ok ? {} : { taxWarnings: [engineUnavailableWarning(drafted.message)] }),
        amountPaid: '0',
        balanceDue: calc.balanceDue,
        reference: order.orderNumber,
        billingAddress,
        shippingAddress,
        commerceOrderId: orderId,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      const usItems = lines.map((line, idx) => ({
        id: itemIds[idx],
        entityId,
        invoiceId,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPercent: line.discountPercent,
        ...itemTaxColumns(calc, idx),
        productId: line.productId,
        taxCode: line.taxCode,
        sortOrder: idx,
        createdAt: now,
        updatedAt: now,
      }));
      await atomically(db, (h) => [h.insert(invoices).values(usInvoice), h.insert(invoiceItems).values(usItems)]);
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
          total: calc.total,
          currency,
          contactId,
          issueDate: now.toISOString(),
          dueDate: usInvoice.dueDate.toISOString(),
        },
      });
      return success(c, { invoiceId, invoiceNumber, taxTotal: calc.taxTotal, total: calc.total, taxWarnings: usInvoice.taxWarnings ?? [] }, 201);
    }

    // Reconstruct per-line tax rates / discount percentages from the order's
    // absolute amounts so the invoice's line-item math matches the order.
    const lineInputs = items.map((item) => {
      const qty = item.quantity || 1;
      const price = Number.parseFloat(item.unitPrice || '0');
      const gross = qty * price;
      const discountAmount = Number.parseFloat(item.discountAmount || '0');
      const net = gross - discountAmount;
      const taxAmount = Number.parseFloat(item.taxAmount || '0');
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

    const shippingTotal = Number.parseFloat(order.shippingTotal || '0');
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

    // Link each derived percentage to the entity's own sales rate when one
    // matches, so the tax reaches the tax ledger (and the return).
    const salesRates = await db
      .select({ id: schema.taxRates.id, rate: schema.taxRates.rate, type: schema.taxRates.type })
      .from(schema.taxRates)
      .where(and(eq(schema.taxRates.entityId, entityId), isNull(schema.taxRates.deletedAt), eq(schema.taxRates.isActive, true)));
    const rateFor = (percent: string) =>
      salesRates.find((r) => r.type !== 'purchase' && Math.abs(Number(r.rate) - Number(percent)) < 0.01)?.id ?? null;
    const taxedLines = lineInputs.map((line) => ({ ...line, taxRateId: rateFor(line.taxRate) }));

    const billingAddress = normalizePostalAddress(order.billingAddress ?? order.shippingAddress);
    const shippingAddress = normalizePostalAddress(order.shippingAddress);
    const totals = await calculateDocumentTax(db, {
      entityId,
      direction: 'sales',
      items: taxedLines,
      ...taxAddress(shippingAddress, billingAddress),
    });
    const { formatted: invoiceNumber } = await nextEntityNumber(db, entityId, 'invoice');
    const currency = order.currency || (await resolveEntityBaseCurrency(db, entityId));

    const invoiceId = generateId('inv');
    const now = new Date();

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
      currency,
      subtotal: totals.subtotal,
      discountTotal: totals.discountTotal,
      taxTotal: totals.taxTotal,
      total: totals.total,
      amountPaid: '0',
      balanceDue: totals.balanceDue,
      reference: order.orderNumber,
      billingAddress,
      shippingAddress,
      commerceOrderId: orderId,
      taxBreakdown: totals.taxBreakdown,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    };

    const itemRecords = taxedLines.map((item, idx) => ({
      id: generateId('ili'),
      entityId,
      invoiceId,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPercent: item.discountPercent,
      taxRateId: totals.processedItems[idx].taxRateId,
      taxRate: totals.processedItems[idx].taxRate,
      taxAmount: totals.processedItems[idx].taxAmount,
      lineTotal: totals.processedItems[idx].lineTotal,
      lineTotalWithTax: totals.processedItems[idx].lineTotalWithTax,
      productId: item.productId || null,
      sortOrder: idx,
      createdAt: now,
      updatedAt: now,
    }));

    await atomically(db, (h) => [
      h.insert(invoices).values(newInvoice),
      h.insert(invoiceItems).values(itemRecords),
    ]);

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
    const handled = accountingErrorResponse(c, err);
    if (handled) return handled;
    console.error('[app-api/invoices] from-order failed:', err);
    return error.internal(c, 'Failed to create invoice from order');
  }
});

export const invoicesRoutes = app;
