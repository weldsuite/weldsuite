/**
 * Response shapes of books-api's sales area (WeldBooks): invoices, credit
 * notes, payments, recurring invoices and invoice templates.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks*.ts`: `Invoice`,
 * `InvoiceDetail`, `Payment`, `RecurringInvoice`, `GeneratedRecurringInvoice`,
 * `InvoiceTemplate`); these Zod schemas mirror them so the Rust backend's
 * answers are checked against the same shapes
 * (`packages/core/worker-kit/src/testing/conformance-schemas-books-sales.ts`).
 * Rows are `.passthrough()`: the routes answer whole rows, and the schemas pin
 * the fields the clients read.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();

/** A `tax_breakdown` row as the invoice lists read it. */
const taxBreakdownRowSchema = z
  .object({
    taxRateId: z.string(),
    taxRateName: z.string(),
    taxRate: z.number(),
    taxableAmount: z.number(),
    taxAmount: z.number(),
    component: z.string().optional(),
    accountRole: z.string().optional(),
  })
  .passthrough();

/** An `invoices` row (`Invoice`). */
export const invoiceSchema = z
  .object({
    id: z.string(),
    templateId: nullableString.optional(),
    invoiceNumber: nullableString,
    type: z.string(),
    status: z.string(),
    contactId: z.string(),
    contactName: nullableString,
    contactEmail: nullableString,
    issueDate: z.string(),
    dueDate: z.string(),
    currency: nullableString,
    exchangeRate: nullableString.optional(),
    subtotal: nullableString,
    taxTotal: nullableString,
    total: nullableString,
    amountPaid: nullableString,
    balanceDue: nullableString,
    reference: nullableString,
    notes: nullableString,
    internalNotes: nullableString,
    createdAt: z.string(),
    attachmentKeys: z.array(z.string()).nullable().optional(),
    taxBreakdown: z.array(taxBreakdownRowSchema).nullable().optional(),
  })
  .passthrough();

/** An `invoice_items` row. */
export const invoiceItemSchema = z
  .object({
    id: z.string(),
    invoiceId: z.string(),
    description: z.string(),
    quantity: nullableString,
    unitPrice: z.string(),
    unit: nullableString,
    discountPercent: nullableString,
    taxRateId: nullableString,
    taxRate: nullableString,
    taxAmount: nullableString,
    lineTotal: nullableString,
    lineTotalWithTax: nullableString,
    accountId: nullableString,
    sortOrder: z.number().nullable(),
  })
  .passthrough();

/** A `payments` row (`Payment`). */
export const paymentSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    amount: z.string(),
    date: z.string(),
    paymentMethod: nullableString,
    checkNumber: nullableString.optional(),
    reference: nullableString,
    invoiceId: nullableString,
    billId: nullableString,
    contactId: z.string(),
  })
  .passthrough();

/** `GET /api/invoices`: the rows with the number of the invoice a credit note credits. */
export const invoiceListItemSchema = invoiceSchema.extend({ creditNoteForInvoiceNumber: nullableString });

/** `POST /api/invoices`, `PUT|PATCH /api/invoices/:id`: the invoice (with its new lines). */
export const invoiceWithItemsSchema = invoiceSchema.extend({ items: z.array(invoiceItemSchema).optional() });

/** `GET /api/invoices/:id` (`InvoiceDetail`). */
export const invoiceDetailSchema = invoiceSchema.extend({
  items: z.array(invoiceItemSchema.extend({ originalLineId: nullableString.optional() })),
  payments: z.array(paymentSchema.extend({ allocatedAmount: z.string() })),
  creditNotes: z
    .array(z.object({ id: z.string(), invoiceNumber: nullableString, status: z.string(), issueDate: z.string(), total: nullableString }))
    .optional(),
});

/** `DELETE /api/invoices/:id`. */
export const invoiceDeletedSchema = z.object({ message: z.string() });

