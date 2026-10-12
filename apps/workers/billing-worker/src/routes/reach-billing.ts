/**
 * WeldReach billing routes: one Stripe subscription per workspace, $5 per
 * inbox per month, quantity = inboxes (docs/plans/weldreach.md "Billing").
 *
 *   GET  /status   billing summary for the settings screen and the wizard
 *   POST /setup    Stripe Checkout (setup mode) to collect a payment method
 *   POST /inboxes  inbox quantity +1 / -1; reach-api calls this before it asks
 *                  Mailpool for a mailbox and rolls back with -1 when Mailpool fails
 *
 * reach-api calls these with the user's Clerk JWT (`callBillingWorker`), and the
 * browser could too, so the two routes that spend money also require an org admin.
 * reach-api applies the finer `reach_mailboxes` permission before it gets here.
 * The state machine lives in services/reach-inbox-change.ts and
 * services/reach-billing.ts; webhooks mirror Stripe's status onto the access row
 * (services/reach-billing-webhooks.ts).
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  WELDREACH_INBOX_CURRENCY,
  WELDREACH_INBOX_PRICE_CENTS,
  reachBillingSetupSchema,
  type ReachBillingSummary,
} from '@weldsuite/app-api-client/schemas/reach';
import type { Env } from '../index';
import { clerkJwtAuth, requireOrgAdmin } from '../middleware/auth';
import { getMasterDb } from '../lib/db';
import { createSetupCheckoutSession } from '../lib/stripe';
import {
  ensureStripeCustomer,
  findOffSessionPaymentMethod,
  findReachAccess,
  findReachSubscription,
  findWorkspaceByOrg,
  isLockTimeout,
  subscriptionPeriodEnd,
  subscriptionQuantity,
  withReachBillingLock,
} from '../services/reach-billing';
import { changeInboxQuantity } from '../services/reach-inbox-change';

type ReachBillingEnv = {
  Bindings: Env;
  Variables: { userId: string; orgId: string | null; orgRole: string | null };
};

export const reachBillingRoutes = new Hono<ReachBillingEnv>();

reachBillingRoutes.use('*', clerkJwtAuth());

const inboxChangeSchema = z.object({
  delta: z.union([z.literal(1), z.literal(-1)]),
  mailboxId: z.string().trim().min(1).max(100),
});

type ErrorStatus = 400 | 402 | 403 | 404 | 409 | 502 | 503;

function fail(c: Context<ReachBillingEnv>, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** Only web URLs can be Checkout redirect targets. */
function isWebUrl(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || protocol === 'http:';
}

/** A card the customer has to fix, as opposed to a Stripe outage. */
function isPaymentFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /card_declined|authentication_required|requires_action|requires_payment_method|insufficient_funds|expired_card|incomplete|payment_intent_authentication_failure/i.test(
    message,
  );
}

/** Log the cause server-side (Stripe's message never reaches the client) and answer with a stable code. */
function billingFailure(c: Context<ReachBillingEnv>, label: string, err: unknown) {
  console.error(`[Reach Billing] ${label} failed:`, err);
  if (isPaymentFailure(err)) {
    return fail(c, 402, 'PAYMENT_FAILED', 'The payment could not be completed. Check your payment method and try again.');
  }
  return fail(c, 502, 'BILLING_PROVIDER_ERROR', 'The billing provider could not complete the request.');
}

const notConfigured = (c: Context<ReachBillingEnv>) =>
  fail(c, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured for this environment.');

const noOrganization = (c: Context<ReachBillingEnv>) =>
  fail(c, 400, 'NO_ORGANIZATION', 'No organization selected.');

// ============================================================================
// GET /status
// ============================================================================

reachBillingRoutes.get('/status', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return notConfigured(c);
  const orgId = c.get('orgId');
  if (!orgId) return noOrganization(c);

  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  if (!workspace) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  const access = await findReachAccess(masterDb, workspace.id);

  try {
    const hasPaymentMethod = workspace.stripeCustomerId
      ? Boolean(await findOffSessionPaymentMethod(c.env.STRIPE_SECRET_KEY, workspace.stripeCustomerId, { adopt: false }))
      : false;

    // The stored subscription only: no search, this is a read on every settings visit.
    const subscription = access?.stripeSubscriptionId
      ? await findReachSubscription(c.env.STRIPE_SECRET_KEY, {
          storedId: access.stripeSubscriptionId,
          customerId: null,
          workspaceId: workspace.id,
        })
      : null;

    const summary: ReachBillingSummary = {
      status: access?.billingStatus ?? 'none',
      hasPaymentMethod,
      inboxCount: subscription ? subscriptionQuantity(subscription) : 0,
      unitAmountCents: WELDREACH_INBOX_PRICE_CENTS,
      currency: WELDREACH_INBOX_CURRENCY,
      currentPeriodEnd: subscription ? subscriptionPeriodEnd(subscription) : null,
    };
    return c.json({ data: summary });
  } catch (err) {
    return billingFailure(c, 'status', err);
  }
});

// ============================================================================
// POST /setup: Stripe Checkout in setup mode (collect a payment method)
// ============================================================================

reachBillingRoutes.post('/setup', requireOrgAdmin(), async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return notConfigured(c);
  const orgId = c.get('orgId');
  if (!orgId) return noOrganization(c);

  const parsed = reachBillingSetupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isWebUrl(parsed.data.successUrl) || !isWebUrl(parsed.data.cancelUrl)) {
    return fail(c, 400, 'INVALID_REQUEST', 'successUrl and cancelUrl must be web URLs.');
  }

  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  if (!workspace) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  try {
    const customerId = await ensureStripeCustomer(c.env.STRIPE_SECRET_KEY, masterDb, workspace, orgId);
    const session = await createSetupCheckoutSession(c.env.STRIPE_SECRET_KEY, {
      customerId,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
      metadata: { type: 'weldreach_setup', workspaceId: workspace.id, clerkOrgId: orgId },
    });
    if (!session.url) return fail(c, 502, 'BILLING_PROVIDER_ERROR', 'Stripe Checkout did not return a URL.');
    return c.json({ data: { url: session.url as string } });
  } catch (err) {
    return billingFailure(c, 'setup checkout', err);
  }
});

// ============================================================================
// POST /inboxes: quantity +1 / -1
// ============================================================================

reachBillingRoutes.post('/inboxes', requireOrgAdmin(), async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return notConfigured(c);
  const orgId = c.get('orgId');
  if (!orgId) return noOrganization(c);

  const parsed = inboxChangeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return fail(c, 400, 'INVALID_REQUEST', 'delta must be 1 or -1 and mailboxId is required.');
  }

  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  if (!workspace) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  try {
    const outcome = await withReachBillingLock(masterDb, workspace.id, (tx) =>
      changeInboxQuantity(c.env, tx, workspace, orgId, parsed.data),
    );
    if (!outcome.ok) return fail(c, outcome.status, outcome.code, outcome.message);
    return c.json({ data: { quantity: outcome.quantity } });
  } catch (err) {
    if (isLockTimeout(err)) {
      return fail(c, 409, 'BILLING_BUSY', 'Another billing change for this workspace is in progress. Try again.');
    }
    return billingFailure(c, 'inbox change', err);
  }
});
