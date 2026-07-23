/**
 * Payment routes — flat /api/payments/* surface backed by `payments`.
 *
 * Ported from apps/api-worker/src/routes/accounting/payments.ts:
 *   - Entity scoping via resolveEntityId (header/query/default).
 *   - Invoice/bill balance settlement (amountPaid/balanceDue/status/paidAt).
 *   - Realized FX gain/loss journal posting when the payment rate differs
 *     from the invoice/bill booking rate.
 *
 * Integrity rules (administratieplicht — do not weaken):
 *   - Creating a payment is blocked when its date falls in a closed period.
 *   - Deleting a payment dated inside a closed period is blocked.
 *   - Every mutation is written to the accounting audit log.
 *
 * Permissions: banking:read | banking:create | banking:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema, type Database } from '../../db';
import { nextEntityNumber, resolveEntityId } from '../../lib/entity-context';
import { calculateFxGainLoss } from '../../services/accounting-currency';
import {
  assertPeriodOpen,
  ClosedPeriodError,
  writeAccountingAudit,
} from '../../services/accounting-guards';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const createPaymentSchema = z.object({
  type: z.enum(['received', 'sent']),
  amount: z.string(),
  currency: z.string().length(3).optional(),
  date: z.string(),
  paymentMethod: z.string().max(20).optional(),
  reference: z.string().max(255).optional(),
  invoiceId: z.string().optional(),
  billId: z.string().optional(),
  contactId: z.string().min(1),
  bankAccountId: z.string().optional(),
  bankTransactionId: z.string().optional(),
  notes: z.string().optional(),
  exchangeRate: z.string().optional(),
});

// GET /
app.get('/', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const { payments } = schema;
  const q = c.req.query();
  const page = Math.max(parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(parseInt(q.pageSize || '25', 10), 1), 100);

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const conditions = [isNull(payments.deletedAt), eq(payments.entityId, entityId)];
    if (q.type) conditions.push(eq(payments.type, q.type));
    if (q.contactId) conditions.push(eq(payments.contactId, q.contactId));
    if (q.from) conditions.push(gte(payments.date, new Date(q.from)));
    if (q.to) conditions.push(lte(payments.date, new Date(q.to)));

    const where = and(...conditions);
    const [rows, countRes] = await Promise.all([
      db.select().from(payments).where(where).orderBy(desc(payments.date))
        .limit(pageSize).offset((page - 1) * pageSize),
      db.select({ count: sql<number>`count(*)::int` }).from(payments).where(where),
    ]);
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, rows, cursorPagination(totalCount, page * pageSize < totalCount, null));
  } catch (err) {
    console.error('[app-api/payments] list failed:', err);
    return error.internal(c, 'Failed to fetch payments');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [payment] = await db.select().from(schema.payments)
      .where(and(eq(schema.payments.id, id), isNull(schema.payments.deletedAt))).limit(1);
    if (!payment) return error.notFound(c, 'Payment', id);
    return success(c, payment);
  } catch (err) {
    console.error('[app-api/payments] get failed:', err);
    return error.internal(c, 'Failed to fetch payment');
  }
});

// POST /
app.post('/', requirePermission('banking:create'), zValidator('json', createPaymentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');

  try {
    const { payments, invoices, bills } = schema;

    const paymentAmount = parseFloat(data.amount);
    const paymentId = generateId('pay');

    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    // Payments book a financial mutation — blocked inside closed fiscal periods.
    await assertPeriodOpen(db, entityId, data.date);

    const paymentExchangeRate = data.exchangeRate ?? '1';

    await db.insert(payments).values({
      id: paymentId,
      entityId,
      type: data.type,
      amount: data.amount,
      currency: data.currency || 'EUR',
      exchangeRate: paymentExchangeRate,
      date: new Date(data.date),
      paymentMethod: data.paymentMethod || null,
      reference: data.reference || null,
      invoiceId: data.invoiceId || null,
      billId: data.billId || null,
      contactId: data.contactId,
      bankAccountId: data.bankAccountId || null,
      bankTransactionId: data.bankTransactionId || null,
      notes: data.notes || null,
      isPartial: false,
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Update invoice/bill balance if linked
    if (data.invoiceId) {
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, data.invoiceId)).limit(1);
      if (invoice) {
        const newAmountPaid = parseFloat(invoice.amountPaid || '0') + paymentAmount;
        const newBalanceDue = parseFloat(invoice.total || '0') - newAmountPaid;
        const isFullyPaid = newBalanceDue <= 0.01;
        await db.update(invoices).set({
          amountPaid: newAmountPaid.toFixed(2),
          balanceDue: Math.max(0, newBalanceDue).toFixed(2),
          status: isFullyPaid ? 'paid' : 'partial',
          paidAt: isFullyPaid ? new Date() : null,
          updatedAt: new Date(),
        }).where(eq(invoices.id, data.invoiceId));

        // Update payment isPartial
        if (!isFullyPaid) {
          await db.update(payments).set({ isPartial: true }).where(eq(payments.id, paymentId));
        }
      }
    }

    if (data.billId) {
      const [bill] = await db.select().from(bills).where(eq(bills.id, data.billId)).limit(1);
      if (bill) {
        const newAmountPaid = parseFloat(bill.amountPaid || '0') + paymentAmount;
        const newBalanceDue = parseFloat(bill.total || '0') - newAmountPaid;
        const isFullyPaid = newBalanceDue <= 0.01;
        await db.update(bills).set({
          amountPaid: newAmountPaid.toFixed(2),
          balanceDue: Math.max(0, newBalanceDue).toFixed(2),
          status: isFullyPaid ? 'paid' : 'partial',
          paidAt: isFullyPaid ? new Date() : null,
          updatedAt: new Date(),
        }).where(eq(bills.id, data.billId));
      }
    }

    // Realized FX gain/loss — post a journal entry for the delta when the payment rate
    // differs from the invoice/bill rate (foreign-currency settlement).
    await maybePostFxAdjustment(db, {
      entityId,
      paymentId,
      paymentAmountForeign: paymentAmount,
      paymentExchangeRate,
      paymentDate: new Date(data.date),
      type: data.type,
      invoiceId: data.invoiceId,
      billId: data.billId,
      contactId: data.contactId,
      createdBy: userId,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'payment',
      entityId: paymentId,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: paymentId,
      action: 'created',
      data: { id: paymentId, amount: data.amount, currency: data.currency, invoiceId: data.invoiceId, billId: data.billId, method: data.paymentMethod },
    });

    return success(c, { id: paymentId }, 201);
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/payments] create failed:', err);
    return error.internal(c, 'Failed to create payment');
  }
});

/**
 * Post a realized FX gain/loss journal entry when the settlement exchange rate
 * differs from the rate the invoice/bill was booked at. The delta clears the
 * residual AR (for received payments) or AP (for sent payments) balance.
 *
 * No-op when the linked document is in base currency or its stored rate matches
 * the payment rate, or when the entity's CoA is missing the FX gain/loss system
 * accounts (which should only happen if seedDefaults was disabled at entity creation).
 */
