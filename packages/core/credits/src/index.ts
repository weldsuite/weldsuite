/**
 * @weldsuite/credits — the single credit engine for the prepaid wallet.
 *
 * Every workspace has ONE balance (`workspace_credits.currentBalance` in the
 * MASTER database). All metered services (AI tokens, VoIP calls, call
 * transcription, social posts, parcel labels, …) consume from it, and topups
 * purchased via Stripe grant into it. This package is the only place that
 * mutates the balance — agent-worker, app-api, billing-worker and
 * packages/ai all call through here.
 *
 * Guarantees:
 * - No overdraft: consumption uses an atomic conditional UPDATE
 *   (`currentBalance >= amount`) so concurrent requests can't overspend.
 * - Idempotency: callers pass an `idempotencyKey`; a unique index on
 *   `credit_transactions.idempotency_key` makes retries (webhook replays,
 *   queue redeliveries) record exactly one ledger row and exactly one balance
 *   change. On a lost race the balance change is compensated.
 * - Full audit trail: every balance change writes a `credit_transactions` row
 *   with `balanceAfter`.
 *
 * Driver note: consumers use different Drizzle drivers (neon-http in
 * agent-worker/app-api, postgres-js over Hyperdrive in billing-worker).
 * Interactive transactions are NOT available on neon-http, so the engine is
 * written as ordered single statements with compensation instead of relying
 * on `db.transaction()`.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';

const { workspaceCredits, creditTransactions, workspaces } = masterSchema;

/**
 * Consumers use different Drizzle drivers (neon-http / postgres-js) whose
 * client types are incompatible generics over the same runtime query API.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CreditsDb = any;

// ============================================================================
// Types & constants
// ============================================================================

export type CreditServiceType =
  | 'ai_tokens'
  | 'parcel_label'
  | 'meeting_bot'
  | 'call_transcription'
  | 'sms'
  | 'voip_call'
  | 'data_enrichment'
  | 'social_post';

export type CreditGrantType = 'purchase' | 'refund' | 'adjustment' | 'monthly_allocation';

/** Standard machine-readable error code surfaced as HTTP 402 by API layers. */
export const INSUFFICIENT_CREDITS = 'INSUFFICIENT_CREDITS';

/** Balance below this is flagged `isLow` in balance responses. */
export const LOW_BALANCE_THRESHOLD = 100;

/**
 * Default credit rates per metered unit. AI token rates are per-model in the
 * master `ai_model_rates` table; these cover everything else (and the AI
 * fallback when a model isn't seeded).
 */
export const SERVICE_CREDIT_RATES = {
  /** Fallback credits per 1000 AI tokens when the model has no ai_model_rates row. */
  aiTokensPerK: 1,
  /** Credits per Anthropic server-side web search. */
  webSearch: 10,
  /** Credits per platform a social post is published/scheduled to. */
  socialPostPerPlatform: 2,
  /** Credits per started minute of a VoIP call. */
  voipCallPerMinute: 3,
  /** Credits per started minute of call transcription. */
  callTranscriptionPerMinute: 2,
  /** Credits per parcel shipping label. */
  parcelLabel: 10,
  /** Credits per started minute of meeting bot recording. */
  meetingBotPerMinute: 2,
} as const;

export interface CreditTransactionMetadata {
  [key: string]: unknown;
}

export interface ConsumeCreditsParams {
  workspaceId: string;
  /** Positive integer amount of credits to consume. */
  amount: number;
  serviceType: CreditServiceType;
  /**
   * Stable key for this consumption (e.g. usage row id, `voip:{callId}`,
   * `social:{postId}:{attempt}`). Retries with the same key are no-ops.
   */
  idempotencyKey?: string;
  referenceId?: string;
  referenceType?: string;
  description?: string;
  metadata?: CreditTransactionMetadata;
  userId?: string;
}

export interface GrantCreditsParams {
  workspaceId: string;
  /** Credits to add. Negative only for `adjustment` (refund clawback / debt). */
  amount: number;
  type: CreditGrantType;
  /** Stable key (e.g. Stripe checkout session id). Retries are no-ops. */
  idempotencyKey?: string;
  /** Service attribution for refunds / negative settlements. */
  serviceType?: CreditServiceType;
  referenceId?: string;
  referenceType?: string;
  description?: string;
  metadata?: CreditTransactionMetadata;
  userId?: string;
  // Purchase details
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  amountPaid?: string;
  currency?: string;
}

export type ConsumeCreditsResult =
  | { ok: true; transactionId: string; newBalance: number; duplicate: boolean }
  | { ok: false; reason: typeof INSUFFICIENT_CREDITS; currentBalance: number; required: number };

