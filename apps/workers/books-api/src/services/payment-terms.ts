/**
 * The due date of an invoice made from an order: the order's counterparty's
 * payment terms (`30`, `net 14`, `30 days`), else 30 days. The Rust backend
 * does the same (`party_terms_days` in
 * `rust/modules/books-sales/src/invoices/from_order.rs`); keep them in step.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;

/** The days in payment terms written as `30`, `net 30` or `30 days`; null for anything else. */
export function parseTermsDays(terms: string | null | undefined): number | null {
  if (!terms) return null;
  const lower = terms.trim().toLowerCase();
  const rest = (lower.startsWith('net') ? lower.slice(3) : lower).trimStart();
  let end = 0;
  while (end < rest.length && rest[end] >= '0' && rest[end] <= '9') end += 1;
  const digits = rest.slice(0, end);
  const tail = rest.slice(end).trim();
  if (digits.length === 0 || digits.length > 4) return null;
  if (tail !== '' && tail !== 'day' && tail !== 'days') return null;
  const days = Number(digits);
  return days > 0 ? days : null;
}

/** When an invoice made now from an order with this counterparty is due. */
export async function orderInvoiceDueDate(
  db: Database,
  counterpartyId: string | null | undefined,
  now: Date,
): Promise<Date> {
  let days = DEFAULT_DAYS;
  if (counterpartyId) {
    const [party] = await db
      .select({ paymentTerms: schema.parties.paymentTerms })
      .from(schema.parties)
      .where(and(eq(schema.parties.id, counterpartyId), isNull(schema.parties.deletedAt)))
      .limit(1);
    days = parseTermsDays(party?.paymentTerms) ?? DEFAULT_DAYS;
  }
  return new Date(now.getTime() + days * DAY_MS);
}
