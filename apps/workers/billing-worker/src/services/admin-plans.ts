/**
 * Plan catalog management for the admin console (routes/admin.ts).
 *
 * The `plans` row is the source of truth; Stripe follows it. Saving a plan
 * makes sure its Stripe product exists and carries the current name, and that
 * its monthly/yearly prices match the plan's amounts. Stripe prices are
 * immutable, so a new amount means a new price; the old one is archived.
 * Existing subscribers stay on the archived price until someone changes their
 * subscription (the webhooks still map them to the plan through its product).
 *
 * Every Stripe object we touch is stamped with `metadata.lastSyncedAt`, which
 * makes the product/price webhooks skip the echo of our own write.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';
import type { Env } from '../index';
import { type getMasterDb, masterSchema } from '../lib/db';
import { generateId } from '../lib/id';
import { updateStripeProduct } from '../lib/stripe';
import { archivePlanPrice, createPlanPrice, createPlanProduct, retrievePrice } from '../lib/stripe-admin';
import { AdminBillingError } from './admin-billing';

const { plans } = masterSchema;

type MasterDb = ReturnType<typeof getMasterDb>;
type PlanRow = typeof plans.$inferSelect;

export interface PlanInput {
  name: string;
  slug: string;
  description: string | null;
  /** Decimal strings in major units, e.g. "12.50" (per seat, per period). */
  priceMonthly: string;
  priceYearly: string;
  currency: string;
  pricePerUser: string | null;
  includedUsers: number | null;
  monthlyCredits: number;
  creditsRolloverCap: number | null;
  maxUsers: number | null;
  maxProjects: number | null;
  maxCustomDomains: number | null;
  removeBranding: boolean;
  hasApiAccess: boolean;
  isActive: boolean;
  isDefault: boolean;
  sortOrder: number;
  badge: string | null;
  color: string | null;
  features: PlanFeatures;
}

/** Slug is fixed once created: code looks plans up by it (e.g. `free`). */
export type PlanPatch = Partial<Omit<PlanInput, 'slug'>>;

export interface StripeSyncResult {
  productId: string;
  monthlyPriceId: string | null;
  yearlyPriceId: string | null;
  /** What changed in Stripe, e.g. `product.created`, `price.monthly.replaced`. */
  changes: string[];
}

/**
 * "12.50" → 1250, from the decimal string itself (no float maths, so the same
 * amount always maps to the same price). A third decimal rounds half-up.
 */
export function toCents(amount: string): number {
  const [whole = '0', fraction = ''] = amount.trim().split('.');
  const cents = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0').slice(0, 2));
  return cents + (Number(fraction[2] ?? '0') >= 5 ? 1 : 0);
}

function syncStamp(plan: PlanRow, extra: Record<string, string> = {}): Record<string, string> {
  return { planId: plan.id, slug: plan.slug, lastSyncedAt: new Date().toISOString(), ...extra };
}

/** Bring one cycle's Stripe price in line with the plan; returns the price id to store. */
async function ensurePrice(
  key: string,
  plan: PlanRow,
  productId: string,
  cycle: 'monthly' | 'yearly',
  changes: string[],
): Promise<string | null> {
  const currentId = cycle === 'monthly' ? plan.stripePriceIdMonthly : plan.stripePriceIdYearly;
  const cents = toCents(cycle === 'monthly' ? plan.priceMonthly : plan.priceYearly);
  const interval = cycle === 'monthly' ? 'month' : 'year';
  const currency = plan.currency.toLowerCase();
  // A free plan still needs a $0 monthly price (it backs the free subscription);
  // a yearly price only exists when the plan sells a yearly option.
  const wanted = cycle === 'monthly' || cents > 0;

  let current = null;
  if (currentId) {
    try {
      current = await retrievePrice(key, currentId);
    } catch (err) {
      console.warn(`[Admin Plans] Could not load ${cycle} price ${currentId} of plan ${plan.id}:`, err);
    }
  }

  const currentProduct = current
    ? typeof current.product === 'string' ? current.product : current.product.id
    : null;
  const matches =
    current &&
    current.active &&
    current.unit_amount === cents &&
    current.currency === currency &&
    current.recurring?.interval === interval &&
    currentProduct === productId;

  if (wanted && matches) return current!.id;

  if (current?.active) {
    await archivePlanPrice(key, current.id, syncStamp(plan, { billingCycle: cycle }));
    changes.push(`price.${cycle}.archived`);
  }
  if (!wanted) return null;

  const created = await createPlanPrice(key, {
    productId,
    unitAmountCents: cents,
    currency,
    interval,
    metadata: syncStamp(plan, { billingCycle: cycle }),
  });
  changes.push(current ? `price.${cycle}.replaced` : `price.${cycle}.created`);
  return created.id;
}