async function maybePostFxAdjustment(
  db: Database,
  args: {
    entityId: string;
    paymentId: string;
    paymentAmountForeign: number;
    paymentExchangeRate: string;
    paymentDate: Date;
    type: 'received' | 'sent';
    invoiceId?: string;
    billId?: string;
    contactId: string;
    createdBy?: string;
  },
): Promise<void> {
  const paymentRate = parseFloat(args.paymentExchangeRate);
  if (!paymentRate || paymentRate === 0) return;

  // Load the settled document to fetch its booking rate.
  let docRate = 1;
  if (args.invoiceId) {
    const [inv] = await db
      .select({ rate: schema.invoices.exchangeRate })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, args.invoiceId))
      .limit(1);
    if (!inv) return;
    docRate = parseFloat(inv.rate ?? '1');
  } else if (args.billId) {
    const [bill] = await db
      .select({ rate: schema.bills.exchangeRate })
      .from(schema.bills)
      .where(eq(schema.bills.id, args.billId))
      .limit(1);
    if (!bill) return;
    docRate = parseFloat(bill.rate ?? '1');
  } else {
    return;
  }

  if (!docRate || docRate === paymentRate) return;

  const delta = calculateFxGainLoss(args.paymentAmountForeign, paymentRate, docRate);
  if (Math.abs(delta) < 0.01) return;

  // Look up the FX + AR/AP system accounts by metadata.systemRole (seeded by the
  // jurisdiction adapter). Accounts are entity-scoped.
  const entityAccounts = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, args.entityId), isNull(schema.accounts.deletedAt)));

  const byRole = (role: string) =>
    entityAccounts.find((a) => (a.metadata as { systemRole?: string } | null)?.systemRole === role);

  const fxGainAccount = byRole('realized_fx_gain');
  const fxLossAccount = byRole('realized_fx_loss');
  const arAccount = byRole('accounts_receivable');
  const apAccount = byRole('accounts_payable');

  const isGain = delta > 0;
  const absDelta = Math.abs(delta).toFixed(2);

  // Pick the FX account and the settlement-side account based on gain vs loss and type.
  const fxAccount = isGain ? fxGainAccount : fxLossAccount;
  const settlementAccount = args.type === 'received' ? arAccount : apAccount;
  if (!fxAccount || !settlementAccount) return; // missing CoA entries, bail safely

  // Build the entry. Sign convention:
  //  - Received + gain  → Debit AR, Credit FX Gain   (AR was under-booked)
  //  - Received + loss  → Debit FX Loss, Credit AR
  //  - Sent + gain      → Debit AP, Credit FX Gain   (we owed less in base)
  //  - Sent + loss      → Debit FX Loss, Credit AP
  const debitAccountId = isGain ? settlementAccount.id : fxAccount.id;
  const creditAccountId = isGain ? fxAccount.id : settlementAccount.id;

  const { formatted: entryNumber } = await nextEntityNumber(db, args.entityId, 'journal');

  const journalEntryId = generateId('je');
  const now = new Date();
  await db.insert(schema.journalEntries).values({
    id: journalEntryId,
    entityId: args.entityId,
    entryNumber,
    date: args.paymentDate,
    status: 'posted',
    description: `FX ${isGain ? 'gain' : 'loss'} on payment ${args.paymentId}`,
    sourceType: 'payment_fx_adjustment',
    sourceId: args.paymentId,
    totalDebit: absDelta,
    totalCredit: absDelta,
    isAutomatic: true,
    createdBy: args.createdBy,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.journalLines).values([
    {
      id: generateId('jl'),
      entityId: args.entityId,
      journalEntryId,
      accountId: debitAccountId,
      description: `FX ${isGain ? 'gain' : 'loss'} adjustment`,
      debit: absDelta,
      credit: '0',
      contactId: args.contactId,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: generateId('jl'),
      entityId: args.entityId,
      journalEntryId,
      accountId: creditAccountId,
      description: `FX ${isGain ? 'gain' : 'loss'} adjustment`,
      debit: '0',
      credit: absDelta,
      contactId: args.contactId,
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    },
  ]);

  // Link the adjustment back onto the payment row for traceability.
  await db
    .update(schema.payments)
    .set({ exchangeDifferenceEntryId: journalEntryId, updatedAt: now })
    .where(eq(schema.payments.id, args.paymentId));
}

// DELETE /:id
app.delete('/:id', requirePermission('banking:delete'), async (c) => {
  const db = c.get('tenantDb');
  const paymentId = c.req.param('id');
  try {
    const [existing] = await db.select().from(schema.payments)
      .where(and(eq(schema.payments.id, paymentId), isNull(schema.payments.deletedAt))).limit(1);
    if (!existing) return error.notFound(c, 'Payment', paymentId);

    // Removing a payment dated inside a closed period would mutate a closed
    // administration — blocked.
    await assertPeriodOpen(db, existing.entityId, existing.date ?? new Date());

    await db.update(schema.payments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.payments.id, paymentId));

    await writeAccountingAudit(c, db, {
      accountingEntityId: existing.entityId,
      entityType: 'payment',
      entityId: paymentId,
      action: 'deleted',
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: paymentId,
      action: 'deleted',
      data: { id: paymentId, amount: existing.amount || '0', invoiceId: existing.invoiceId, billId: existing.billId },
    });

    return noContent(c);
  } catch (err) {
    if (err instanceof ClosedPeriodError) return error.badRequest(c, err.message);
    console.error('[app-api/payments] delete failed:', err);
    return error.internal(c, 'Failed to delete payment');
  }
});

export const paymentsRoutes = app;