export interface GrantCreditsResult {
  ok: true;
  transactionId: string;
  newBalance: number;
  duplicate: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 12);
  return `${prefix}_${ts}${rand}`;
}

function assertPositiveInt(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`[credits] ${label} must be a positive integer, got ${amount}`);
  }
}

/** Resolve the internal workspace id for a Clerk org id. */
export async function resolveInternalWorkspaceId(
  db: CreditsDb,
  clerkOrgId: string,
): Promise<string | null> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .limit(1);
  return ws?.id ?? null;
}

/** Find an existing ledger row by idempotency key (dedupe fast path). */
async function findByIdempotencyKey(
  db: CreditsDb,
  idempotencyKey: string,
): Promise<{ id: string; balanceAfter: number } | null> {
  const [existing] = await db
    .select({ id: creditTransactions.id, balanceAfter: creditTransactions.balanceAfter })
    .from(creditTransactions)
    .where(eq(creditTransactions.idempotencyKey, idempotencyKey))
    .limit(1);
  return existing ?? null;
}

// ============================================================================
// Wallet row
// ============================================================================

/** Get or create the `workspace_credits` row for a workspace. */
export async function getOrCreateWorkspaceCredits(db: CreditsDb, workspaceId: string) {
  const [existing] = await db
    .select()
    .from(workspaceCredits)
    .where(eq(workspaceCredits.workspaceId, workspaceId))
    .limit(1);
  if (existing) return existing;

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const newCredits = {
    id: generateId('wcr'),
    workspaceId,
    currentBalance: 0,
    planCredits: 0,
    subscribedCredits: 0,
    monthlyAllocation: 0,
    rolledOverCredits: 0,
    rolloverCap: null,
    periodStart,
    periodEnd,
    lastResetAt: null,
  };

  // Unique index on workspaceId — a concurrent creator wins, re-read after.
  await db.insert(workspaceCredits).values(newCredits).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(workspaceCredits)
    .where(eq(workspaceCredits.workspaceId, workspaceId))
    .limit(1);
  return row ?? newCredits;
}

export interface BalanceSummary {
  currentBalance: number;
  isLow: boolean;
  isExhausted: boolean;
}

/** Read the prepaid balance for a workspace (creates the row on first read). */
export async function getBalance(db: CreditsDb, workspaceId: string): Promise<BalanceSummary> {
  const credits = await getOrCreateWorkspaceCredits(db, workspaceId);
  return {
    currentBalance: credits.currentBalance,
    isLow: credits.currentBalance < LOW_BALANCE_THRESHOLD,
    isExhausted: credits.currentBalance <= 0,
  };
}

export interface CheckCreditsResult {
  available: boolean;
  currentBalance: number;
  required: number;
  shortfall: number;
}

/**
 * Pre-flight check — advisory only (the atomic guard in `consumeCredits` is
 * what actually prevents overdraft). Use before starting expensive external
 * work (AI call, VoIP call, PostPeer submit).
 */
export async function checkCredits(
  db: CreditsDb,
  workspaceId: string,
  amount: number,
): Promise<CheckCreditsResult> {
  assertPositiveInt(amount, 'amount');
  const credits = await getOrCreateWorkspaceCredits(db, workspaceId);
  const available = credits.currentBalance >= amount;
  return {
    available,
    currentBalance: credits.currentBalance,
    required: amount,
    shortfall: available ? 0 : amount - credits.currentBalance,
  };
}

// ============================================================================
// Consume
// ============================================================================

/**
 * Atomically consume credits and record the ledger row.
 *
 * Ordering (no interactive transaction available on neon-http):
 *  1. dedupe fast-path on idempotencyKey
 *  2. conditional decrement (`currentBalance >= amount`) — the overdraft guard
 *  3. ledger insert with `onConflictDoNothing` on the idempotency key;
 *     a lost race compensates the decrement from step 2.
 */
