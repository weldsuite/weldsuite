/**
 * Pricing Sync Routes
 *
 * Internal endpoints for syncing phone number pricing to Stripe.
 * Protected by X-Internal-API-Key header (platform-to-worker calls).
 *
 * Creates/updates Stripe Products and Prices for each country+type combo.
 * Stripe Prices are immutable, so when amount changes a new Price is created
 * and the old one is archived.
 */

import { Hono } from 'hono';
import type { Env } from '../index';
import {
  createStripeProduct,
  updateStripeProduct,
  createStripePrice,
  archiveStripePrice,
} from '../lib/stripe';
import { m2mAuth } from '../middleware/m2m-auth';

export const pricingSyncRoutes = new Hono<{ Bindings: Env }>();

// Verify M2M token on all routes
pricingSyncRoutes.use('*', m2mAuth());

// ============================================================================
// Shared sync logic
// ============================================================================

interface SyncPriceParams {
  countryCode: string;
  numberType: string;
  monthlyPrice: string;
  currency: string;
  existingProductId?: string | null;
  existingPriceId?: string | null;
}

interface SyncPriceResult {
  stripeProductId: string;
  stripePriceId: string;
}

async function syncSinglePrice(
  stripeKey: string,
  params: SyncPriceParams
): Promise<SyncPriceResult> {
  const productName = `Phone Number - ${params.countryCode} ${params.numberType}`;
  const unitAmount = Math.round(parseFloat(params.monthlyPrice) * 100);

  // 1. Create or update the Stripe Product
  let productId: string;

  if (params.existingProductId) {
    // Update product name/metadata if needed
    await updateStripeProduct(stripeKey, params.existingProductId, {
      name: productName,
      metadata: {
        countryCode: params.countryCode,
        numberType: params.numberType,
        managedBy: 'weldsuite',
      },
    });
    productId = params.existingProductId;
  } else {
    const product = await createStripeProduct(stripeKey, {
      name: productName,
      metadata: {
        countryCode: params.countryCode,
        numberType: params.numberType,
        managedBy: 'weldsuite',
      },
    });
    productId = product.id;
  }

  // 2. Create a new Stripe Price
  const newPrice = await createStripePrice(stripeKey, {
    productId,
    unitAmount,
    currency: params.currency,
    interval: 'month',
  });

  // 3. Archive old price if it differs from the new one
  if (params.existingPriceId && params.existingPriceId !== newPrice.id) {
    try {
      await archiveStripePrice(stripeKey, params.existingPriceId);
    } catch (err) {
      // Non-fatal: old price may already be archived
      console.warn(`[PricingSync] Failed to archive old price ${params.existingPriceId}:`, err);
    }
  }

  return {
    stripeProductId: productId,
    stripePriceId: newPrice.id,
  };
}

// ============================================================================
// POST /sync-price — Sync a single price to Stripe
// ============================================================================

pricingSyncRoutes.post('/sync-price', async (c) => {
  const body = await c.req.json<SyncPriceParams>();

  if (!body.countryCode || !body.numberType || !body.monthlyPrice || !body.currency) {
    return c.json({ error: 'Missing required fields: countryCode, numberType, monthlyPrice, currency' }, 400);
  }

  try {
    const result = await syncSinglePrice(c.env.STRIPE_SECRET_KEY, body);
    return c.json(result);
  } catch (error) {
    console.error('[PricingSync] sync-price failed:', error);
    return c.json({
      error: error instanceof Error ? error.message : 'Stripe sync failed',
    }, 500);
  }
});

// ============================================================================
// POST /sync-all-prices — Sync multiple prices to Stripe in batch
// ============================================================================

pricingSyncRoutes.post('/sync-all-prices', async (c) => {
  const body = await c.req.json<{ prices: SyncPriceParams[] }>();

  if (!body.prices || !Array.isArray(body.prices) || body.prices.length === 0) {
    return c.json({ error: 'Missing or empty prices array' }, 400);
  }

  const results: Array<{
    countryCode: string;
    numberType: string;
    stripeProductId?: string;
    stripePriceId?: string;
    error?: string;
  }> = [];

  for (const price of body.prices) {
    try {
      const result = await syncSinglePrice(c.env.STRIPE_SECRET_KEY, price);
      results.push({
        countryCode: price.countryCode,
        numberType: price.numberType,
        stripeProductId: result.stripeProductId,
        stripePriceId: result.stripePriceId,
      });
    } catch (error) {
      console.error(`[PricingSync] sync-all failed for ${price.countryCode}/${price.numberType}:`, error);
      results.push({
        countryCode: price.countryCode,
        numberType: price.numberType,
        error: error instanceof Error ? error.message : 'Stripe sync failed',
      });
    }
  }

  return c.json({ results });
});
