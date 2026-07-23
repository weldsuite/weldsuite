/**
 * Seed the 3 `ai_gateway_credits` rows (ops service-credit config).
 *
 * A SCRIPT, not part of migration 0038, on purpose: allowances are ops config
 * that changes when a promo lands or a beta ends — not schema. Baking "$5" into
 * a migration means editing history to change your Vercel plan.
 *
 * Idempotent: re-running updates the ops-config columns and leaves the DERIVED
 * ones (spent_nano_usd / period / last_rolled_up_at) alone — those belong to the
 * rollup cron, and clobbering them here would erase real spend.
 *
 * Usage:
 *   DATABASE_URL_MASTER=... pnpm --filter @weldsuite/db seed:ai-gateway-credits
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';

import { aiGatewayCredits } from '../src/schema/ai-gateway-costs';

const USD = 1e9; // nano-USD per dollar

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 12);
  return `${prefix}_${ts}${rand}`;
}

interface Seed {
  gateway: string;
  allowanceNanoUsd: number | null;
  allowanceExpiresAt: Date | null;
  priority: number;
  notes: string;
}

const SEEDS: Seed[] = [
  {
    // Free during beta. The expiry is the important part: without it, routing
    // keeps preferring Neon after billing silently starts and you find out on an
    // invoice. Conservative by design — bump it when the real date is known.
    gateway: 'neon',
    allowanceNanoUsd: null, // unlimited *until* allowanceExpiresAt
    allowanceExpiresAt: new Date('2026-10-01T00:00:00Z'),
    priority: 10,
    notes:
      'Free during beta (needs a paid Neon plan). Unlimited until allowanceExpiresAt, then it ' +
      'stops counting as free automatically. Update the date when Neon publishes real rates.',
  },
  {
    // $5/mo of free AI Gateway credits per team, then list price at 0% markup.
    gateway: 'vercel',
    allowanceNanoUsd: 5 * USD,
    allowanceExpiresAt: null,
    priority: 20,
    notes: '$5/month free AI Gateway credits, resets monthly. 0% markup beyond that.',
  },
  {
    // Deliberately NO allowance. Cloudflare's free tier is Neurons/day (not
    // dollars) and @cf/* models are Cloudflare-only anyway, so there is nothing
    // honest to model here. For third-party it's list price + the 5% Unified
    // Billing fee — i.e. exactly the "no credit" case. It is the fallback.
    gateway: 'cloudflare',
    allowanceNanoUsd: null,
    allowanceExpiresAt: new Date('1970-01-01T00:00:00Z'), // never reads as "free"
    priority: 100,
    notes:
      'Fallback gateway — no dollar credit pool. Free tier is Neurons/day, not USD; @cf/* models ' +
      'route here regardless. allowanceExpiresAt is epoch so `null` allowance never reads as free.',
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_MASTER;
  if (!url) throw new Error('DATABASE_URL_MASTER is not set');

  const db = drizzle(neon(url));
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  for (const seed of SEEDS) {
    const [existing] = await db
      .select({ id: aiGatewayCredits.id })
      .from(aiGatewayCredits)
      .where(eq(aiGatewayCredits.gateway, seed.gateway))
      .limit(1);

    if (existing) {
      // Ops config only — never touch spentNanoUsd/period/lastRolledUpAt.
      await db
        .update(aiGatewayCredits)
        .set({
          allowanceNanoUsd: seed.allowanceNanoUsd,
          allowanceExpiresAt: seed.allowanceExpiresAt,
          priority: seed.priority,
          notes: seed.notes,
          updatedAt: now,
        })
        .where(eq(aiGatewayCredits.id, existing.id));
      console.log(`updated  ${seed.gateway}`);
      continue;
    }

    await db.insert(aiGatewayCredits).values({
      id: generateId('agc'),
      gateway: seed.gateway,
      allowanceNanoUsd: seed.allowanceNanoUsd,
      allowanceExpiresAt: seed.allowanceExpiresAt,
      priority: seed.priority,
      notes: seed.notes,
      resetPolicy: 'monthly',
      enabled: true,
      periodStart,
      periodEnd,
    });
    console.log(`inserted ${seed.gateway}`);
  }

  console.log('\nSeeded ai_gateway_credits. Verify in the admin console at /ai-costs.');
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
