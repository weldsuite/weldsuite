import 'server-only';

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';

import { getMasterDb } from './db';

const { aiProviderUsage, aiGatewayCredits } = masterSchema;

/**
 * AI gateway cost reporting — the OPS view of what each gateway costs us.
 *
 * Lives in `apps/web/admin`, deliberately NOT in app-api: every `/api/*` handler
 * there is org-scoped, so serving cross-tenant ops financials from it would be a
 * tenancy leak waiting to happen. This app already has a master-DB client and a
 * Clerk superadmin gate.
 *
 * Read-only. The rollup cron in workflow-worker is the only writer.
 */

export interface GatewayCreditSummary {
  gateway: string;
  allowanceNanoUsd: number | null;
  manualAdjustmentNanoUsd: number;
  spentNanoUsd: number;
  /** null = unlimited / not credit-modelled (Cloudflare). */
  remainingNanoUsd: number | null;
  allowanceExpiresAt: Date | null;
  enabled: boolean;
  priority: number;
  periodStart: Date;
  periodEnd: Date;
  /** Stale => the rollup cron is wedged. This is the health signal. */
  lastRolledUpAt: Date | null;
}

export interface GatewayMonthRow {
  gateway: string;
  month: string;
  /** What we PAID the gateway, USD. */
  costUsd: number;
  /** What customers were CHARGED, USD (credits / CREDITS_PER_USD). */
  billedUsd: number;
  calls: number;
  /** Calls covered by ops service credit — i.e. cost us $0. */
  freeCalls: number;
}

export interface ModelCostRow {
  modelId: string;
  gateway: string;
  costUsd: number;
  calls: number;
}

/** Credits per USD — mirrors CREDITS_PER_USD in packages/core/ai/src/billing-rates.ts. */
const CREDITS_PER_USD = 100;

function nanoToUsd(nano: unknown): number {
  return Number(nano ?? 0) / 1e9;
}

/**
 * Remaining ops credit. Mirrors `remainingNanoUsd` in
 * `packages/core/credits/src/gateway-costs.ts` — including the rule that an EXPIRED
 * unlimited allowance reads as 0, not unlimited (the "free beta ended" guard).
 */
function remaining(row: {
  allowanceNanoUsd: number | null;
  manualAdjustmentNanoUsd: number;
  spentNanoUsd: number;
  allowanceExpiresAt: Date | null;
  exhaustionMarginNanoUsd: number;
}, now: Date): number | null {
  if (row.allowanceExpiresAt && row.allowanceExpiresAt.getTime() <= now.getTime()) return 0;
  if (row.allowanceNanoUsd === null) return null;
  const left = row.allowanceNanoUsd + row.manualAdjustmentNanoUsd - row.spentNanoUsd;
  return left <= row.exhaustionMarginNanoUsd ? 0 : left;
}

/** The 3-row live report: allowance, spend, what's left. */
export async function getGatewayCredits(now = new Date()): Promise<GatewayCreditSummary[]> {
  const db = getMasterDb();
  const rows = await db.select().from(aiGatewayCredits).orderBy(aiGatewayCredits.priority);

  return rows.map((r) => {
    const base = {
      allowanceNanoUsd: r.allowanceNanoUsd === null ? null : Number(r.allowanceNanoUsd),
      manualAdjustmentNanoUsd: Number(r.manualAdjustmentNanoUsd ?? 0),
      spentNanoUsd: Number(r.spentNanoUsd ?? 0),
      allowanceExpiresAt: r.allowanceExpiresAt,
      exhaustionMarginNanoUsd: Number(r.exhaustionMarginNanoUsd ?? 0),
    };
    return {
      gateway: r.gateway,
      ...base,
      remainingNanoUsd: remaining(base, now),
      enabled: r.enabled,
      priority: r.priority,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      lastRolledUpAt: r.lastRolledUpAt,
    };
  });
}

/**
 * THE margin report: what we paid vs what we charged, by gateway and month.
 * Where `freeCalls` is high, cost is ~$0 and margin is ~100% — that's the
 * service-credit routing paying for itself, made visible.
 */
export async function getSpendByGatewayMonth(monthsBack = 6): Promise<GatewayMonthRow[]> {
  const db = getMasterDb();
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - monthsBack, 1);
  since.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      gateway: aiProviderUsage.gateway,
      month: sql<string>`to_char(date_trunc('month', ${aiProviderUsage.createdAt}), 'YYYY-MM')`,
      costNano: sql<string>`COALESCE(SUM(${aiProviderUsage.providerCostNanoUsd}), 0)`,
      credits: sql<string>`COALESCE(SUM(${aiProviderUsage.creditsCharged}), 0)`,
      calls: sql<string>`COUNT(*)`,
      freeCalls: sql<string>`COUNT(*) FILTER (WHERE ${aiProviderUsage.coveredByServiceCredit})`,
    })
    .from(aiProviderUsage)
    .where(gte(aiProviderUsage.createdAt, since))
    .groupBy(aiProviderUsage.gateway, sql`date_trunc('month', ${aiProviderUsage.createdAt})`)
    .orderBy(desc(sql`date_trunc('month', ${aiProviderUsage.createdAt})`), aiProviderUsage.gateway);

  return rows.map((r) => ({
    gateway: r.gateway,
    month: r.month,
    costUsd: nanoToUsd(r.costNano),
    billedUsd: Number(r.credits ?? 0) / CREDITS_PER_USD,
    calls: Number(r.calls ?? 0),
    freeCalls: Number(r.freeCalls ?? 0),
  }));
}

/** Where the money actually goes, this period. */
export async function getTopModelsByCost(limit = 10): Promise<ModelCostRow[]> {
  const db = getMasterDb();
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      modelId: aiProviderUsage.modelId,
      gateway: aiProviderUsage.gateway,
      costNano: sql<string>`COALESCE(SUM(${aiProviderUsage.providerCostNanoUsd}), 0)`,
      calls: sql<string>`COUNT(*)`,
    })
    .from(aiProviderUsage)
    .where(gte(aiProviderUsage.createdAt, since))
    .groupBy(aiProviderUsage.modelId, aiProviderUsage.gateway)
    .orderBy(desc(sql`COALESCE(SUM(${aiProviderUsage.providerCostNanoUsd}), 0)`))
    .limit(limit);

  return rows.map((r) => ({
    modelId: r.modelId,
    gateway: r.gateway,
    costUsd: nanoToUsd(r.costNano),
    calls: Number(r.calls ?? 0),
  }));
}
