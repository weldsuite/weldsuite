/**
 * @deprecated - Billing is now managed via Clerk Billing. This script was used for the
 * Stripe-based billing system and is no longer needed. Kept for reference only.
 *
 * Backfill Script: Create Stripe customers + free subscriptions for existing workspaces
 *
 * Usage:
 *   MASTER_DATABASE_URL="postgresql://..." STRIPE_SECRET_KEY="sk_..." pnpm tsx scripts/backfill-free-subscriptions.ts
 *
 * Options:
 *   --dry-run    Preview what would be done without making changes
 */

import Stripe from 'stripe';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { eq, and, isNull } from 'drizzle-orm';
import ws from 'ws';
import * as masterSchema from '@weldsuite/db/schema/master';

neonConfig.webSocketConstructor = ws;

const dryRun = process.argv.includes('--dry-run');

async function main() {
  // Standalone script invoked directly via `pnpm tsx` (not a turbo task), so
  // these env vars aren't part of the turbo.json build pipeline declarations.
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const dbUrl = process.env.MASTER_DATABASE_URL;
  // eslint-disable-next-line turbo/no-undeclared-env-vars
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!dbUrl) {
    console.error('MASTER_DATABASE_URL is required');
    process.exit(1);
  }
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  const db = drizzle({ client: pool, schema: masterSchema });
  const stripe = new Stripe(stripeKey);

  // Get the free plan's Stripe price
  const [freePlan] = await db
    .select()
    .from(masterSchema.plans)
    .where(and(eq(masterSchema.plans.slug, 'free'), isNull(masterSchema.plans.deletedAt)));

  if (!freePlan) {
    console.error('No free plan found in database');
    process.exit(1);
  }

  if (!freePlan.stripePriceIdMonthly) {
    console.error('Free plan has no stripePriceIdMonthly set. Set it first in the DB or Stripe dashboard.');
    process.exit(1);
  }

  console.log(`Free plan: ${freePlan.name} (${freePlan.id})`);
  console.log(`Stripe price: ${freePlan.stripePriceIdMonthly}`);
  console.log(`Dry run: ${dryRun}\n`);

  // Get all active workspaces missing a subscription
  const workspacesWithoutSub = await db
    .select({
      id: masterSchema.workspaces.id,
      name: masterSchema.workspaces.name,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
      stripeCustomerId: masterSchema.workspaces.stripeCustomerId,
      stripeSubscriptionId: masterSchema.workspaces.stripeSubscriptionId,
    })
    .from(masterSchema.workspaces)
    .where(
      and(
        isNull(masterSchema.workspaces.stripeSubscriptionId),
        eq(masterSchema.workspaces.isActive, true)
      )
    );

  console.log(`Found ${workspacesWithoutSub.length} workspaces without a subscription\n`);

  let created = 0;
  const skipped = 0;
  let failed = 0;

  for (const workspace of workspacesWithoutSub) {
    try {
      console.log(`[${workspace.id}] ${workspace.name}`);

      // Step 1: Create Stripe customer if needed
      let customerId = workspace.stripeCustomerId;
      if (!customerId) {
        if (dryRun) {
          console.log(`  -> Would create Stripe customer`);
          customerId = 'cus_dry_run';
        } else {
          const customer = await stripe.customers.create({
            name: workspace.name,
            metadata: {
              workspaceId: workspace.id,
              clerkOrgId: workspace.clerkOrgId,
            },
          });
          customerId = customer.id;

          await db
            .update(masterSchema.workspaces)
            .set({ stripeCustomerId: customerId, updatedAt: new Date() })
            .where(eq(masterSchema.workspaces.id, workspace.id));

          console.log(`  -> Created customer: ${customerId}`);
        }
      } else {
        console.log(`  -> Existing customer: ${customerId}`);
      }

      // Step 2: Create $0 free subscription
      if (dryRun) {
        console.log(`  -> Would create free subscription`);
      } else {
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: freePlan.stripePriceIdMonthly! }],
          metadata: {
            workspaceId: workspace.id,
            planId: freePlan.id,
            clerkOrgId: workspace.clerkOrgId,
          },
        });

        await db
          .update(masterSchema.workspaces)
          .set({ stripeSubscriptionId: subscription.id, updatedAt: new Date() })
          .where(eq(masterSchema.workspaces.id, workspace.id));

        console.log(`  -> Created subscription: ${subscription.id}`);
      }

      created++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  -> FAILED: ${msg}`);
      failed++;
    }
  }

  console.log(`\nDone. Created: ${created}, Failed: ${failed}, Skipped: ${skipped}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
