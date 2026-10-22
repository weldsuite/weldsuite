/**
 * The SSO add-on, for the workspace (services/sso-billing.ts).
 *
 *   GET  /status     the add-on priced for this workspace, whether it can be bought
 *   POST /subscribe  start it on the card on file
 *   POST /cancel     end it at the end of the paid period
 *   POST /resume     undo /cancel before it takes effect
 *
 * The platform reaches these through app-api (`/api/sso/billing/*`), which
 * checks `billing:manage` and forwards the user's Clerk JWT. Spending here
 * also takes a Clerk org admin, like the other add-ons. Every answer is the
 * summary after the change.
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../index';
import { clerkJwtAuth } from '../middleware/auth';
import { getMasterDb } from '../lib/db';
import { findWorkspaceByOrg, isLockTimeout, type WorkspaceRow } from '../services/reach-billing';
import {
  SsoBillingError,
  reconcileAfterBillingChange,
  setSsoCancelAtPeriodEnd,
  ssoBillingSummary,
  subscribeToSso,
  withSsoBillingLock,
  type SsoBillingDb,
} from '../services/sso-billing';
import { loadSsoContext } from '@weldsuite/core-domain/sso';

type SsoBillingEnv = {
  Bindings: Env;
  Variables: { userId: string; orgId: string | null; orgRole: string | null };
};

type AppContext = Context<SsoBillingEnv>;

export const ssoBillingRoutes = new Hono<SsoBillingEnv>();

ssoBillingRoutes.use('*', clerkJwtAuth());

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
  if (err instanceof SsoBillingError) return fail(c, err.status, err.code, err.message);
  if (isLockTimeout(err)) {
    return fail(c, 409, 'BILLING_BUSY', 'Another billing change for this workspace is in progress. Try again.');
  }
  console.error(`[SSO Billing] ${label} failed:`, err);
  if (isPaymentFailure(err)) {
    return fail(c, 402, 'PAYMENT_FAILED', 'The payment could not be completed. Check your payment method and try again.');
  }
  return fail(c, 502, 'BILLING_PROVIDER_ERROR', 'The billing provider could not complete the request.');
}

const isAdmin = (c: AppContext) => c.get('orgRole') === 'org:admin';

async function summary(c: AppContext, orgId: string) {
  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  const ctx = await loadSsoContext(masterDb, { clerkOrgId: orgId });
  if (!workspace || !ctx) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');
  return c.json({ data: await ssoBillingSummary(c.env, masterDb, workspace, ctx) });
}

/** Shared by the three writes: auth, lock, change, reconcile Clerk, answer with the new summary. */
async function write(
  c: AppContext,
  label: string,
  change: (env: Env, tx: SsoBillingDb, workspace: WorkspaceRow) => Promise<void>,
) {
  if (!c.env.STRIPE_SECRET_KEY) return fail(c, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured for this environment.');
  const orgId = c.get('orgId');
  if (!orgId) return fail(c, 400, 'NO_ORGANIZATION', 'No organization selected.');

  const masterDb = getMasterDb(c.env);
  const workspace = await findWorkspaceByOrg(masterDb, orgId);
  if (!workspace) return fail(c, 404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  try {
    await withSsoBillingLock(masterDb, workspace.id, (tx) => change(c.env, tx, workspace));
    // Outside the lock: Clerk is not part of the billing change.
    await reconcileAfterBillingChange(c.env, masterDb, workspace.id, c.get('userId'));
    return await summary(c, orgId);
  } catch (err) {
    return billingFailure(c, label, err);
  }
}

ssoBillingRoutes.get('/status', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) return fail(c, 503, 'BILLING_NOT_CONFIGURED', 'Billing is not configured for this environment.');
  const orgId = c.get('orgId');
  if (!orgId) return fail(c, 400, 'NO_ORGANIZATION', 'No organization selected.');
  try {
    return await summary(c, orgId);
  } catch (err) {
    return billingFailure(c, 'status', err);
  }
});

ssoBillingRoutes.post('/subscribe', (c) =>
  write(c, 'subscribe', (env, tx, workspace) => subscribeToSso(env, tx, workspace, { canSpend: isAdmin(c) })),
);

ssoBillingRoutes.post('/cancel', (c) =>
  write(c, 'cancel', (env, tx, workspace) => setSsoCancelAtPeriodEnd(env, tx, workspace, true, { canSpend: isAdmin(c) })),
);

ssoBillingRoutes.post('/resume', (c) =>
  write(c, 'resume', (env, tx, workspace) => setSsoCancelAtPeriodEnd(env, tx, workspace, false, { canSpend: isAdmin(c) })),
);
