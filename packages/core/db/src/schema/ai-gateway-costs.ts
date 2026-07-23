/**
 * AI gateway cost accounting — the OPS ledger (master DB, cross-tenant).
 *
 * This is deliberately a *second, separate* ledger from `credit_transactions`:
 *
 *   credit_transactions  = what the CUSTOMER was charged (their prepaid wallet).
 *   ai_provider_usage    = what WE paid the gateway to serve that call.
 *
 * The gap between them is your margin. Keeping them apart is what lets the
 * customer's price stay stable (canonical list price × markup) while the real
 * provider cost varies by gateway — see `packages/ai/src/billing-rates.ts`.
 *
 * ## Why the router needs this
 *
 * Routing prefers a gateway with unexhausted **service credit** (free Vercel
 * monthly credits, Neon's free beta, promos) because it is effectively free.
 * That only works if credit actually *burns down* — a static ops declaration
 * would keep pointing at an exhausted gateway forever. So spend is **derived**:
 * `ai_provider_usage` is append-only, and a cron re-aggregates it into
 * `ai_gateway_credits.spentNanoUsd`. A derived counter self-heals (a missed
 * write is corrected on the next tick) where an incrementing one drifts forever.
 *
 * ## Money is integer nano-USD
 *
 * `bigint(mode: 'number')`, per the `pending-uploads.ts` convention. Not
 * `numeric(10,2)` — that cannot represent a $0.000074 Workers AI call at all.
 * Not a float — `SUM()` over floats is non-deterministic across rollups.
 * A $0.006 Sonnet call = 6_000_000 ns; MAX_SAFE_INTEGER ≈ $9M cumulative, and
 * the counter is period-scoped anyway.
 */

