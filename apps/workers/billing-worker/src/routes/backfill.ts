/**
 * Billing Backfill Routes
 *
 * Internal endpoint (M2M auth) to fix workspaces that are missing
 * Stripe customer and/or subscription records.
 *
 * POST /billing — backfill missing stripeCustomerId/stripeSubscriptionId
 *   Query params:
 *     dryRun=true  — report what would be done without making changes
 */

import { Hono } from 'hono';
import { eq, and, or, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { getMasterDb, masterSchema } from '../lib/db';
import { createStripeCustomer, createStripeSubscription } from '../lib/stripe';
import { m2mAuth } from '../middleware/m2m-auth';

const { workspaces, plans } = masterSchema;

export const backfillRoutes = new Hono<{ Bindings: Env }>();

// Protect all backfill routes with M2M auth
backfillRoutes.use('*', m2mAuth());

interface BackfillWorkspaceResult {
  workspaceId: string;
  workspaceName: string;
  clerkOrgId: string | null;
  before: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
  };
  after: {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
  };
  actions: string[];
  error?: string;
}

backfillRoutes.post('/billing', async (c) => {
  const dryRun = c.req.query('dryRun') === 'true';
  const masterDb = getMasterDb(c.env);
  const stripeKey = c.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    return c.json({ error: 'STRIPE_SECRET_KEY not configured' }, 500);
  }

  // 1. Find the free plan and its Stripe price
  const [freePlan] = await masterDb
    .select({
      id: plans.id,
      stripePriceIdMonthly: plans.stripePriceIdMonthly,
    })
    .from(plans)
    .where(and(eq(plans.slug, 'free'), isNull(plans.deletedAt)));

  if (!freePlan) {
    return c.json({ error: 'No free plan found in database' }, 500);
  }

  if (!freePlan.stripePriceIdMonthly) {
    return c.json({ error: 'Free plan has no stripePriceIdMonthly configured' }, 500);
  }

  // 2. Find all active workspaces missing customer or subscription
  const broken = await masterDb
    .select({
      id: workspaces.id,
      name: workspaces.name,
      clerkOrgId: workspaces.clerkOrgId,
      stripeCustomerId: workspaces.stripeCustomerId,
      stripeSubscriptionId: workspaces.stripeSubscriptionId,
    })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.isActive, true),
        or(
          isNull(workspaces.stripeCustomerId),
          isNull(workspaces.stripeSubscriptionId),
        ),
      ),
    );

  if (broken.length === 0) {
    return c.json({
      dryRun,
      message: 'All active workspaces have Stripe billing set up',
      total: 0,
      results: [],
    });
  }

  console.log(`[Backfill] Found ${broken.length} workspaces to backfill (dryRun=${dryRun})`);

  // 3. Process each workspace
  const results: BackfillWorkspaceResult[] = [];

  for (const ws of broken) {
    const result: BackfillWorkspaceResult = {
      workspaceId: ws.id,
      workspaceName: ws.name,
      clerkOrgId: ws.clerkOrgId,
      before: {
        stripeCustomerId: ws.stripeCustomerId,
        stripeSubscriptionId: ws.stripeSubscriptionId,
      },
      after: {
        stripeCustomerId: ws.stripeCustomerId,
        stripeSubscriptionId: ws.stripeSubscriptionId,
      },
      actions: [],
    };

    if (dryRun) {
      if (!ws.stripeCustomerId) {
        result.actions.push('would create Stripe customer');
      }
      if (!ws.stripeSubscriptionId) {
        result.actions.push('would create free subscription');
      }
      results.push(result);
      continue;
    }

    try {
      // Step A: Create Stripe customer if missing
      let customerId = ws.stripeCustomerId;
      if (!customerId) {
        const customer = await createStripeCustomer(stripeKey, {
          name: ws.name,
          metadata: {
            workspaceId: ws.id,
            ...(ws.clerkOrgId ? { clerkOrgId: ws.clerkOrgId } : {}),
          },
        });
        customerId = customer.id;

        await masterDb
          .update(workspaces)
          .set({ stripeCustomerId: customerId, updatedAt: new Date() })
          .where(eq(workspaces.id, ws.id));

        result.actions.push(`created Stripe customer ${customerId}`);
        result.after.stripeCustomerId = customerId;
        console.log(`[Backfill] Created customer ${customerId} for workspace ${ws.id}`);
      }

      // Step B: Create free subscription if missing
      if (!ws.stripeSubscriptionId) {
        const subscription = await createStripeSubscription(stripeKey, {
          customerId,
          priceId: freePlan.stripePriceIdMonthly,
          metadata: {
            workspaceId: ws.id,
            planId: freePlan.id,
            ...(ws.clerkOrgId ? { clerkOrgId: ws.clerkOrgId } : {}),
          },
        });

        await masterDb
          .update(workspaces)
          .set({ stripeSubscriptionId: subscription.id, updatedAt: new Date() })
          .where(eq(workspaces.id, ws.id));

        result.actions.push(`created free subscription ${subscription.id}`);
        result.after.stripeSubscriptionId = subscription.id;
        console.log(`[Backfill] Created subscription ${subscription.id} for workspace ${ws.id}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      result.error = message;
      result.actions.push(`error: ${message}`);
      console.error(`[Backfill] Error processing workspace ${ws.id}:`, err);
    }

    results.push(result);
  }

  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;

  console.log(`[Backfill] Complete: ${succeeded} succeeded, ${failed} failed (dryRun=${dryRun})`);

  return c.json({
    dryRun,
    total: broken.length,
    succeeded,
    failed,
    results,
  });
});
