/**
 * Generating the next invoice of a recurring schedule — from the
 * POST /:id/generate route or the daily books-api cron.
 *
 * The schedule is claimed first: `nextIssueDate` moves forward only if it
 * still holds the value we read, so two runs (a double click, a retry, the
 * cron racing a user) can never bill the same period twice. The invoice gets
 * the same server-side tax calculation as a manual one, and schedules with
 * `autoFinalize` are finalized (posted) straight away.
 */

import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { normalizePostalAddress } from '@weldsuite/books-domain/accounting-address';
import { nextEntityNumber, resolveEntityBaseCurrency } from '../lib/entity-context';
import { calculateDocumentTax } from './accounting-tax-resolve';
import { finalizeInvoice } from './accounting-invoice-finalize';
import { PostingError } from './accounting-posting';

export const recurringTemplateSchema = z.object({
  items: z.array(z.object({
    description: z.string(),
    quantity: z.number(),
    unitPrice: z.number(),
    unit: z.string().optional(),
    taxRateId: z.string().nullable().optional(),
    accountId: z.string().nullable().optional(),
  })).optional(),
  notes: z.string().optional(),
  internalNotes: z.string().optional(),
  paymentTermsDays: z.number().optional(),
  revenueAccountId: z.string().optional(),
  reference: z.string().optional(),
  currency: z.string().length(3).optional(),
});

export type RecurringTemplateData = z.infer<typeof recurringTemplateSchema>;

type RecurringRow = typeof schema.recurringInvoices.$inferSelect;

export class RecurringAlreadyGeneratedError extends Error {
  constructor() {
    super('This period was already generated — reload the schedule to see its next issue date.');
    this.name = 'RecurringAlreadyGeneratedError';
  }
}

export function nextScheduleDate(from: Date, frequency: string): Date {
  const next = new Date(from);
  switch (frequency) {
    case 'weekly': next.setDate(next.getDate() + 7); break;
    case 'biweekly': next.setDate(next.getDate() + 14); break;
    case 'monthly': next.setMonth(next.getMonth() + 1); break;
    case 'quarterly': next.setMonth(next.getMonth() + 3); break;
    case 'biannually': next.setMonth(next.getMonth() + 6); break;
    case 'yearly': next.setFullYear(next.getFullYear() + 1); break;
  }
  return next;
}

export interface GeneratedRecurringInvoice {
  invoiceId: string;
  invoiceNumber: string;
  nextIssueDate: Date;
  status: 'active' | 'completed';
  journalEntryId: string | null;
  /** Set when autoFinalize was on but finalizing failed; the invoice stays a draft. */
  finalizeError: string | null;
}

