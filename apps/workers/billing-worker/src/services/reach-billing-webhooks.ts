/**
 * Stripe webhooks for the WeldReach inbox subscription: mirror Stripe's state
 * onto the master `workspace_app_access` row (`billing_status`, since when).
 *
 *   customer.subscription.created|updated|deleted   status mapping
 *   invoice.payment_failed                          -> past_due
 *   invoice.paid                                    -> active
 *
 * reach-api reads `billing_status` to pause campaigns after the grace period
 * (7 days from `billing_status_at`), so:
 *  - `billing_status_at` only moves when the status changes: Stripe retries a
 *    failed payment several times and every retry fires `invoice.payment_failed`;
 *  - `canceled` is final for a subscription id, so a late `paid` / `updated`
 *    event for an already cancelled subscription cannot revive it;
 *  - an event for a subscription the row no longer tracks (a replaced,
 *    cancelled one) is ignored.
 * These events never reach the plan/seat handling in routes/webhooks.ts.
 */

import { and, eq } from 'drizzle-orm';
import { WELDREACH_APP_CODE } from '@weldsuite/app-api-client/schemas/reach';
import type { AppAccessBillingStatus } from '@weldsuite/db/schema/master';
import { masterSchema } from '../lib/db';
import type { StripeInvoice, StripeSubscription } from '../types/stripe';
import {
  REACH_SUBSCRIPTION_TYPE,
  mapStripeSubscriptionStatus,
  saveReachSubscription,
  type AppAccessRow,
  type ReachDb,
} from './reach-billing';

const { workspaceAppAccess } = masterSchema;

type InvoiceOutcome = 'paid' | 'failed';

/** Invoice fields that carry the subscription's metadata, depending on the Stripe API version. */
interface InvoiceWithSubscriptionMetadata extends StripeInvoice {
  subscription_details?: { metadata?: Record<string, string> | null } | null;
  lines?: { data?: Array<{ metadata?: Record<string, string> | null }> } | null;
}

function subscriptionIdOf(ref: StripeInvoice['subscription']): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

async function findAccessBySubscription(db: ReachDb, subscriptionId: string): Promise<AppAccessRow | null> {
  const [row] = await db
    .select()
    .from(workspaceAppAccess)
    .where(
      and(
        eq(workspaceAppAccess.appCode, WELDREACH_APP_CODE),
        eq(workspaceAppAccess.stripeSubscriptionId, subscriptionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The access row of a subscription: by its stored id, else by the workspace in
 * the subscription's metadata. In the second case a row that already tracks a
 * different subscription is not this subscription's (a stale event).
 */
async function findAccessRow(
  db: ReachDb,
  subscriptionId: string,
  metadataWorkspaceId: string | undefined,
): Promise<AppAccessRow | null> {
  const bySubscription = await findAccessBySubscription(db, subscriptionId);
  if (bySubscription) return bySubscription;
  if (!metadataWorkspaceId) return null;

  const [byWorkspace] = await db
    .select()
    .from(workspaceAppAccess)
    .where(
      and(
        eq(workspaceAppAccess.workspaceId, metadataWorkspaceId),
        eq(workspaceAppAccess.appCode, WELDREACH_APP_CODE),
      ),
    )
    .limit(1);
  if (!byWorkspace) return null;
  if (byWorkspace.stripeSubscriptionId && byWorkspace.stripeSubscriptionId !== subscriptionId) return null;
  return byWorkspace;
}

/**
 * Apply a status to the row. Returns false when nothing changed (same status,
 * or ignored because `canceled` is final for this subscription).
 */
async function applyStatus(
  db: ReachDb,
  row: AppAccessRow,
  subscriptionId: string,
  next: Exclude<AppAccessBillingStatus, 'none'>,
): Promise<boolean> {
  const tracksIt = row.stripeSubscriptionId === subscriptionId;
  if (tracksIt && row.billingStatus === 'canceled' && next !== 'canceled') return false;

  // A row that never recorded the id (its write failed after Stripe succeeded) adopts it from a live subscription.
  const adoptId = !row.stripeSubscriptionId && next !== 'canceled';
  if (row.billingStatus === next && !adoptId) return false;

  await saveReachSubscription(db, row, { ...(adoptId ? { subscriptionId } : {}), status: next });
  return true;
}

/**
 * `customer.subscription.created|updated|deleted`. Returns true when the
 * subscription is a WeldReach one (so the caller skips the plan handling).
 */
export async function handleReachSubscriptionEvent(
  db: ReachDb,
  subscription: StripeSubscription,
): Promise<boolean> {
  if (subscription.metadata?.type !== REACH_SUBSCRIPTION_TYPE) return false;

  const next = mapStripeSubscriptionStatus(subscription.status);
  if (!next) {
    console.log(`[Reach Billing] Subscription ${subscription.id} status ${subscription.status} has no mapping, ignoring`);
    return true;
  }

  const row = await findAccessRow(db, subscription.id, subscription.metadata.workspaceId);
  if (!row) {
    console.warn(`[Reach Billing] No access row for subscription ${subscription.id}, ignoring`);
    return true;
  }

  const changed = await applyStatus(db, row, subscription.id, next);
  if (changed) console.log(`[Reach Billing] Workspace ${row.workspaceId} billing status -> ${next}`);
  return true;
}

/**
 * `invoice.paid` / `invoice.payment_failed`. Returns true when the invoice
 * belongs to a WeldReach subscription. The subscription is recognised by the
 * id on the access row, else by the metadata the invoice carries.
 */
export async function handleReachInvoiceEvent(
  db: ReachDb,
  invoice: StripeInvoice,
  outcome: InvoiceOutcome,
): Promise<boolean> {
  const subscriptionId = subscriptionIdOf(invoice.subscription);
  if (!subscriptionId) return false;

  let row = await findAccessBySubscription(db, subscriptionId);
  if (!row) {
    const withMetadata = invoice as InvoiceWithSubscriptionMetadata;
    const metadata =
      withMetadata.subscription_details?.metadata ??
      withMetadata.lines?.data?.find((line) => line.metadata?.type === REACH_SUBSCRIPTION_TYPE)?.metadata ??
      null;
    if (metadata?.type !== REACH_SUBSCRIPTION_TYPE) return false;

    row = await findAccessRow(db, subscriptionId, metadata.workspaceId);
    if (!row) {
      console.warn(`[Reach Billing] No access row for invoice ${invoice.id} (subscription ${subscriptionId}), ignoring`);
      return true;
    }
  }

  const next = outcome === 'paid' ? 'active' : 'past_due';
  const changed = await applyStatus(db, row, subscriptionId, next);
  if (changed) console.log(`[Reach Billing] Workspace ${row.workspaceId} billing status -> ${next} (invoice ${invoice.id})`);
  return true;
}