/** Make Stripe match the plan row, and store the resulting ids on the row. */
export async function syncPlanToStripe(env: Env, masterDb: MasterDb, plan: PlanRow): Promise<StripeSyncResult> {
  if (!env.STRIPE_SECRET_KEY) throw new AdminBillingError('NOT_CONFIGURED', 'Stripe is not configured');
  const key = env.STRIPE_SECRET_KEY;
  const changes: string[] = [];

  let productId = plan.stripeProductId;
  if (productId) {
    await updateStripeProduct(key, productId, {
      name: plan.name,
      description: plan.description ?? '',
      active: plan.isActive,
      metadata: syncStamp(plan),
    });
    changes.push('product.updated');
  } else {
    productId = (
      await createPlanProduct(key, { name: plan.name, description: plan.description, metadata: syncStamp(plan) })
    ).id;
    changes.push('product.created');
  }

  const monthlyPriceId = await ensurePrice(key, plan, productId, 'monthly', changes);
  const yearlyPriceId = await ensurePrice(key, plan, productId, 'yearly', changes);

  await masterDb
    .update(plans)
    .set({
      stripeProductId: productId,
      stripePriceIdMonthly: monthlyPriceId,
      stripePriceIdYearly: yearlyPriceId,
      updatedAt: new Date(),
    })
    .where(eq(plans.id, plan.id));

  return { productId, monthlyPriceId, yearlyPriceId, changes };
}

async function loadPlan(masterDb: MasterDb, planId: string): Promise<PlanRow> {
  const [plan] = await masterDb
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), isNull(plans.deletedAt)))
    .limit(1);
  if (!plan) throw new AdminBillingError('NOT_FOUND', 'Plan not found');
  return plan;
}

/** Only one plan can be the default for new workspaces. */
async function clearOtherDefaults(masterDb: MasterDb, planId: string): Promise<void> {
  await masterDb
    .update(plans)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(plans.isDefault, true), ne(plans.id, planId)));
}

export async function createPlan(
  env: Env,
  masterDb: MasterDb,
  input: PlanInput,
): Promise<{ plan: PlanRow; stripe: StripeSyncResult | null; stripeError: string | null }> {
  const [taken] = await masterDb.select({ id: plans.id }).from(plans).where(eq(plans.slug, input.slug)).limit(1);
  if (taken) throw new AdminBillingError('CONFLICT', `A plan with the slug "${input.slug}" already exists`);

  const [plan] = await masterDb
    .insert(plans)
    .values({ id: generateId('plan'), ...input, currency: input.currency.toUpperCase() })
    .returning();
  if (!plan) throw new Error('Plan insert returned no row');
  if (plan.isDefault) await clearOtherDefaults(masterDb, plan.id);

  const sync = await trySync(env, masterDb, plan);
  return { plan: await loadPlan(masterDb, plan.id), ...sync };
}

export async function updatePlan(
  env: Env,
  masterDb: MasterDb,
  planId: string,
  patch: PlanPatch,
): Promise<{
  before: PlanRow;
  plan: PlanRow;
  stripe: StripeSyncResult | null;
  stripeError: string | null;
}> {
  const before = await loadPlan(masterDb, planId);
  const [plan] = await masterDb
    .update(plans)
    .set({
      ...patch,
      ...(patch.currency ? { currency: patch.currency.toUpperCase() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(plans.id, planId))
    .returning();
  if (!plan) throw new AdminBillingError('NOT_FOUND', 'Plan not found');
  if (patch.isDefault) await clearOtherDefaults(masterDb, plan.id);

  const sync = await trySync(env, masterDb, plan);
  return { before, plan: await loadPlan(masterDb, plan.id), ...sync };
}

export async function resyncPlan(env: Env, masterDb: MasterDb, planId: string): Promise<StripeSyncResult> {
  return syncPlanToStripe(env, masterDb, await loadPlan(masterDb, planId));
}

/**
 * The plan row is already saved; a Stripe failure is reported next to it
 * (the console offers "Sync to Stripe" again) rather than undoing the save.
 */
async function trySync(
  env: Env,
  masterDb: MasterDb,
  plan: PlanRow,
): Promise<{ stripe: StripeSyncResult | null; stripeError: string | null }> {
  try {
    return { stripe: await syncPlanToStripe(env, masterDb, plan), stripeError: null };
  } catch (err) {
    console.error(`[Admin Plans] Stripe sync failed for plan ${plan.id}:`, err);
    return { stripe: null, stripeError: err instanceof Error ? err.message : String(err) };
  }
}
