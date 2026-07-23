/**
 * Sync the premium subscription plans to Stripe.
 *
 * For each target plan (Business, Scale) this:
 *   1. Ensures a Stripe Product exists (creates one, or renames the existing
 *      product referenced by plans.stripe_product_id).
 *   2. Creates NEW monthly + yearly Prices at the premium per-seat amounts
 *      (Stripe Prices are immutable, so a price change = new Price).
 *   3. Archives the plan's previous monthly/yearly Prices.
 *   4. Writes stripe_product_id / stripe_price_id_monthly / stripe_price_id_yearly
 *      back onto the plans row.
 *
 * SAFE BY DEFAULT: dry-run unless you pass --apply. Nothing is mutated in Stripe
 * or the DB without --apply.
 *
 * Run AFTER 2026-07-premium-pricing.sql (which sets the new slugs/names).
 *
 *   Env required:
 *     STRIPE_SECRET_KEY      Stripe secret key for the target account (live or test)
 *     MASTER_DATABASE_URL    Postgres URL for the master DB (holds `plans`)
 *
 *   Usage (from repo root):
 *     tsx scripts/pricing/sync-stripe-plans.ts            # dry-run, prints plan
 *     tsx scripts/pricing/sync-stripe-plans.ts --apply    # actually mutate
 *
 * REVIEW the PLAN_PRICING config below before applying. Amounts are in the
 * currency's minor unit (cents). Annual amounts are the full yearly per-seat
 * charge (monthly-annual-rate × 12): Business $42/mo → $504/yr, Scale $59 → $708/yr.
 */

import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Config — REVIEW before running.
// ---------------------------------------------------------------------------
const CURRENCY = process.env.STRIPE_CURRENCY ?? 'usd'; // confirm vs plans.currency

interface PlanPricing {
  slug: string;          // plans.slug after the SQL migration
  productName: string;   // Stripe product name
  monthlyCents: number;  // per-seat monthly price
  yearlyCents: number;   // per-seat yearly price (annual rate × 12)
}

const PLAN_PRICING: PlanPricing[] = [
  { slug: 'business', productName: 'WeldSuite Business', monthlyCents: 4900, yearlyCents: 50400 },
  { slug: 'scale',    productName: 'WeldSuite Scale',    monthlyCents: 6900, yearlyCents: 70800 },
];

// ---------------------------------------------------------------------------
const APPLY = process.argv.includes('--apply');
const STRIPE_KEY = requireEnv('STRIPE_SECRET_KEY');
const DB_URL = requireEnv('MASTER_DATABASE_URL');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

async function stripe(method: string, path: string, body?: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  console.log(`\n=== Stripe plan sync — ${APPLY ? 'APPLY (live mutations)' : 'DRY RUN'} ===`);
  console.log(`Currency: ${CURRENCY}\n`);

  const sql = postgres(DB_URL, { max: 1 });
  try {
    for (const cfg of PLAN_PRICING) {
      const [plan] = await sql`
        SELECT id, name, slug, stripe_product_id, stripe_price_id_monthly, stripe_price_id_yearly
        FROM plans WHERE slug = ${cfg.slug} AND deleted_at IS NULL
      `;
      if (!plan) {
        console.warn(`! No plan row with slug='${cfg.slug}' — did the SQL migration run? Skipping.`);
        continue;
      }

      console.log(`\n--- ${cfg.slug} (${plan.name}) ---`);
      console.log(`  monthly: ${cfg.monthlyCents} ${CURRENCY} · yearly: ${cfg.yearlyCents} ${CURRENCY}`);

      if (!APPLY) {
        console.log(`  [dry-run] would ${plan.stripe_product_id ? 'reuse' : 'create'} product,`
          + ` create 2 new prices, archive old (${plan.stripe_price_id_monthly ?? 'none'},`
          + ` ${plan.stripe_price_id_yearly ?? 'none'}), and update the plans row.`);
        continue;
      }

      // 1) Product
      let productId: string = plan.stripe_product_id;
      if (productId) {
        await stripe('POST', `/v1/products/${productId}`, {
          name: cfg.productName,
          'metadata[managedBy]': 'weldsuite',
          'metadata[planSlug]': cfg.slug,
        });
        console.log(`  reused product ${productId}`);
      } else {
        const product = await stripe('POST', '/v1/products', {
          name: cfg.productName,
          'metadata[managedBy]': 'weldsuite',
          'metadata[planSlug]': cfg.slug,
        });
        productId = product.id;
        console.log(`  created product ${productId}`);
      }

      // 2) New prices (immutable)
      const monthly = await stripe('POST', '/v1/prices', {
        product: productId,
        unit_amount: String(cfg.monthlyCents),
        currency: CURRENCY,
        'recurring[interval]': 'month',
        'metadata[planSlug]': cfg.slug,
      });
      const yearly = await stripe('POST', '/v1/prices', {
        product: productId,
        unit_amount: String(cfg.yearlyCents),
        currency: CURRENCY,
        'recurring[interval]': 'year',
        'metadata[planSlug]': cfg.slug,
      });
      console.log(`  created prices: monthly ${monthly.id} · yearly ${yearly.id}`);

      // 3) Archive old prices (best-effort)
      for (const old of [plan.stripe_price_id_monthly, plan.stripe_price_id_yearly]) {
        if (old && old !== monthly.id && old !== yearly.id) {
          try {
            await stripe('POST', `/v1/prices/${old}`, { active: 'false' });
            console.log(`  archived old price ${old}`);
          } catch (e) {
            console.warn(`  ! could not archive ${old}: ${(e as Error).message}`);
          }
        }
      }

      // 4) Write ids back
      await sql`
        UPDATE plans SET
          stripe_product_id      = ${productId},
          stripe_price_id_monthly = ${monthly.id},
          stripe_price_id_yearly  = ${yearly.id},
          updated_at = now()
        WHERE id = ${plan.id}
      `;
      console.log(`  updated plans row ${plan.id}`);
    }

    console.log(`\n=== Done (${APPLY ? 'applied' : 'dry run — re-run with --apply'}) ===\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
