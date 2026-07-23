/**
 * AI gateway cost accounting — the OPS ledger.
 *
 * Two ledgers, deliberately separate:
 *   `credit_transactions` — what the CUSTOMER paid (their prepaid wallet).
 *   `ai_provider_usage`   — what WE paid the gateway to serve that same call.
 * The gap is margin. This module owns the second one.
 *
 * ## Why it lives in @weldsuite/credits
 *
 * `@weldsuite/ai` is pure (no DB) and per-app service code can't be shared, but both
 * AI charge paths (app-api + workflow-worker) already import this package, which
 * already imports the master schema. This is, literally, the other credit ledger.
 * (Charter note: this package says "the prepaid wallet"; ops service credit is
 * the owner's money, not a tenant's. If that boundary ever needs to be sharp,
 * this file moves to a `packages/ai-ops` — a file move, not a redesign.)
 *
 * ## Why spend is DERIVED, not incremented
 *
 * `ai_gateway_credits.spentNanoUsd` is re-aggregated from `ai_provider_usage` by
 * a cron rather than bumped per call. Two properties that buys:
 *   - **No hotspot.** `UPDATE … SET spent = spent + $1` would make ONE row the
 *     serialization point for every AI call on the platform. Append-only INSERTs
 *     have nothing to race — which answers concurrency by removing it.
 *   - **Self-healing.** A counter that misses a write drifts forever; a SUM heals
 *     on the next tick.
 *
 * ## Read the caveats before trusting the number
 *
 * `spentNanoUsd` is OUR MODEL of what a provider thinks we spent, computed from
 * `MODEL_PRICES` list prices. It drifts (cached-token discounts, per-request
 * fees, price changes we haven't mirrored). Reconcile monthly against the real
 * invoice via `manualAdjustmentNanoUsd`. It is a decision input, not an audit
 * record — and the fail-open path (master DB unreachable) records nothing at all
 * while the call still runs, so it under-counts by design.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';

const { aiProviderUsage, aiGatewayCredits } = masterSchema;

// Same escape hatch as index.ts: consumers use different Drizzle drivers whose
// client types are incompatible generics over the same runtime query API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CreditsDb = any;

/** The AI gateways WeldSuite records ops spend for. Cloudflare is the only one. */
export type Gateway = 'cloudflare';

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 12);
  return `${prefix}_${ts}${rand}`;
}

/** USD → integer nano-USD. Never negative; sub-nano rounds to 0. */
export function nanoUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 1e9);
}

/** Integer nano-USD → USD. Display/reporting only. */
export function usdFromNano(nano: number): number {
  return nano / 1e9;
}

// ---------------------------------------------------------------------------
// Write — hot path, once per completed AI call
// ---------------------------------------------------------------------------

export interface RecordProviderUsageParams {
  gateway: Gateway;
  /** CANONICAL model id — must match what `creditsForUsage()` was given. */
  modelId: string;
  usage: { inputTokens?: number; outputTokens?: number };
  op: string;
  /**
   * What WE paid, in nano-USD. The caller pre-computes it (via
   * `providerCostUsd()` × the gateway fee factor) so this package never has to
   * depend on `@weldsuite/ai` — keeps the dependency arrow one-way.
   */
  providerCostNanoUsd: number;
  creditsCharged: number;
  coveredByServiceCredit: boolean;
  workspaceId?: string | null;
  referenceType?: string;
  referenceId?: string;
  /** Usually the credit_transactions key + ':usage'. */
  idempotencyKey?: string;
}

/**
 * Append one ops-ledger row. **Never throws.**
 *
 * The AI call already succeeded and the customer is already being charged;
 * bookkeeping must not turn that into a user-visible failure. Returns the row id,
 * or `null` if the write failed (logged).
 */
