/**
 * What the payment-run route files share: request schemas, error mapping and
 * the audit-plus-event step every mutation ends with.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  ClosedPeriodError,
  LockedPeriodError,
  writeAccountingAudit,
} from '@weldsuite/books-domain/accounting-guards';
import { isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';
import { error } from '@weldsuite/worker-kit/response';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { PostingError } from '../../services/accounting-posting';
import { AccountNumberKeyError } from '../../services/accounting-bank-accounts';
import { VendorTaxKeyError } from '../../services/vendor-tax-data';
import { PaymentRunError } from '../../services/payment-runs/errors';
import { ACH_SEC_CODES } from '../../services/payment-runs/settings';
import type { RunRow } from '../../services/payment-runs/runs';

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
  .refine(isIsoDate, 'Not a real date');

const amount = z.coerce
  .number()
  .finite()
  .positive()
  .max(9_999_999_999)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, 'At most two decimals');

const runItem = z.object({ billId: z.string().min(1).max(30), amount });

export const createRunSchema = z.object({
  bankAccountId: z.string().min(1).max(30),
  method: z.enum(['check', 'ach']),
  paymentDate: day,
  /** ACH. Leave out to pick per vendor: PPD for individuals, the bank account's default for businesses. */
  secCode: z.enum(ACH_SEC_CODES).nullable().optional(),
  sameDay: z.boolean().optional(),
  items: z.array(runItem).min(1).max(1000),
  /** Default 2 for ACH and 1 for checks. Fewer than 2 on an ACH run needs banking:manage. */
  requiredApprovals: z.union([z.literal(1), z.literal(2)]).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const updateRunSchema = createRunSchema.omit({ method: true }).partial();

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const releaseHoldSchema = z.object({
  partyId: z.string().min(1).max(30),
  reason: z.string().trim().max(500).optional(),
});

export const printedSchema = z.object({ paymentIds: z.array(z.string().min(1).max(30)).min(1).max(500) });

export const voidCheckSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  reissue: z.boolean().optional(),
  /** Date of the replacement check; today when omitted. */
  date: day.optional(),
});

export const bankAccountIdQuery = z.string().min(1).max(30);

export function pageLimit(raw: string | undefined, fallback = 25, max = 100): number {
  return Math.min(Math.max(Number.parseInt(raw || String(fallback), 10) || fallback, 1), max);
}

/** The entity of the request, or the 400 to return. */
export async function requireEntity(c: AppContext, db: Database): Promise<string | Response> {
  const entityId = await resolveEntityId(c, db);
  if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
  return entityId;
}

/** Turn a service error into its response; anything unexpected is logged and answered with a 500. */
export function respondError(c: AppContext, err: unknown, label: string): Response {
  if (err instanceof PaymentRunError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof ClosedPeriodError || err instanceof LockedPeriodError || err instanceof PostingError) {
    return error.badRequest(c, err.message);
  }
  if (err instanceof VendorTaxKeyError || err instanceof AccountNumberKeyError) {
    return error.unavailable(c, err.message);
  }
  console.error(`[books-api/payment-runs] ${label} failed:`, err);
  return error.internal(c, `Failed to ${label}`);
}

/** What an entity event or audit row may say about a run: no vendor bank data, only ids and totals. */
export function runEventData(run: RunRow): Record<string, unknown> {
  return {
    id: run.id,
    method: run.method,
    status: run.status,
    bankAccountId: run.bankAccountId,
    paymentDate: run.paymentDate,
    totalAmount: run.totalAmount,
    paymentCount: run.paymentCount,
    requiredApprovals: run.requiredApprovals,
  };
}

export type RunAction = 'created' | 'updated' | 'deleted' | 'approved' | 'exported';

/** The accounting audit row of a run mutation (the entity event is published by the route). */
export async function auditRun(
  c: AppContext,
  db: Database,
  run: RunRow,
  action: string,
  changes?: Record<string, { old: unknown; new: unknown }>,
): Promise<void> {
  await writeAccountingAudit(c, db, {
    accountingEntityId: run.entityId,
    entityType: 'payment_run',
    entityId: run.id,
    action,
    ...(changes ? { changes } : {}),
  });
}

/** Entity events for the payments a run just made. */
export function publishPaymentsCreated(
  c: AppContext,
  run: RunRow,
  payments: Array<{ paymentId: string; amount: string; backupWithholdingAmount: string | null; created: boolean }>,
): void {
  for (const payment of payments) {
    if (!payment.created) continue;
    publishEntityEvent({
      c,
      entityType: 'payment',
      entityId: payment.paymentId,
      action: 'created',
      // `amount` is what the payment settles; backup withholding, when there is some, comes out of what the bank pays.
      data: {
        id: payment.paymentId,
        amount: payment.amount,
        ...(payment.backupWithholdingAmount ? { backupWithholdingAmount: payment.backupWithholdingAmount } : {}),
        date: run.paymentDate,
        method: run.method,
      },
    });
  }
}

