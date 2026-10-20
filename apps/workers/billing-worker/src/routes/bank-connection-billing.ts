/**
 * WeldBooks extra bank connections: the plan includes some, each one above
 * that is billed monthly (services/bank-connection-billing.ts).
 *
 *   GET  /status   included, counted and billed connections, for books-api's
 *                  connect check and the confirm dialog
 *   POST /sync     set the Stripe quantity to the workspace's extra connections;
 *                  books-api calls it after a bank is linked, disconnected or removed
 *
 * books-api calls these with the user's Clerk JWT (`callBillingWorker`).
 * Neither takes a count from the caller: billing-worker counts the
 * connections itself, so the only thing a caller decides is when. Raising the
 * quantity takes a workspace admin.
 */

import { Hono, type Context } from 'hono';
import {
  bankConnectionExtraPrice,
  type BankConnectionBillingSummary,
} from '@weldsuite/app-api-client/schemas/bank-connection-billing';
import type { Env } from '../index';
import { clerkJwtAuth } from '../middleware/auth';
import { getMasterDb } from '../lib/db';
import { retrieveCustomer } from '../lib/stripe';
import {
  countBankConnections,
  findBankConnectionSubscription,
  includedBankConnections,
  syncBankConnectionQuantity,
  withBankConnectionBillingLock,
} from '../services/bank-connection-billing';
import { findOffSessionPaymentMethod, findWorkspaceByOrg, isLockTimeout, subscriptionQuantity } from '../services/reach-billing';

type BankConnectionBillingEnv = {
  Bindings: Env;
  Variables: { userId: string; orgId: string | null; orgRole: string | null };
};

type AppContext = Context<BankConnectionBillingEnv>;

export const bankConnectionBillingRoutes = new Hono<BankConnectionBillingEnv>();

bankConnectionBillingRoutes.use('*', clerkJwtAuth());

type ErrorStatus = 400 | 402 | 403 | 404 | 409 | 502 | 503;

function fail(c: AppContext, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

/** A card the customer has to fix, as opposed to a Stripe outage. */
function isPaymentFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /card_declined|authentication_required|requires_action|requires_payment_method|insufficient_funds|expired_card|incomplete|payment_intent_authentication_failure/i.test(
    message,
  );
}

/** Log the cause server-side (Stripe's message never reaches the client) and answer with a stable code. */
function billingFailure(c: AppContext, label: string, err: unknown) {
  console.error(`[Bank Connection Billing] ${label} failed:`, err);
  if (isPaymentFailure(err)) {
    return fail(c, 402, 'PAYMENT_FAILED', 'The payment could not be completed. Check your payment method and try again.');
  }
  return fail(c, 502, 'BILLING_PROVIDER_ERROR', 'The billing provider could not complete the request.');
}

const isAdmin = (c: AppContext) => c.get('orgRole') === 'org:admin';

/** The customer's billing currency (null until its first subscription or invoice) and whether a card is on file. */
async function customerBilling(stripeKey: string, customerId: string) {
  const customer = await retrieveCustomer(stripeKey, customerId);
  const currency = customer.currency ?? null;
  const hasPaymentMethod = Boolean(await findOffSessionPaymentMethod(stripeKey, customerId, { adopt: false }));
  return { currency, hasPaymentMethod };
}

// ============================================================================
// GET /status
// ============================================================================

bankConnectionBillingRoutes.get('/status', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return fail(c, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured for this environment.');
  const orgId = c.get('orgId');
  if (!orgId) return fail(c, 400, 'NO_ORGANIZATION', 'No organization selected.');

  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  if (!workspace) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  try {
    const connections = await countBankConnections(masterDb, orgId);
    const included = await includedBankConnections(masterDb, workspace);
    // Stripe is only asked once the workspace is at or over what the plan includes.
    const atLimit = connections >= included;
    const customerId = workspace.stripeCustomerId;
    const subscription = atLimit
      ? await findBankConnectionSubscription(c.env.STRIPE_SECRET_KEY, customerId, workspace.id)
      : null;
    const customer = atLimit && customerId ? await customerBilling(c.env.STRIPE_SECRET_KEY, customerId) : null;

    const summary: BankConnectionBillingSummary = {
      connections,
      included,
      billedExtra: subscription ? subscriptionQuantity(subscription) : 0,
      // The price in the currency Stripe will charge this customer in.
      ...bankConnectionExtraPrice(customer?.currency),
      hasPaymentMethod: customer?.hasPaymentMethod ?? false,
      canAddPaid: isAdmin(c),
    };
    return c.json({ data: summary });
  } catch (err) {
    return billingFailure(c, 'status', err);
  }
});

// ============================================================================
// POST /sync
// ============================================================================

bankConnectionBillingRoutes.post('/sync', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return fail(c, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured for this environment.');
  const orgId = c.get('orgId');
  if (!orgId) return fail(c, 400, 'NO_ORGANIZATION', 'No organization selected.');

  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  if (!workspace) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  try {
    const outcome = await withBankConnectionBillingLock(masterDb, workspace.id, (tx) =>
      syncBankConnectionQuantity(c.env, tx, workspace, orgId, { canIncrease: isAdmin(c) }),
    );
    if (!outcome.ok) return fail(c, outcome.status, outcome.code, outcome.message);
    return c.json({ data: { connections: outcome.connections, included: outcome.included, quantity: outcome.quantity } });
  } catch (err) {
    if (isLockTimeout(err)) {
      return fail(c, 409, 'BILLING_BUSY', 'Another billing change for this workspace is in progress. Try again.');
    }
    return billingFailure(c, 'sync', err);
  }
});