export async function recordProviderUsage(
  db: CreditsDb,
  params: RecordProviderUsageParams,
): Promise<string | null> {
  const id = generateId('apu');
  try {
    await db
      .insert(aiProviderUsage)
      .values({
        id,
        gateway: params.gateway,
        modelId: params.modelId,
        workspaceId: params.workspaceId ?? null,
        op: params.op,
        inputTokens: params.usage.inputTokens ?? 0,
        outputTokens: params.usage.outputTokens ?? 0,
        providerCostNanoUsd: Math.max(0, Math.round(params.providerCostNanoUsd)),
        coveredByServiceCredit: params.coveredByServiceCredit,
        creditsCharged: params.creditsCharged,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        idempotencyKey: params.idempotencyKey,
      })
      // A retried step re-records the same call; the ledger must not double-count.
      .onConflictDoNothing({ target: aiProviderUsage.idempotencyKey });
    return id;
  } catch (err) {
    console.error('[credits/gateway-costs] failed to record provider usage:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read — cold path: cron + admin only, NEVER per call
// ---------------------------------------------------------------------------

export interface GatewayCreditRow {
  gateway: Gateway;
  /** `null` = unlimited / not credit-modelled (Cloudflare). */
  remainingNanoUsd: number | null;
  spentNanoUsd: number;
  allowanceNanoUsd: number | null;
  manualAdjustmentNanoUsd: number;
  allowanceExpiresAt: Date | null;
  enabled: boolean;
  priority: number;
  exhaustionMarginNanoUsd: number;
  periodStart: Date;
  periodEnd: Date;
  lastRolledUpAt: Date | null;
}

/**
 * Remaining ops credit, in nano-USD. Pure — unit-testable, no DB, injected clock.
 *
 * `null` means unlimited. Note the expiry rule: **an expired unlimited allowance
 * returns 0, not null.** That's the fail-safe for "free during beta" — when the
 * beta ends, the gateway must stop looking free rather than quietly running up a
 * bill nobody notices until the invoice.
 */
export function remainingNanoUsd(
  row: Pick<
    GatewayCreditRow,
    'allowanceNanoUsd' | 'manualAdjustmentNanoUsd' | 'spentNanoUsd' | 'allowanceExpiresAt' | 'exhaustionMarginNanoUsd'
  >,
  now: Date,
): number | null {
  const expired = row.allowanceExpiresAt !== null && row.allowanceExpiresAt.getTime() <= now.getTime();
  if (expired) return 0;
  if (row.allowanceNanoUsd === null) return null;

  const remaining = row.allowanceNanoUsd + row.manualAdjustmentNanoUsd - row.spentNanoUsd;
  // Treat "nearly gone" as gone: the router's snapshot lags reality by up to
  // ~120s, and the margin absorbs that. Overshooting just means paying list
  // price on a few calls — the customer's charge is unaffected either way.
  if (remaining <= row.exhaustionMarginNanoUsd) return 0;
  return remaining;
}

function toRow(r: Record<string, unknown>, now: Date): GatewayCreditRow {
  const base = {
    gateway: r.gateway as Gateway,
    spentNanoUsd: Number(r.spentNanoUsd ?? 0),
    allowanceNanoUsd: r.allowanceNanoUsd === null ? null : Number(r.allowanceNanoUsd),
    manualAdjustmentNanoUsd: Number(r.manualAdjustmentNanoUsd ?? 0),
    allowanceExpiresAt: (r.allowanceExpiresAt as Date | null) ?? null,
    enabled: Boolean(r.enabled),
    priority: Number(r.priority ?? 100),
    exhaustionMarginNanoUsd: Number(r.exhaustionMarginNanoUsd ?? 0),
    periodStart: r.periodStart as Date,
    periodEnd: r.periodEnd as Date,
    lastRolledUpAt: (r.lastRolledUpAt as Date | null) ?? null,
  };
  return { ...base, remainingNanoUsd: remainingNanoUsd(base, now) };
}

/** All gateway credit rows, with `remainingNanoUsd` computed. Cron + admin only. */
export async function readGatewayCredits(db: CreditsDb, now = new Date()): Promise<GatewayCreditRow[]> {
  const rows = await db.select().from(aiGatewayCredits);
  return rows.map((r: Record<string, unknown>) => toRow(r, now));
}

/** First day of the next UTC month. Mirrors the wallet's period math in index.ts. */
function nextMonthStart(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}
function monthStart(from: Date): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
}

/**
 * Re-derive `spentNanoUsd` per gateway and advance expired periods.
 *
 * Single-writer by construction: only `workflow-worker` has a cron, so this only
 * ever runs from one place. The period reset needs no zeroing — `spent` is a SUM
 * scoped by `periodStart`, so moving the window IS the reset.
 */
export async function rollupGatewayCredits(db: CreditsDb, now = new Date()): Promise<GatewayCreditRow[]> {
  const rows: Record<string, unknown>[] = await db.select().from(aiGatewayCredits);

  for (const row of rows) {
    let periodStart = row.periodStart as Date;
    let periodEnd = row.periodEnd as Date;

    if ((row.resetPolicy as string) === 'monthly' && now.getTime() >= periodEnd.getTime()) {
      periodStart = monthStart(now);
      periodEnd = nextMonthStart(now);
    }

    // Covered end-to-end by ai_provider_usage_gateway_created_idx.
    const [agg] = await db
      .select({ spent: sql<string>`COALESCE(SUM(${aiProviderUsage.providerCostNanoUsd}), 0)` })
      .from(aiProviderUsage)
      .where(
        and(
          eq(aiProviderUsage.gateway, row.gateway as string),
          gte(aiProviderUsage.createdAt, periodStart),
        ),
      );

    await db
      .update(aiGatewayCredits)
      .set({
        spentNanoUsd: Number(agg?.spent ?? 0),
        periodStart,
        periodEnd,
        lastRolledUpAt: now,
        updatedAt: now,
      })
      .where(eq(aiGatewayCredits.id, row.id as string));
  }

  return readGatewayCredits(db, now);
}
