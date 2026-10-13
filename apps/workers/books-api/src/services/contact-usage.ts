/**
 * Where an accounting contact (a `parties` row) is referenced. A contact that
 * appears on any document, payment or ledger line is part of the books and
 * can't be deleted; it can be archived instead (hidden from lists and
 * pickers, history untouched).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface ContactUsage {
  invoices: number;
  bills: number;
  payments: number;
  recurringInvoices: number;
  paymentRuns: number;
  form1099Lines: number;
  journalLines: number;
}

export type ContactUsageKey = keyof ContactUsage;

const count = sql<number>`count(*)::int`;

async function countOf(query: PromiseLike<Array<{ n: number }>>): Promise<number> {
  const [row] = await query;
  return Number(row?.n ?? 0);
}

export async function getContactUsage(db: Database, contactId: string): Promise<ContactUsage> {
  const [invoices, bills, payments, recurringInvoices, paymentRuns, form1099Lines, journalLines] = await Promise.all([
    countOf(
      db
        .select({ n: count })
        .from(schema.invoices)
        .where(and(eq(schema.invoices.contactId, contactId), isNull(schema.invoices.deletedAt))),
    ),
    countOf(
      db
        .select({ n: count })
        .from(schema.bills)
        .where(and(eq(schema.bills.contactId, contactId), isNull(schema.bills.deletedAt))),
    ),
    countOf(
      db
        .select({ n: count })
        .from(schema.payments)
        .where(and(eq(schema.payments.contactId, contactId), isNull(schema.payments.deletedAt))),
    ),
    countOf(
      db
        .select({ n: count })
        .from(schema.recurringInvoices)
        .where(and(eq(schema.recurringInvoices.contactId, contactId), isNull(schema.recurringInvoices.deletedAt))),
    ),
    countOf(
      db
        .select({ n: count })
        .from(schema.paymentRuns)
        .where(
          and(
            isNull(schema.paymentRuns.deletedAt),
            sql`${schema.paymentRuns.items} @> ${JSON.stringify([{ partyId: contactId }])}::jsonb`,
          ),
        ),
    ),
    countOf(
      db.select({ n: count }).from(schema.form1099FilingLines).where(eq(schema.form1099FilingLines.partyId, contactId)),
    ),
    countOf(
      db
        .select({ n: count })
        .from(schema.journalLines)
        .where(and(eq(schema.journalLines.contactId, contactId), isNull(schema.journalLines.deletedAt))),
    ),
  ]);
  return { invoices, bills, payments, recurringInvoices, paymentRuns, form1099Lines, journalLines };
}

/** The non-zero references only, for the error details. */
export function usedReferences(usage: ContactUsage): Partial<ContactUsage> {
  return Object.fromEntries(Object.entries(usage).filter(([, n]) => n > 0)) as Partial<ContactUsage>;
}

const LABELS: Record<ContactUsageKey, [singular: string, plural: string]> = {
  invoices: ['invoice', 'invoices'],
  bills: ['bill', 'bills'],
  payments: ['payment', 'payments'],
  recurringInvoices: ['recurring invoice', 'recurring invoices'],
  paymentRuns: ['payment run', 'payment runs'],
  form1099Lines: ['1099 filing line', '1099 filing lines'],
  journalLines: ['journal entry line', 'journal entry lines'],
};

/** "2 invoices, 1 bill and 3 payments". */
export function describeUsage(used: Partial<ContactUsage>): string {
  const parts = (Object.keys(LABELS) as ContactUsageKey[])
    .filter((key) => (used[key] ?? 0) > 0)
    .map((key) => {
      const n = used[key] ?? 0;
      return `${n} ${LABELS[key][n === 1 ? 0 : 1]}`;
    });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
