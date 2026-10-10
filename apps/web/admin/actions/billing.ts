'use server';

import { revalidatePath } from 'next/cache';
import { getAdminIdentity, guardWrite } from '@/lib/auth';
import { callBillingWorker } from '@/lib/billing-worker';
import type {
  CollectionMethod,
  InvoicePreview,
  ProrationBehavior,
  SubscriptionCycle,
  WithWarnings,
} from '@/lib/billing-types';
import type { ActionResult } from './workspaces';

/**
 * Customer billing changes from the workspace screen. Each one is performed
 * (and audited) by the billing worker; these actions only check the admin's
 * role, forward the signed-in identity and refresh the page.
 *
 * `requestId` is created once per dialog submission on the client and becomes
 * the Stripe idempotency key, so a double click cannot charge twice.
 */

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

async function workspaceWrite<T>(
  workspaceId: string,
  path: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<ActionResult<T>> {
  const guard = await guardWrite();
  if (!guard.ok) return { ok: false, error: guard.error };
  if (!REQUEST_ID.test(requestId)) return { ok: false, error: 'Invalid request id.' };

  const result = await callBillingWorker<T>(
    'POST',
    `/workspaces/${encodeURIComponent(workspaceId)}${path}`,
    { identity: guard.identity, body, requestId },
  );
  revalidatePath(`/workspaces/${workspaceId}`);
  revalidatePath('/activity');
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, code: result.code };
}

export interface SubscriptionChange {
  planId: string;
  cycle: SubscriptionCycle;
  seats: number;
  proration: ProrationBehavior;
  collectionMethod?: CollectionMethod;
  daysUntilDue?: number;
}

/** Read-only, so viewers may preview too. */
export async function previewSubscriptionChange(
  workspaceId: string,
  input: SubscriptionChange,
): Promise<ActionResult<InvoicePreview>> {
  const identity = await getAdminIdentity();
  if (!identity) return { ok: false, error: 'Not authorized' };
  const result = await callBillingWorker<InvoicePreview>(
    'POST',
    `/workspaces/${encodeURIComponent(workspaceId)}/subscription/preview`,
    { identity, body: input },
  );
  return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error, code: result.code };
}

export async function changeSubscription(
  workspaceId: string,
  input: SubscriptionChange & { reason: string },
  requestId: string,
) {
  return workspaceWrite<WithWarnings & { created: boolean; status: string }>(
    workspaceId,
    '/subscription',
    { ...input },
    requestId,
  );
}

export async function cancelSubscription(
  workspaceId: string,
  input: { mode: 'period_end' | 'immediately'; reason: string },
  requestId: string,
) {
  return workspaceWrite<{ mode: string; endsAt: string | null }>(
    workspaceId,
    '/subscription/cancel',
    input,
    requestId,
  );
}

export async function reactivateSubscription(workspaceId: string, input: { reason: string }, requestId: string) {
  return workspaceWrite<{ subscriptionId: string }>(workspaceId, '/subscription/reactivate', input, requestId);
}

export async function setTrialEnd(workspaceId: string, input: { trialEnd: string; reason: string }, requestId: string) {
  return workspaceWrite<{ trialEnd: string }>(workspaceId, '/subscription/trial', input, requestId);
}

export async function applyDiscount(
  workspaceId: string,
  input: {
    percentOff?: number;
    amountOffCents?: number;
    duration: 'once' | 'repeating' | 'forever';
    durationInMonths?: number;
    reason: string;
  },
  requestId: string,
) {
  return workspaceWrite<{ couponId: string; name: string }>(workspaceId, '/subscription/discount', input, requestId);
}

export async function removeDiscount(workspaceId: string, input: { reason: string }, requestId: string) {
  return workspaceWrite<{ subscriptionId: string }>(workspaceId, '/subscription/discount/remove', input, requestId);
}

export async function grantComp(
  workspaceId: string,
  input: { planId: string; seats: number; endsAt: string | null; cancelStripeSubscription: boolean; reason: string },
  requestId: string,
) {
  return workspaceWrite<WithWarnings & { planId: string }>(workspaceId, '/comp', input, requestId);
}

export async function endComp(workspaceId: string, input: { reason: string }, requestId: string) {
  return workspaceWrite<{ outcome: string }>(workspaceId, '/comp/end', input, requestId);
}

export async function adjustCredits(workspaceId: string, input: { amount: number; reason: string }, requestId: string) {
  return workspaceWrite<{ newBalance: number }>(workspaceId, '/credits', input, requestId);
}

export async function refundPayment(
  workspaceId: string,
  paymentId: string,
  input: { amountCents?: number; reason: string },
  requestId: string,
) {
  return workspaceWrite<{ amountCents: number; currency: string }>(
    workspaceId,
    `/payments/${encodeURIComponent(paymentId)}/refund`,
    input,
    requestId,
  );
}

export async function voidInvoice(
  workspaceId: string,
  invoiceId: string,
  input: { reason: string },
  requestId: string,
) {
  return workspaceWrite<{ status: string | null }>(
    workspaceId,
    `/invoices/${encodeURIComponent(invoiceId)}/void`,
    input,
    requestId,
  );
}
