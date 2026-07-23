/**
 * WeldApps Marketplace — Paid App Subscriptions
 *
 * A workspace subscribes monthly to a paid user-created app (WeldApps)
 * through WeldSuite's Stripe account. If the developer's workspace has
 * completed Stripe Connect onboarding, the charge is split via a destination
 * charge (subscription_data.application_fee_percent + transfer_data) so the
 * developer is paid out automatically minus the platform fee.
 *
 * The install row itself (`userAppInstalls`) is only ACTIVATED by the normal
 * app-api install flow after the admin consents to scopes — this route just
 * makes sure a row exists (status='revoked') so the checkout session has a
 * stable `installId` to tag, and the `checkout.session.completed` webhook
 * flips subscriptionStatus to 'active' once payment succeeds.
 */

import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { Env } from '../index';
import { clerkJwtAuth, requireOrgAdmin } from '../middleware/auth';
import { getMasterDb, masterSchema } from '../lib/db';
import { generateId } from '../lib/id';
import {
  createStripeCustomer,
  createStripeProduct,
  createStripePrice,
  createCheckoutSession,
} from '../lib/stripe';

const { workspaces, userApps, userAppInstalls, appDeveloperAccounts } = masterSchema;

type AppSubscriptionsEnv = {
  Bindings: Env;
  Variables: { userId: string; orgId: string | null; orgRole: string | null };
};

export const appSubscriptionsRoutes = new Hono<AppSubscriptionsEnv>();

appSubscriptionsRoutes.use('*', clerkJwtAuth());
appSubscriptionsRoutes.use('*', requireOrgAdmin());

function billingNotConfigured(c: Context<AppSubscriptionsEnv>) {
  return c.json(
    { error: { code: 'BILLING_NOT_CONFIGURED', message: 'Billing is not configured for this environment.' } },
    503,
  );
}

// ============================================================================
// POST /checkout — start a Stripe Checkout subscription for a paid WeldApp
// ============================================================================
// Body: { appId, workspaceId, successUrl, cancelUrl } → { data: { url } }