import {
  pgTable,
  varchar,
  integer,
  bigint,
  smallint,
  boolean,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { workspaces } from './master';

/** USD → integer nano-USD. The one place this conversion lives. */
export function nanoUsd(usd: number): number {
  return Math.max(0, Math.round(usd * 1e9));
}

/** Integer nano-USD → USD. For display/reporting only. */
export function usdFromNano(nano: number): number {
  return nano / 1e9;
}

/**
 * Per-call AI cost, append-only.
 *
 * Append-only on purpose: an `UPDATE … SET spent = spent + $1` would make one
 * row the serialization point for every AI call on the platform (row-lock
 * queueing + HOT-update bloat). A plain INSERT has no hotspot and nothing to
 * race — two workers charging concurrently just write two rows.
 */
export const aiProviderUsage = pgTable('ai_provider_usage', {
  id: varchar('id', { length: 30 }).primaryKey(),

  /** cloudflare | vercel | neon — which gateway actually served the call. */
  gateway: varchar('gateway', { length: 20 }).notNull(),
  /** CANONICAL model id (never the gateway-native one) — keeps reports joinable. */
  modelId: varchar('model_id', { length: 200 }).notNull(),

  /** Nullable: unmetered/fail-open calls should still record cost when we can. */
  workspaceId: varchar('workspace_id', { length: 255 }).references(() => workspaces.id),

  /** generate | ai_generate | ai_classify | mail_draft | … */
  op: varchar('op', { length: 30 }).notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),

  /** What WE paid: list price × tokens × gateway fee. 0 when service credit covered it. */
  providerCostNanoUsd: bigint('provider_cost_nano_usd', { mode: 'number' }).notNull(),
  /** Was ops service credit covering this gateway when the call ran? */
  coveredByServiceCredit: boolean('covered_by_service_credit').notNull().default(false),

  /** What the CUSTOMER was charged — reconciles row-by-row against credit_transactions. */
  creditsCharged: integer('credits_charged').notNull().default(0),

  referenceType: varchar('reference_type', { length: 50 }),
  referenceId: varchar('reference_id', { length: 30 }),
  /** Usually the credit_transactions key + ':usage'. NULLs don't collide. */
  idempotencyKey: varchar('idempotency_key', { length: 255 }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // THE rollup index — the cron's only query is (gateway, created_at >= periodStart).
  index('ai_provider_usage_gateway_created_idx').on(table.gateway, table.createdAt),
  index('ai_provider_usage_created_at_idx').on(table.createdAt),
  index('ai_provider_usage_workspace_id_idx').on(table.workspaceId),
  index('ai_provider_usage_model_id_idx').on(table.modelId),
  uniqueIndex('ai_provider_usage_idempotency_key_idx').on(table.idempotencyKey),
]);

/**
 * Ops service-credit state — one row per gateway. **Global: no workspaceId.**
 * This is the owner's money, not a tenant's (precedent: `credit_packages`).
 *
 * Allowance (ops-configured) and the derived counter live in ONE row so the
 * router's whole answer is a single read. A table rather than env because
 * `spentNanoUsd` is a mutable counter env cannot hold — and splitting allowance
 * into env while the counter lives in the DB gives two sources that can disagree.
 */
export const aiGatewayCredits = pgTable('ai_gateway_credits', {
  id: varchar('id', { length: 30 }).primaryKey(),
  gateway: varchar('gateway', { length: 20 }).notNull(),

  // ── ops-configured ────────────────────────────────────────────────────────
  /**
   * NULL = unlimited/not-credit-modelled. Cloudflare is intentionally NULL: its
   * free tier is Neurons/day (not dollars), `@cf/…` is already forced there, and
   * third-party through CF is list price + the 5% fee — i.e. the "no credit"
   * case. It is the fallback, so there is nothing to model.
   */
  allowanceNanoUsd: bigint('allowance_nano_usd', { mode: 'number' }),
  /** Signed true-up from the real provider invoice — see the drift note below. */
  manualAdjustmentNanoUsd: bigint('manual_adjustment_nano_usd', { mode: 'number' })
    .notNull()
    .default(0),
  /**
   * Past this, the allowance stops counting as free. REQUIRED for "free during
   * beta" gateways: without a date, an unlimited allowance keeps winning after
   * billing silently starts, and you find out on an invoice.
   */
  allowanceExpiresAt: timestamp('allowance_expires_at', { withTimezone: true }),
  /** monthly | daily | never — how periodStart/End advance. */
  resetPolicy: varchar('reset_policy', { length: 20 }).notNull().default('monthly'),
  /** Lower wins among gateways that are free. Cloudflare sits last as fallback. */
  priority: smallint('priority').notNull().default(100),
  /** Ops kill switch — excluded from routing entirely when false. */
  enabled: boolean('enabled').notNull().default(true),
  /**
   * Treat as exhausted at `remaining <= margin`, not `<= 0`, to absorb the ~120s
   * worst-case staleness of the KV snapshot (default $0.25 ⇒ tolerates ~$0.125/min
   * burn, far above a $5/mo allowance's natural rate). Overshoot just means paying
   * list price on a few calls; the customer charge is unaffected either way.
   */
  exhaustionMarginNanoUsd: bigint('exhaustion_margin_nano_usd', { mode: 'number' })
    .notNull()
    .default(250_000_000),

  // ── derived — written ONLY by the rollup cron ─────────────────────────────
  /** SUM(ai_provider_usage.provider_cost_nano_usd) since periodStart. */
  spentNanoUsd: bigint('spent_nano_usd', { mode: 'number' }).notNull().default(0),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  /** Stale value here = your cron-health signal. */
  lastRolledUpAt: timestamp('last_rolled_up_at', { withTimezone: true }),

  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('ai_gateway_credits_gateway_idx').on(table.gateway),
  index('ai_gateway_credits_enabled_idx').on(table.enabled),
]);

export type AiProviderUsage = typeof aiProviderUsage.$inferSelect;
export type NewAiProviderUsage = typeof aiProviderUsage.$inferInsert;
export type AiGatewayCredit = typeof aiGatewayCredits.$inferSelect;
export type NewAiGatewayCredit = typeof aiGatewayCredits.$inferInsert;
