/**
 * Payment routes — flat /api/payments/* surface backed by `payments`.
 *
 *   - Entity scoping via resolveEntityId (header/query/default).
 *   - A payment can settle several invoices or bills (`allocations`); the
 *     single `invoiceId` / `billId` form still works.
 *   - Recording posts the payment (Dr bank / Cr receivable, or Dr payable /
 *     Cr bank) together with the documents' new paid amounts and statuses as
 *     one atomic posting (services/accounting-payments). A realized FX
 *     difference posts separately.
 *
 * Integrity rules (administratieplicht — do not weaken):
 *   - Postings are refused inside closed periods and on/before lock dates.
 *   - Deleting a payment voids it: its entry is reversed (dated today) and the
 *     documents' paid amounts are restored. Nothing is removed from the ledger.
 *   - Every mutation is written to the accounting audit log.
 *
 * US: a received check or cash payment goes to Undeposited Funds (`depositTo`
 * defaults to it when the entity has that account and no bank account is
 * named) until a bank deposit groups it (/api/bank-deposits). A check we
 * issue is created as `printed`. List filters: ?checkNumber= ?paymentMethod=
 * ?checkStatus= ?bankAccountId= ?deposited=true|false ?search=.
 *
 * Permissions: banking:read | banking:create | banking:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, isNotNull, isNull, like, lte, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import {
  ClosedPeriodError,
  LockedPeriodError,
  writeAccountingAudit,
} from '@weldsuite/books-domain/accounting-guards';
import { PostingError } from '../../services/accounting-posting';
import { recordPayment, voidPayment } from '../../services/accounting-payments';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const allocationSchema = z.object({
  invoiceId: z.string().max(30).optional(),
  billId: z.string().max(30).optional(),
  amount: z.string(),
});

const createPaymentSchema = z.object({
  type: z.enum(['received', 'sent']),
  amount: z.string(),
  currency: z.string().length(3).optional(),
  date: z.string(),
  /** check | ach | wire | credit_card | debit_card | cash | third_party_network | bank_transfer | direct_debit | ideal | other */
  paymentMethod: z.string().max(30).optional(),
  checkNumber: z.string().max(30).optional(),
  /** Received payments: park the money in Undeposited Funds, or debit the bank straight away. */
  depositTo: z.enum(['undeposited_funds', 'bank']).optional(),
  reference: z.string().max(255).optional(),
  invoiceId: z.string().optional(),
  billId: z.string().optional(),
  allocations: z.array(allocationSchema).optional(),
  contactId: z.string().min(1).optional(),
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
  const page = Math.max(Number.parseInt(q.page || '1', 10), 1);
  const pageSize = Math.min(Math.max(Number.parseInt(q.pageSize || '25', 10), 1), 100);

  try {
    const entityId = await resolveEntityId(c, db);
    // An empty tenant simply has nothing to list.
    if (!entityId) return list(c, [], cursorPagination(0, false, null));

    const conditions = [isNull(payments.deletedAt), eq(payments.entityId, entityId)];
    if (q.type) conditions.push(eq(payments.type, q.type));
    if (q.contactId) conditions.push(eq(payments.contactId, q.contactId));
    if (q.checkNumber) conditions.push(eq(payments.checkNumber, q.checkNumber.trim()));
    if (q.paymentMethod) conditions.push(eq(payments.paymentMethod, q.paymentMethod));
    if (q.checkStatus) conditions.push(eq(payments.checkStatus, q.checkStatus));
    if (q.bankAccountId) conditions.push(eq(payments.bankAccountId, q.bankAccountId));
    if (q.deposited === 'true') conditions.push(isNotNull(payments.depositId));
    if (q.deposited === 'false') conditions.push(isNull(payments.depositId));
    if (q.search) {
      const term = `%${q.search.trim()}%`;
      conditions.push(or(like(payments.reference, term), like(payments.checkNumber, term), like(payments.notes, term))!);
    }
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
    console.error('[books-api/payments] list failed:', err);
    return error.internal(c, 'Failed to fetch payments');
  }
});

