/**
 * Credit Topup Routes — prepaid wallet purchases.
 *
 * POST /checkout creates a one-time (mode='payment') Stripe Checkout session
 * for a `credit_packages` row. The credits are granted by the
 * `checkout.session.completed` webhook (kind='credit_topup'), idempotent on
 * the session id — this route never touches the balance itself.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../index';
import { clerkJwtAuth } from '../middleware/auth';
import { getMasterDb, masterSchema } from '../lib/db';
import { createStripeCustomer, createCheckoutSession } from '../lib/stripe';

const { workspaces, creditPackages } = masterSchema;

export const creditTopupRoutes = new Hono<{
  Bindings: Env;
  Variables: {
    userId: string;
    orgId: string | null;
  };
}>();

creditTopupRoutes.use('*', clerkJwtAuth());

/**
 * POST /checkout — start a Stripe Checkout for a credit package.
 * Body: { packageId, successUrl?, cancelUrl? } → { url }
 */
creditTopupRoutes.post('/checkout', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId) return c.json({ error: 'No organization selected' }, 400);

  const body = await c.req.json<{
    packageId: string;
    successUrl?: string;
    cancelUrl?: string;
  }>();

  if (!body.packageId) {
    return c.json({ error: 'Missing packageId' }, 400);
  }

  const masterDb = getMasterDb(c.env);

  const [pkg] = await masterDb
    .select()
    .from(creditPackages)
    .where(eq(creditPackages.id, body.packageId))
    .limit(1);

  if (!pkg || pkg.isActive !== 1) {
    return c.json({ error: 'Credit package not found' }, 404);
  }
  if (!pkg.stripePriceId) {
    return c.json({ error: 'Credit package is not purchasable (no Stripe price configured)' }, 400);
  }

  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId));

  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);

  // Ensure the workspace has a Stripe customer.
  let customerId: string = workspace.stripeCustomerId || '';
  if (!customerId) {
    const customer = await createStripeCustomer(c.env.STRIPE_SECRET_KEY, {
      name: workspace.name,
      metadata: {
        workspaceId: workspace.id,
        clerkOrgId: orgId,
      },
    });
    customerId = customer.id;

    await masterDb
      .update(workspaces)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(workspaces.id, workspace.id));
  }

  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    customerId,
    priceId: pkg.stripePriceId,
    quantity: 1,
    mode: 'payment',
    automaticTax: true,
    successUrl: body.successUrl || 'https://app.weldsuite.org/settings/billing?credits=success',
    cancelUrl: body.cancelUrl || 'https://app.weldsuite.org/settings/billing?credits=cancelled',
    metadata: {
      kind: 'credit_topup',
      workspaceId: workspace.id,
      clerkOrgId: orgId,
      packageId: pkg.id,
      credits: String(pkg.credits),
      userId,
    },
  });

  return c.json({ url: session.url });
});