appSubscriptionsRoutes.post('/checkout', async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return billingNotConfigured(c);
  }

  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'NO_ORGANIZATION', message: 'No organization selected.' } }, 400);
  }

  type CheckoutBody = {
    appId?: string;
    workspaceId?: string;
    successUrl?: string;
    cancelUrl?: string;
  };
  const body: CheckoutBody = await c.req.json<CheckoutBody>().catch(() => ({}));

  const { appId, workspaceId, successUrl, cancelUrl } = body;

  if (!appId || !workspaceId || !successUrl || !cancelUrl) {
    return c.json(
      { error: { code: 'INVALID_REQUEST', message: 'appId, workspaceId, successUrl and cancelUrl are required.' } },
      400,
    );
  }

  const masterDb = getMasterDb(c.env);

  // Resolve the caller's workspace from the Clerk org and require it to match
  // the workspace in the request body — the installing workspace is always
  // the caller's own, never a workspace supplied purely from client input.
  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId))
    .limit(1);

  if (!workspace) {
    return c.json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' } }, 404);
  }
  if (workspace.id !== workspaceId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'workspaceId does not match the authenticated workspace.' } }, 403);
  }

  const [app] = await masterDb
    .select()
    .from(userApps)
    .where(eq(userApps.id, appId))
    .limit(1);

  if (!app) {
    return c.json({ error: { code: 'APP_NOT_FOUND', message: 'App not found.' } }, 404);
  }

  // Only publicly approved apps can be purchased — mirrors the install
  // gate in app-api (isInstallableHere). Own-workspace installs are free,
  // so buying your own app is never valid either.
  const purchasable =
    app.visibility === 'public' &&
    app.reviewStatus === 'approved' &&
    app.isActive &&
    !app.deletedAt;
  if (!purchasable) {
    return c.json(
      { error: { code: 'APP_NOT_PURCHASABLE', message: 'This app is not available for purchase.' } },
      403,
    );
  }
  if (app.ownerWorkspaceId === workspace.id) {
    return c.json(
      { error: { code: 'OWN_APP', message: 'Your workspace owns this app — installing it does not require a subscription.' } },
      400,
    );
  }

  const priceMonthly = app.priceMonthly != null ? parseFloat(app.priceMonthly) : 0;
  if (app.pricingType !== 'subscription' || !(priceMonthly > 0)) {
    return c.json(
      { error: { code: 'INVALID_APP_PRICING', message: 'This app is not configured for paid subscription.' } },
      400,
    );
  }

  // Ensure the installing workspace has a Stripe customer.
  let customerId = workspace.stripeCustomerId || '';
  if (!customerId) {
    const customer = await createStripeCustomer(c.env.STRIPE_SECRET_KEY, {
      name: workspace.name,
      metadata: { workspaceId: workspace.id, clerkOrgId: orgId },
    });
    customerId = customer.id;

    await masterDb
      .update(workspaces)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
  }

  // Lazily create the Stripe Product + recurring Price for this app.
  let stripePriceId = app.stripePriceId;
  if (!stripePriceId) {
    const product = await createStripeProduct(c.env.STRIPE_SECRET_KEY, {
      name: `WeldApp: ${app.name}`,
      metadata: { appId: app.id },
    });

    const price = await createStripePrice(c.env.STRIPE_SECRET_KEY, {
      productId: product.id,
      unitAmount: Math.round(priceMonthly * 100),
      currency: app.currency.toLowerCase(),
      interval: 'month',
    });

    stripePriceId = price.id as string;

    await masterDb
      .update(userApps)
      .set({
        stripeProductId: product.id,
        stripePriceId: price.id,
        updatedAt: new Date(),
      })
      .where(eq(userApps.id, app.id));
  }

  // Ensure a userAppInstalls row exists for (appId, workspaceId) so the
  // checkout session has a stable installId to tag. It starts revoked /
  // incomplete — the app-api install flow (scope consent) activates it once
  // the webhook marks the subscription active.
  const install = await ensureAppInstall(masterDb, {
    appId: app.id,
    workspaceId: workspace.id,
    installedBy: c.get('userId'),
  });

  // Idempotency: a live subscription already exists — never mint a second
  // Stripe subscription for the same (app, workspace); the webhook would
  // silently overwrite stripeSubscriptionId and orphan the first one.
  if (install.subscriptionStatus === 'active' || install.subscriptionStatus === 'trialing') {
    return c.json(
      { error: { code: 'ALREADY_SUBSCRIBED', message: 'This workspace already has an active subscription for this app.' } },
      409,
    );
  }

  // If the developer's workspace has completed Connect onboarding, split the
  // charge via a destination charge; otherwise the platform collects 100% of
  // the subscription until onboarding completes.
  let applicationFeePercent: number | undefined;
  let transferDataDestination: string | undefined;

  const [developerAccount] = await masterDb
    .select()
    .from(appDeveloperAccounts)
    .where(eq(appDeveloperAccounts.workspaceId, app.ownerWorkspaceId))
    .limit(1);

  if (developerAccount?.payoutsEnabled && developerAccount.stripeConnectAccountId) {
    applicationFeePercent = app.platformFeePercent;
    transferDataDestination = developerAccount.stripeConnectAccountId;
  }

  const metadata = {
    appId: app.id,
    workspaceId: workspace.id,
    installId: install.id,
  };

  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    customerId,
    priceId: stripePriceId,
    quantity: 1,
    mode: 'subscription',
    successUrl,
    cancelUrl,
    metadata,
    subscriptionData: {
      metadata,
      applicationFeePercent,
      transferDataDestination,
    },
  });

  return c.json({ data: { url: session.url } });
});

// ============================================================================
// Helpers
// ============================================================================

async function ensureAppInstall(
  masterDb: ReturnType<typeof getMasterDb>,
  params: { appId: string; workspaceId: string; installedBy: string },
) {
  const existing = await selectInstall(masterDb, params.appId, params.workspaceId);
  if (existing) return existing;

  const [created] = await masterDb
    .insert(userAppInstalls)
    .values({
      id: generateId('uai'),
      appId: params.appId,
      workspaceId: params.workspaceId,
      status: 'revoked',
      subscriptionStatus: 'incomplete',
      grantedScopes: [],
      installedBy: params.installedBy,
    })
    .onConflictDoNothing({ target: [userAppInstalls.appId, userAppInstalls.workspaceId] })
    .returning();

  if (created) return created;

  // Lost the insert race to a concurrent request — read back what it created.
  const raced = await selectInstall(masterDb, params.appId, params.workspaceId);
  if (!raced) throw new Error('Failed to create or find app install row');
  return raced;
}

async function selectInstall(masterDb: ReturnType<typeof getMasterDb>, appId: string, workspaceId: string) {
  const [row] = await masterDb
    .select()
    .from(userAppInstalls)
    .where(and(eq(userAppInstalls.appId, appId), eq(userAppInstalls.workspaceId, workspaceId)))
    .limit(1);
  return row;
}