export async function generateRecurringInvoice(
  db: Database,
  rec: RecurringRow,
  opts: { userId: string | null; now?: Date },
): Promise<GeneratedRecurringInvoice> {
  if (rec.status !== 'active') throw new PostingError('Recurring invoice is not active');
  const now = opts.now ?? new Date();
  const entityId = rec.entityId;

  const nextDate = nextScheduleDate(rec.nextIssueDate, rec.frequency);
  const newStatus: 'active' | 'completed' = rec.endDate && nextDate > new Date(rec.endDate) ? 'completed' : 'active';

  // Claim the period. Only the request that still sees the old nextIssueDate wins.
  const claimed = await db
    .update(schema.recurringInvoices)
    .set({ nextIssueDate: nextDate, status: newStatus, updatedAt: now })
    .where(and(eq(schema.recurringInvoices.id, rec.id), eq(schema.recurringInvoices.nextIssueDate, rec.nextIssueDate)))
    .returning({ id: schema.recurringInvoices.id });
  if (claimed.length === 0) throw new RecurringAlreadyGeneratedError();

  const parsed = recurringTemplateSchema.safeParse(rec.templateData ?? {});
  const template: RecurringTemplateData = parsed.success ? parsed.data : {};
  const currency =
    (typeof template.currency === 'string' && template.currency) || (await resolveEntityBaseCurrency(db, entityId));
  const items = template.items ?? [];
  const paymentTermsDays = template.paymentTermsDays || 30;

  const [contact] = await db
    .select({ displayName: schema.parties.displayName, billingAddress: schema.parties.billingAddress, shippingAddress: schema.parties.shippingAddress })
    .from(schema.parties)
    .where(and(eq(schema.parties.id, rec.contactId), isNull(schema.parties.deletedAt)))
    .limit(1);
  const billingAddress = normalizePostalAddress(contact?.billingAddress);
  const shippingAddress = normalizePostalAddress(contact?.shippingAddress);
  const taxAddress = shippingAddress ?? billingAddress;

  const lines = items.map((item) => ({
    quantity: String(item.quantity || 1),
    unitPrice: String(item.unitPrice || 0),
    discountPercent: '0',
    taxRateId: item.taxRateId ?? null,
  }));
  const totals = await calculateDocumentTax(db, {
    entityId,
    direction: 'sales',
    items: lines,
    buyerCountry: taxAddress?.country,
    billingProvince: taxAddress?.state,
  });

  const { formatted: invoiceNumber } = await nextEntityNumber(db, entityId, 'invoice');
  const invoiceId = generateId('inv');
  const issueDate = now;
  const dueDate = new Date(issueDate.getTime() + paymentTermsDays * 24 * 60 * 60 * 1000);

  const invoiceRow = {
    id: invoiceId,
    entityId,
    invoiceNumber,
    type: 'standard',
    status: 'draft',
    contactId: rec.contactId,
    contactName: contact?.displayName || null,
    contactEmail: null,
    issueDate,
    dueDate,
    currency,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    amountPaid: '0',
    balanceDue: totals.balanceDue,
    taxBreakdown: totals.taxBreakdown,
    paymentTermsDays,
    reference: template.reference || null,
    notes: template.notes || null,
    internalNotes: template.internalNotes || null,
    billingAddress,
    shippingAddress,
    revenueAccountId: template.revenueAccountId || null,
    recurringInvoiceId: rec.id,
    createdBy: opts.userId,
    createdAt: now,
    updatedAt: now,
  };
  const itemRows = items.map((item, idx) => ({
    id: generateId('ili'),
    entityId,
    invoiceId,
    description: item.description,
    quantity: lines[idx].quantity,
    unitPrice: lines[idx].unitPrice,
    unit: item.unit || null,
    discountPercent: '0',
    taxRateId: totals.processedItems[idx].taxRateId,
    taxRate: totals.processedItems[idx].taxRate,
    taxAmount: totals.processedItems[idx].taxAmount,
    lineTotal: totals.processedItems[idx].lineTotal,
    lineTotalWithTax: totals.processedItems[idx].lineTotalWithTax,
    accountId: item.accountId || template.revenueAccountId || null,
    sortOrder: idx,
    createdAt: now,
    updatedAt: now,
  }));

  await atomically(db, (h) => [
    h.insert(schema.invoices).values(invoiceRow),
    ...(itemRows.length > 0 ? [h.insert(schema.invoiceItems).values(itemRows)] : []),
    h
      .update(schema.recurringInvoices)
      .set({
        generatedCount: (rec.generatedCount || 0) + 1,
        lastGeneratedAt: now,
        lastGeneratedInvoiceId: invoiceId,
        updatedAt: now,
      })
      .where(eq(schema.recurringInvoices.id, rec.id)),
  ]);

  let journalEntryId: string | null = null;
  let finalizeError: string | null = null;
  if (rec.autoFinalize && itemRows.length > 0) {
    try {
      const finalized = await finalizeInvoice(db, invoiceId, { userId: opts.userId, markSent: rec.autoSend ?? false });
      journalEntryId = finalized.journalEntryId;
    } catch (err) {
      // The invoice exists as a draft; someone has to look at it (missing VAT number, locked period, …).
      finalizeError = err instanceof Error ? err.message : String(err);
    }
  }

  return { invoiceId, invoiceNumber, nextIssueDate: nextDate, status: newStatus, journalEntryId, finalizeError };
}
