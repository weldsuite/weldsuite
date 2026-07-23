/**
 * Accounting contact-role promotion.
 *
 * Ported from api-worker `src/routes/accounting/promote-role.ts` (W3
 * legacy-worker phase-out). This is the canonical home for the helper.
 *
 * NOTE: `routes/invoices/index.ts` and `routes/bills/index.ts` each carry an
 * identical inline copy (ported earlier). When those files are next touched,
 * swap their inline copies for this import — they were deliberately left
 * untouched during the W3 port to avoid cross-agent file conflicts.
 *
 * Auto-promote a contact's `role` when it gets its first invoice or bill.
 * Idempotent — callers can invoke unconditionally after creating an
 * invoice/bill and the role only moves forward:
 *
 *   none     + customer → customer
 *   none     + supplier → supplier
 *   customer + supplier → both
 *   supplier + customer → both
 *   both     + *        → both (no-op)
 *
 * Read-modify-write is fine here since contacts are low-churn and the write
 * is conditional. No-op if the contact already has the role.
 */

import { eq } from 'drizzle-orm';
import { schema, type Database } from '../db';

export async function promoteAccountingRole(
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