/** `PATCH /api/invoices/:id/send`. */
export const invoiceSentSchema = invoiceSchema.extend({ sentAt: z.string(), journalEntryId: nullableString });

/** A credit note applied to an invoice (`CreditApplication`). */
const creditApplicationSchema = z.object({ creditNoteId: z.string(), invoiceId: z.string(), amount: z.number() });

/** The provider tax sync (`ProviderSyncResult`). */
export const providerSyncSchema = z.object({
  status: z.enum(['committed', 'reversed', 'already_synced', 'not_applicable', 'failed']),
  ref: z.string().optional(),
  warning: z.string().optional(),
});

/** `POST /api/invoices/:id/finalize`. */
export const invoiceFinalizedSchema = z.object({
  invoiceId: z.string(),
  journalEntryId: nullableString,
  entryNumber: nullableString,
  creditApplied: creditApplicationSchema.nullable(),
  status: z.literal('finalized'),
  warnings: z.array(z.string()),
  taxSync: providerSyncSchema.nullable(),
});

/** `POST /api/invoices/:id/duplicate` and `/credit-note`. */
export const invoiceCreatedSchema = z.object({ id: z.string(), invoiceNumber: z.string() });

/** `POST /api/invoices/:id/record-payment`. */
export const invoicePaymentRecordedSchema = z.object({
  paymentId: z.string(),
  journalEntryId: nullableString,
  amountPaid: nullableString,
  balanceDue: nullableString,
  status: nullableString,
});

/** `POST /api/invoices/:id/apply-credit`. */
export const creditAppliedSchema = z.object({
  creditNoteId: z.string(),
  invoiceId: z.string(),
  amount: z.string(),
  creditNote: z.object({ balanceDue: nullableString, status: z.string() }),
});

/** `POST /api/invoices/from-order/:orderId` (a US invoice also answers its tax). */
export const invoiceFromOrderSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  taxTotal: z.string().optional(),
  total: z.string().optional(),
  taxWarnings: z.array(z.string()).optional(),
});

/** `GET /api/payments/:id`: the payment with its allocations. */
export const paymentDetailSchema = paymentSchema.extend({
  allocations: z.array(
    z.object({ id: z.string(), paymentId: z.string(), invoiceId: nullableString, billId: nullableString, amount: z.string() }).passthrough(),
  ),
});

/** `POST /api/payments`. */
export const paymentCreatedSchema = z.object({ id: z.string(), journalEntryId: nullableString, undeposited: z.boolean() });

/** A `recurring_invoices` row (`RecurringInvoice`). */
export const recurringInvoiceSchema = z
  .object({
    id: z.string(),
    name: nullableString.optional(),
    contactId: z.string(),
    frequency: z.string(),
    dayOfMonth: z.number().nullable().optional(),
    nextIssueDate: z.string(),
    endDate: nullableString,
    status: z.string(),
    templateData: z.record(z.unknown()).nullable().optional(),
    autoSend: z.boolean().nullable().optional(),
    autoFinalize: z.boolean().nullable().optional(),
    generatedCount: z.number().nullable(),
    lastGeneratedAt: nullableString.optional(),
    lastGeneratedInvoiceId: nullableString.optional(),
  })
  .passthrough();

/** `PATCH /api/recurring-invoices/:id/pause` and `/resume`. */
export const recurringStatusSchema = z.object({ status: z.enum(['paused', 'active']) });

/** `POST /api/recurring-invoices/:id/generate` (`GeneratedRecurringInvoice`). */
export const generatedRecurringInvoiceSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  nextIssueDate: z.string(),
  status: z.enum(['active', 'completed']),
  journalEntryId: nullableString,
  finalizeError: nullableString,
});

/** A stored invoice template (`InvoiceTemplate`). */
export const invoiceTemplateSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  document: z
    .object({
      version: z.literal(1),
      paperSize: z.enum(['a4', 'letter']),
      blocks: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()),
    })
    .passthrough(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
