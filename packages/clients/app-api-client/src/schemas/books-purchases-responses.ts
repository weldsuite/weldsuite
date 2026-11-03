/**
 * Response shapes of books-api's purchases area (WeldBooks): accounting
 * contacts (customers and suppliers), the accounting document inbox, bills
 * and online W-9 requests.
 *
 * The platform reads these through TypeScript interfaces
 * (`apps/web/platform/lib/api/domains/weldbooks.ts` and its neighbours); these
 * Zod schemas mirror them so the Rust backend's answers are checked against
 * the same shapes (`packages/core/worker-kit/src/testing/conformance-schemas-books-purchases.ts`).
 * Rows are `.passthrough()`: the routes answer whole table rows (or the
 * object they wrote), and the schemas pin the fields the clients read.
 * Drizzle reads `numeric` columns as strings and `timestamp` columns as ISO
 * strings.
 */

import { z } from 'zod';

const nullableString = z.string().nullable();
const nullishString = z.string().nullish();

// ── accounting contacts ─────────────────────────────────────────────────────

const contactPersonSchema = z.object({
  personId: z.string(),
  name: nullishString,
  firstName: nullableString,
  lastName: nullableString,
  email: nullableString,
  phone: nullableString,
});

/**
 * A contact as the routes answer it (`toContactView`): the party's
 * accounting columns, the wrapped company's or person's identity facts and
 * the vendor tax fields that are safe to show. Never the sealed TIN or ACH
 * account number.
 */
export const accountingContactSchema = z
  .object({
    id: z.string(),
    kind: nullishString,
    companyId: nullishString,
    personId: nullishString,
    role: nullishString,
    name: z.string(),
    companyName: nullableString,
    firstName: nullableString,
    lastName: nullableString,
    email: nullableString,
    phone: nullableString,
    contactPerson: contactPersonSchema.nullable(),
    vatNumber: nullableString,
    registrationNumber: nullableString,
    taxNumber: nullableString,
    kvkNumber: nullableString,
    notes: nullableString,
    paymentTermsDays: z.number().nullable(),
    billingAddress: z.record(z.unknown()).nullable(),
    shippingAddress: z.record(z.unknown()).nullable(),
    outstandingBalance: nullishString,
    archivedAt: nullishString,
    hasTin: z.boolean(),
    tinMasked: nullableString,
    hasAchAccount: z.boolean(),
    bankDetailsNeedVerification: z.boolean(),
  })
  .passthrough()
  .refine((row) => !('sensitiveEncrypted' in row), { message: 'the sealed vendor data must not leave the worker' });

const balanceSideSchema = z.object({ totalOutstanding: z.string(), totalOverdue: z.string() });

/** `GET /api/accounting-contacts/:id/balance`. */
export const contactBalanceSchema = z.object({ receivable: balanceSideSchema, payable: balanceSideSchema });

/** `POST /api/accounting-contacts/import-from-crm`. */
export const contactImportSchema = z.object({ imported: z.number(), message: z.string() });

/** `POST /api/accounting-contacts/:id/promote-role`. */
export const promotedRoleSchema = z.object({ id: z.string(), role: z.string(), changed: z.boolean() });

/** `POST /api/accounting-contacts/:id/reveal-tin`. */
export const revealedTinSchema = z.object({ tin: z.string(), tinType: nullableString });

/** `POST /api/accounting-contacts/:id/reveal-ach-account`. */
export const revealedAchAccountSchema = z.object({
  achAccountNumber: z.string(),
  achRoutingNumber: nullableString,
  achAccountType: nullableString,
});

/** A `tax_id_reveals` row: who looked at a TIN or account number, and when. */
export const taxIdRevealSchema = z
  .object({
    id: z.string(),
    subjectType: z.string(),
    subjectId: z.string(),
    field: z.string(),
    revealedBy: z.string(),
    reason: nullableString,
    createdAt: z.string(),
  })
  .passthrough();

// ── documents ───────────────────────────────────────────────────────────────

/** A `documents` row (the accounting inbox), or the one a create wrote. */
export const accountingDocumentSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    fileName: z.string(),
    fileKey: z.string(),
    status: z.string(),
    source: z.string(),
    mimeType: nullishString,
  })
  .passthrough();

/** `GET /api/accounting-documents/stats`: one row per status. */
export const documentStatusCountSchema = z.object({ status: nullableString, count: z.number() });

/** `POST /api/accounting-documents/:id/rematch`. */
export const documentRematchSchema = z.object({ id: z.string(), matchedContactId: nullableString });

/** `PATCH /api/accounting-documents/:id/link`. */
export const documentLinkedSchema = z.object({ id: z.string(), status: z.literal('linked') });

/** `PATCH /api/accounting-documents/:id/reject`. */
export const documentRejectedSchema = z.object({ message: z.string() });

// ── bills ───────────────────────────────────────────────────────────────────

/** A bill line as stored, or the record a create or edit wrote. */
export const billItemSchema = z
  .object({
    id: z.string(),
    billId: z.string(),
    description: z.string(),
    quantity: nullishString,
    unitPrice: z.string(),
    taxAmount: nullishString,
    lineTotal: nullishString,
    lineTotalWithTax: nullishString,
  })
  .passthrough();

/** A `bills` row, or the bill a route answers (the row with its changes). */
export const billSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    billNumber: nullishString,
    status: z.string(),
    contactId: nullishString,
    contactName: nullishString,
    issueDate: z.string(),
    dueDate: nullishString,
    currency: nullishString,
    subtotal: nullishString,
    taxTotal: nullishString,
    total: nullishString,
    balanceDue: nullishString,
    approvalStatus: nullishString,
    items: z.array(billItemSchema).optional(),
  })
  .passthrough();

/** `GET /api/bills/:id`: the bill with its live lines and payments. */
export const billDetailSchema = billSchema.and(
  z.object({ items: z.array(billItemSchema), payments: z.array(z.record(z.unknown())) }).passthrough(),
);

/** `POST /api/bills/from-document/:documentId`: what the form pre-fills. */
export const billPrefillSchema = z
  .object({
    contactName: nullableString,
    externalReference: z.unknown(),
    issueDate: z.unknown(),
    dueDate: z.unknown(),
    currency: z.unknown(),
    items: z.array(
      z.object({
        description: z.unknown(),
        quantity: z.string(),
        unitPrice: z.string(),
        taxRate: nullableString,
        sortOrder: z.number(),
      }),
    ),
    sourceDocumentId: z.string(),
    matchedContactId: nullableString,
    confidence: z.object({ overall: z.number() }).passthrough(),
  })
  .passthrough();

// ── W-9 requests ────────────────────────────────────────────────────────────

/** A W-9 request without its token hash (a pending one past its date reads `expired`). */
export const w9RequestSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    partyId: z.string(),
    email: nullableString,
    status: z.enum(['pending', 'completed', 'expired', 'cancelled']),
    expiresAt: z.string(),
    completedAt: nullableString,
  })
  .passthrough()
  .refine((row) => !('tokenHash' in row), { message: 'the token hash must not leave the worker' });

/** `POST /api/w9-requests`: the request and its link, shown once. */
export const createdW9RequestSchema = z.object({
  request: w9RequestSchema,
  url: z.string(),
  emailSent: z.boolean(),
});