// GET /:id — includes allocations
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [payment] = await db.select().from(schema.payments)
      .where(and(eq(schema.payments.id, id), isNull(schema.payments.deletedAt))).limit(1);
    if (!payment) return error.notFound(c, 'Payment', id);
    const allocations = await db.select().from(schema.paymentAllocations)
      .where(and(eq(schema.paymentAllocations.paymentId, id), isNull(schema.paymentAllocations.deletedAt)));
    return success(c, { ...payment, allocations });
  } catch (err) {
    console.error('[books-api/payments] get failed:', err);
    return error.internal(c, 'Failed to fetch payment');
  }
});

// POST /
app.post('/', requirePermission('banking:create'), zValidator('json', createPaymentSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId') ?? null;

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const amount = Number.parseFloat(data.amount);
    const allocations = data.allocations
      ? data.allocations.map((a) => ({ invoiceId: a.invoiceId, billId: a.billId, amount: Number.parseFloat(a.amount) }))
      : data.invoiceId || data.billId
        ? [{ invoiceId: data.invoiceId, billId: data.billId, amount }]
        : [];

    const result = await recordPayment(db, {
      entityId,
      type: data.type,
      amount,
      currency: data.currency ?? null,
      exchangeRate: data.exchangeRate ?? null,
      date: new Date(data.date),
      paymentMethod: data.paymentMethod ?? null,
      checkNumber: data.checkNumber ?? null,
      depositTo: data.depositTo ?? null,
      reference: data.reference ?? null,
      notes: data.notes ?? null,
      contactId: data.contactId ?? null,
      bankAccountId: data.bankAccountId ?? null,
      bankTransactionId: data.bankTransactionId ?? null,
      allocations,
      userId,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'payment',
      entityId: result.paymentId,
      action: 'created',
      changes: { journalEntryId: { old: null, new: result.journalEntryId } },
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: result.paymentId,
      action: 'created',
      data: {
        id: result.paymentId,
        amount: data.amount,
        currency: result.currency,
        invoiceId: result.documents.length === 1 && result.documents[0].type === 'invoice' ? result.documents[0].id : undefined,
        billId: result.documents.length === 1 && result.documents[0].type === 'bill' ? result.documents[0].id : undefined,
        method: data.paymentMethod,
      },
    });

    return success(c, { id: result.paymentId, journalEntryId: result.journalEntryId, undeposited: result.undeposited }, 201);
  } catch (err) {
    if (err instanceof ClosedPeriodError || err instanceof LockedPeriodError || err instanceof PostingError) {
      return error.badRequest(c, err.message);
    }
    console.error('[books-api/payments] create failed:', err);
    return error.internal(c, 'Failed to create payment');
  }
});

// DELETE /:id — void: reverse the posting and restore the documents' balances
app.delete('/:id', requirePermission('banking:delete'), async (c) => {
  const db = c.get('tenantDb');
  const paymentId = c.req.param('id');
  try {
    const payment = await voidPayment(db, paymentId, { userId: c.get('userId') ?? null });

    await writeAccountingAudit(c, db, {
      accountingEntityId: payment.entityId,
      entityType: 'payment',
      entityId: paymentId,
      action: 'deleted',
    });
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: paymentId,
      action: 'deleted',
      data: { id: paymentId, amount: payment.amount || '0', currency: payment.currency, invoiceId: payment.invoiceId, billId: payment.billId },
    });

    return noContent(c);
  } catch (err) {
    if (err instanceof PostingError && err.message === 'Payment not found') {
      return error.notFound(c, 'Payment', paymentId);
    }
    if (err instanceof ClosedPeriodError || err instanceof LockedPeriodError || err instanceof PostingError) {
      return error.badRequest(c, err.message);
    }
    console.error('[books-api/payments] delete failed:', err);
    return error.internal(c, 'Failed to delete payment');
  }
});

export const paymentsRoutes = app;