export async function consumeCredits(
  db: CreditsDb,
  params: ConsumeCreditsParams,
): Promise<ConsumeCreditsResult> {
  assertPositiveInt(params.amount, 'amount');
  const { workspaceId, amount } = params;

  if (params.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, params.idempotencyKey);
    if (existing) {
      return { ok: true, transactionId: existing.id, newBalance: existing.balanceAfter, duplicate: true };
    }
  }

  const credits = await getOrCreateWorkspaceCredits(db, workspaceId);

  const [updated] = await db
    .update(workspaceCredits)
    .set({
      currentBalance: sql`${workspaceCredits.currentBalance} - ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(eq(workspaceCredits.workspaceId, workspaceId), gte(workspaceCredits.currentBalance, amount)))
    .returning({ newBalance: workspaceCredits.currentBalance });

  if (!updated) {
    return {
      ok: false,
      reason: INSUFFICIENT_CREDITS,
      currentBalance: credits.currentBalance,
      required: amount,
    };
  }

  const transactionId = generateId('ctx');
  const inserted = await db
    .insert(creditTransactions)
    .values({
      id: transactionId,
      workspaceId,
      type: 'consumption',
      amount: -amount,
      balanceAfter: updated.newBalance,
      serviceType: params.serviceType,
      referenceId: params.referenceId,
      referenceType: params.referenceType,
      idempotencyKey: params.idempotencyKey,
      description: params.description ?? `${params.serviceType} consumption`,
      metadata: params.metadata,
      userId: params.userId,
    })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
    .returning({ id: creditTransactions.id });

  if (inserted.length === 0 && params.idempotencyKey) {
    // Lost an idempotency race after decrementing — compensate the decrement
    // and report the winner's transaction.
    await db
      .update(workspaceCredits)
      .set({
        currentBalance: sql`${workspaceCredits.currentBalance} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceCredits.workspaceId, workspaceId));
    const winner = await findByIdempotencyKey(db, params.idempotencyKey);
    if (winner) {
      return { ok: true, transactionId: winner.id, newBalance: winner.balanceAfter, duplicate: true };
    }
  }

  return { ok: true, transactionId, newBalance: updated.newBalance, duplicate: false };
}

// ============================================================================
// Grant (purchase / refund / adjustment / monthly grant)
// ============================================================================

/**
 * Add (or, for adjustments, subtract) credits and record the ledger row.
 * Grants have no lower-bound guard: a refund clawback may push the balance
 * negative — visible debt is preferred over hidden loss.
 */
export async function grantCredits(
  db: CreditsDb,
  params: GrantCreditsParams,
): Promise<GrantCreditsResult> {
  const { workspaceId, amount, type } = params;
  if (!Number.isInteger(amount) || amount === 0) {
    throw new Error(`[credits] grant amount must be a non-zero integer, got ${amount}`);
  }
  if (amount < 0 && type !== 'adjustment') {
    throw new Error(`[credits] negative grants are only allowed for adjustments (got type=${type})`);
  }

  if (params.idempotencyKey) {
    const existing = await findByIdempotencyKey(db, params.idempotencyKey);
    if (existing) {
      return { ok: true, transactionId: existing.id, newBalance: existing.balanceAfter, duplicate: true };
    }
  }

  await getOrCreateWorkspaceCredits(db, workspaceId);

  const [updated] = await db
    .update(workspaceCredits)
    .set({
      currentBalance: sql`${workspaceCredits.currentBalance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(workspaceCredits.workspaceId, workspaceId))
    .returning({ newBalance: workspaceCredits.currentBalance });

  if (!updated) {
    throw new Error(`[credits] workspace_credits row missing for workspace ${workspaceId}`);
  }

  const transactionId = generateId('ctx');
  const inserted = await db
    .insert(creditTransactions)
    .values({
      id: transactionId,
      workspaceId,
      type,
      amount,
      balanceAfter: updated.newBalance,
      serviceType: params.serviceType,
      referenceId: params.referenceId,
      referenceType: params.referenceType,
      idempotencyKey: params.idempotencyKey,
      stripePaymentIntentId: params.stripePaymentIntentId,
      stripeCheckoutSessionId: params.stripeCheckoutSessionId,
      amountPaid: params.amountPaid,
      currency: params.currency,
      description: params.description ?? `${type} of ${amount} credits`,
      metadata: params.metadata,
      userId: params.userId,
    })
    .onConflictDoNothing({ target: creditTransactions.idempotencyKey })
    .returning({ id: creditTransactions.id });

  if (inserted.length === 0 && params.idempotencyKey) {
    // Lost an idempotency race after incrementing — compensate.
    await db
      .update(workspaceCredits)
      .set({
        currentBalance: sql`${workspaceCredits.currentBalance} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(workspaceCredits.workspaceId, workspaceId));
    const winner = await findByIdempotencyKey(db, params.idempotencyKey);
    if (winner) {
      return { ok: true, transactionId: winner.id, newBalance: winner.balanceAfter, duplicate: true };
    }
  }

  return { ok: true, transactionId, newBalance: updated.newBalance, duplicate: false };
}

/** Convenience wrapper — refund a prior consumption (e.g. failed publish). */
export async function refundCredits(
  db: CreditsDb,
  params: Omit<GrantCreditsParams, 'type'>,
): Promise<GrantCreditsResult> {
  return grantCredits(db, { ...params, type: 'refund' });
}
