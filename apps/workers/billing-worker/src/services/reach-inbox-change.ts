/**
 * Add or remove one WeldReach inbox: the quantity of the workspace's inbox
 * subscription changes by one, and the master `workspace_app_access` row follows.
 * Runs inside the per-workspace lock (`withReachBillingLock`). See
 * services/reach-billing.ts for the decisions behind it.
 */

import type { Env } from '../index';
import {
  cancelReachSubscription,
  createReachSubscription,
  ensureStripeCustomer,
  findOffSessionPaymentMethod,
  findReachAccess,
  findReachSubscription,
  inboxOperationId,
  isDelinquentSubscriptionStatus,
  mapStripeSubscriptionStatus,
  operationAlreadyApplied,
  resolveInboxPriceId,
  saveReachSubscription,
  setReachQuantity,
  subscriptionItem,
  subscriptionQuantity,
  type AppAccessRow,
  type ReachDb,
  type ReachStripeSubscription,
  type WorkspaceRow,
} from './reach-billing';

export interface InboxChangeInput {
  delta: 1 | -1;
  mailboxId: string;
}

export type InboxChangeOutcome =
  | { ok: true; quantity: number }
  | { ok: false; status: 402 | 403 | 502; code: string; message: string };

type StripeEnv = Pick<Env, 'STRIPE_SECRET_KEY' | 'STRIPE_PRICE_WELDREACH_INBOX'>;

const refuse = (
  status: 402 | 403 | 502,
  code: string,
  message: string,
): Extract<InboxChangeOutcome, { ok: false }> => ({ ok: false, status, code, message });

export async function changeInboxQuantity(
  env: StripeEnv,
  db: ReachDb,
  workspace: WorkspaceRow,
  clerkOrgId: string,
  input: InboxChangeInput,
): Promise<InboxChangeOutcome> {
  // Re-read inside the lock: another request may have changed the row since the caller looked.
  const access = await findReachAccess(db, workspace.id);
  if (!access) {
    return refuse(403, 'APP_ACCESS_REQUIRED', 'This workspace has no WeldReach access.');
  }

  if (input.delta === 1) {
    if (access.status !== 'approved') {
      return refuse(403, 'APP_ACCESS_REQUIRED', 'WeldReach access is not approved for this workspace.');
    }
    return addInbox(env, db, workspace, clerkOrgId, access, input.mailboxId);
  }

  // Removing an inbox only lowers the bill, so it stays possible while access is suspended.
  return removeInbox(env, db, workspace, access, input.mailboxId);
}

async function addInbox(
  env: StripeEnv,
  db: ReachDb,
  workspace: WorkspaceRow,
  clerkOrgId: string,
  access: AppAccessRow,
  mailboxId: string,
): Promise<InboxChangeOutcome> {
  const stripeKey = env.STRIPE_SECRET_KEY;
  const operationId = inboxOperationId(mailboxId, 1);

  const customerId = await ensureStripeCustomer(stripeKey, db, workspace, clerkOrgId);
  const paymentMethodId = await findOffSessionPaymentMethod(stripeKey, customerId, { adopt: true });
  if (!paymentMethodId) {
    return refuse(402, 'PAYMENT_METHOD_REQUIRED', 'Add a payment method before creating inboxes.');
  }

  const existing = await findReachSubscription(stripeKey, {
    storedId: access.stripeSubscriptionId,
    customerId,
    workspaceId: workspace.id,
  });

  if (existing && isDelinquentSubscriptionStatus(existing.status)) {
    return refuse(402, 'PAYMENT_PAST_DUE', 'The last inbox payment failed. Update your payment method first.');
  }

  if (existing) {
    const item = subscriptionItem(existing);
    if (!item) return refuse(502, 'BILLING_INCONSISTENT', 'The inbox subscription has no item.');

    let quantity = item.quantity ?? 0;
    if (!operationAlreadyApplied(existing, operationId)) {
      quantity += 1;
      await setReachQuantity(stripeKey, item.id, quantity, operationId);
    }
    await saveReachSubscription(db, access, {
      subscriptionId: existing.id,
      status: mapStripeSubscriptionStatus(existing.status) ?? 'active',
    });
    return { ok: true, quantity };
  }

  const priceId = await resolveInboxPriceId(env);
  const created = await createReachSubscription(stripeKey, {
    customerId,
    priceId,
    workspaceId: workspace.id,
    clerkOrgId,
    operationId,
    // The previous subscription id changes after a cancel, so a retry after a rollback
    // never replays the first (since cancelled) creation; the payment method does the
    // same after a declined card was replaced.
    idempotencyKey: `weldreach-sub:${workspace.id}:${mailboxId}:${access.stripeSubscriptionId ?? 'none'}:${paymentMethodId}`,
  });
  await saveReachSubscription(db, access, { subscriptionId: created.id, status: 'active' });
  return { ok: true, quantity: subscriptionQuantity(created) || 1 };
}

async function removeInbox(
  env: StripeEnv,
  db: ReachDb,
  workspace: WorkspaceRow,
  access: AppAccessRow,
  mailboxId: string,
): Promise<InboxChangeOutcome> {
  const stripeKey = env.STRIPE_SECRET_KEY;
  const operationId = inboxOperationId(mailboxId, -1);

  const existing = await findReachSubscription(stripeKey, {
    storedId: access.stripeSubscriptionId,
    customerId: workspace.stripeCustomerId,
    workspaceId: workspace.id,
  });

  if (!existing) {
    // Nothing is billed any more; make the row say so.
    if (access.billingStatus === 'active' || access.billingStatus === 'past_due') {
      await saveReachSubscription(db, access, { status: 'canceled' });
    }
    return { ok: true, quantity: 0 };
  }

  const item = subscriptionItem(existing);
  const quantity = item?.quantity ?? 0;
  if (item && operationAlreadyApplied(existing, operationId)) return { ok: true, quantity };

  if (!item || quantity <= 1) {
    await cancelReachSubscription(stripeKey, existing.id);
    await saveReachSubscription(db, access, { subscriptionId: existing.id, status: 'canceled' });
    return { ok: true, quantity: 0 };
  }

  await setReachQuantity(stripeKey, item.id, quantity - 1, operationId);
  await adoptSubscription(db, access, existing);
  return { ok: true, quantity: quantity - 1 };
}

/** A subscription found by search (its id never reached the row) is recorded without touching the status. */
async function adoptSubscription(
  db: ReachDb,
  access: AppAccessRow,
  subscription: ReachStripeSubscription,
): Promise<void> {
  if (access.stripeSubscriptionId === subscription.id) return;
  const status = mapStripeSubscriptionStatus(subscription.status);
  await saveReachSubscription(db, access, {
    subscriptionId: subscription.id,
    status: status ?? (access.billingStatus === 'none' ? 'active' : access.billingStatus),
  });
}
