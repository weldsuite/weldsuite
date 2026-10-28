/**
 * Usage meters — plan allowances with overage paid from the credit wallet.
 *
 * Every metered thing a workspace does (a workflow run, a signature request
 * sent, …) is counted per UTC month in the master `workspace_meter_usage`
 * table. The plan includes an allowance per meter (`plans.features`); past it,
 * usage is paid in blocks from the same prepaid wallet AI draws from: the first
 * unit of a new block charges the whole block, the rest of the block is free.
 * A plan that does not allow overage (free plans, by default) stops at the
 * allowance instead.
 *
 * AI is not a meter: its cost varies per call, so it is charged in credits
 * directly (`@weldsuite/core-domain/ai-billing`) and the plan's
 * `monthlyCredits` is its allowance.
 *
 * Enforcement: call {@link meterUsage} BEFORE doing the work. It counts the
 * units, charges a block when one is crossed, and refuses with a
 * {@link MeterDenied} when the limit or the wallet says no. When the work then
 * does not happen, hand the reservation back with {@link releaseMeterUsage}.
 * Infrastructure errors fail open (the work goes ahead, uncounted), the same
 * posture as AI billing: a metering outage must not stop a customer's work.
 *
 * Counting is not idempotent: a caller retrying the same unit counts it
 * twice. Call it from a step whose result is persisted (a Cloudflare Workflow
 * `step.do`) or from a request that is not retried.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';
import {
  INSUFFICIENT_CREDITS,
  consumeCredits,
  refundCredits,
  type CreditServiceType,
  type CreditsDb,
} from './index';

const { workspaceMeterUsage, workspaces, plans } = masterSchema;

// ============================================================================
// Catalog
// ============================================================================

export type MeterKey = 'workflow_runs' | 'sign_requests' | 'emails';

export interface MeterDefinition {
  key: MeterKey;
  /** What one unit is, for messages ("run", "signature request"). */
  unit: string;
  unitPlural: string;
  /** Ledger attribution of the overage charges. */
  serviceType: CreditServiceType;
  /** The `plans.features` key holding the monthly allowance (null = unlimited). */
  planFeature: 'taskExecutions' | 'signRequestsPerMonth' | 'emailsPerMonth';
  /** Allowance when the plan does not set one. */
  defaultAllowance: number;
  /** Units per overage block. */
  blockSize: number;
  /** Credits one overage block costs (1 credit = 0.01). */
  creditsPerBlock: number;
}

export const METERS: Record<MeterKey, MeterDefinition> = {
  workflow_runs: {
    key: 'workflow_runs',
    unit: 'workflow run',
    unitPlural: 'workflow runs',
    serviceType: 'workflow_run',
    planFeature: 'taskExecutions',
    defaultAllowance: 500,
    blockSize: 100,
    creditsPerBlock: 20,
  },
  sign_requests: {
    key: 'sign_requests',
    unit: 'signature request',
    unitPlural: 'signature requests',
    serviceType: 'sign_request',
    planFeature: 'signRequestsPerMonth',
    defaultAllowance: 3,
    blockSize: 1,
    creditsPerBlock: 50,
  },
  // Defined for the usage overview; sending is not metered yet (the outbound
  // mail guard is where it will be, docs/plans/weldmail-outbound-abuse.md).
  emails: {
    key: 'emails',
    unit: 'email',
    unitPlural: 'emails',
    serviceType: 'email',
    planFeature: 'emailsPerMonth',
    defaultAllowance: 1000,
    blockSize: 1000,
    creditsPerBlock: 100,
  },
};

export const METER_KEYS = Object.keys(METERS) as MeterKey[];

// ============================================================================
// Plan limits
// ============================================================================

export interface MeterLimits {
  /** Units included per month; `null` = unlimited. */
  allowance: number | null;
  /** Past the allowance: pay from the wallet (true) or stop (false). */
  allowOverage: boolean;
  planName: string;
}

type PlanRow = typeof plans.$inferSelect;

function isPaidPlan(plan: Pick<PlanRow, 'priceMonthly' | 'pricePerUser'>): boolean {
  return Number(plan.priceMonthly ?? 0) > 0 || Number(plan.pricePerUser ?? 0) > 0;
}

/** Read one meter's limits off a plan row (`null` = the workspace has no plan at all). */
export function limitsFromPlan(meter: MeterKey, plan: PlanRow | null): MeterLimits {
  const def = METERS[meter];
  if (!plan) return { allowance: def.defaultAllowance, allowOverage: false, planName: 'Free' };
  const features = (plan.features ?? {}) as PlanFeatures;
  const raw = features[def.planFeature];
  let allowance: number | null = def.defaultAllowance;
  if (raw === null) allowance = null;
  else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) allowance = Math.floor(raw);
  const allowOverage = typeof features.allowOverage === 'boolean' ? features.allowOverage : isPaidPlan(plan);
  return { allowance, allowOverage, planName: plan.name };
}

/** The workspace's plan, else the default plan, else none. */
async function workspacePlan(db: CreditsDb, workspaceId: string): Promise<PlanRow | null> {
  const [ws] = await db
    .select({ planId: workspaces.planId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (ws?.planId) {
    const [plan] = await db.select().from(plans).where(eq(plans.id, ws.planId)).limit(1);
    if (plan) return plan;
  }
  const [fallback] = await db.select().from(plans).where(eq(plans.isDefault, true)).limit(1);
  return fallback ?? null;
}

// ============================================================================
// Metering
// ============================================================================

/** The UTC month a moment falls in, `YYYY-MM`. */
export function meterPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `wmu_${Date.now().toString(36)}${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
}

export interface MeterUsageParams {
  /** Master `workspaces.id`. */
  workspaceId: string;
  meter: MeterKey;
  /** Units to count, default 1. */
  quantity?: number;
  /** What the units are for (an execution or envelope id), recorded on any charge. */
  referenceId?: string;
  referenceType?: string;
  userId?: string;
  now?: Date;
}

/** What {@link releaseMeterUsage} needs to hand counted units (and their charge) back. */
export interface MeterReservation {
  workspaceId: string;
  meter: MeterKey;
  period: string;
  quantity: number;
  /** Blocks this call paid for, and the ledger row it paid with. */
  blocks: number;
  credits: number;
  transactionId: string | null;
}

export interface MeterAllowed {
  allowed: true;
  /** `null` when metering was unavailable (fail-open): nothing to release. */
  reservation: MeterReservation | null;
  used: number;
  allowance: number | null;
  /** Credits this call took from the wallet (0 while inside the allowance or a paid block). */
  creditsCharged: number;
}

export interface MeterDenied {
  allowed: false;
  reason: 'limit_reached' | 'insufficient_credits';
  meter: MeterKey;
  /** Units used this month, without the refused ones. */
  used: number;
  allowance: number | null;
  planName: string;
  /** For `insufficient_credits`: what the block costs and what the wallet holds. */
  required?: number;
  currentBalance?: number;
}

export type MeterUsageResult = MeterAllowed | MeterDenied;

/** How many CAS rounds a block claim gets before giving up (fail-open). */
const MAX_CLAIM_ATTEMPTS = 5;

/**
 * Count `quantity` units of a meter, paying a new overage block from the
 * wallet when they cross into one. Refuses (and counts nothing) when the plan
 * stops at its allowance or the wallet cannot pay the block.
 */
export async function meterUsage(db: CreditsDb, params: MeterUsageParams): Promise<MeterUsageResult> {
  const quantity = params.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`[meters] quantity must be a positive integer, got ${quantity}`);
  }
  const def = METERS[params.meter];
  const period = meterPeriod(params.now);

  let row: { id: string; used: number; blocksCharged: number };
  let limits: MeterLimits;
  try {
    limits = limitsFromPlan(params.meter, await workspacePlan(db, params.workspaceId));
    [row] = await db
      .insert(workspaceMeterUsage)
      .values({ id: generateId(), workspaceId: params.workspaceId, meter: params.meter, period, used: quantity })
      .onConflictDoUpdate({
        target: [workspaceMeterUsage.workspaceId, workspaceMeterUsage.meter, workspaceMeterUsage.period],
        set: { used: sql`${workspaceMeterUsage.used} + ${quantity}`, updatedAt: new Date() },
      })
      .returning({ id: workspaceMeterUsage.id, used: workspaceMeterUsage.used, blocksCharged: workspaceMeterUsage.blocksCharged });
  } catch (err) {
    console.warn(`[meters] ${params.meter} metering unavailable, allowing:`, err instanceof Error ? err.message : err);
    return { allowed: true, reservation: null, used: 0, allowance: null, creditsCharged: 0 };
  }

  const reservation: MeterReservation = {
    workspaceId: params.workspaceId,
    meter: params.meter,
    period,
    quantity,
    blocks: 0,
    credits: 0,
    transactionId: null,
  };
  const allowed = (creditsCharged: number): MeterAllowed => ({
    allowed: true,
    reservation,
    used: row.used,
    allowance: limits.allowance,
    creditsCharged,
  });

  if (limits.allowance === null) return allowed(0);
  // The blocks the units up to and including ours need paid for.
  const needed = Math.ceil(Math.max(0, row.used - limits.allowance) / def.blockSize);
  let charged = row.blocksCharged;

  try {
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      if (needed <= charged) return allowed(0);

      if (!limits.allowOverage) {
        await uncount(db, row.id, quantity);
        return denied('limit_reached', row.used - quantity);
      }

      // Claim the blocks first so two callers never pay for the same one.
      const [claimed] = await db
        .update(workspaceMeterUsage)
        .set({ blocksCharged: needed, updatedAt: new Date() })
        .where(and(eq(workspaceMeterUsage.id, row.id), eq(workspaceMeterUsage.blocksCharged, charged)))
        .returning({ id: workspaceMeterUsage.id });
      if (!claimed) {
        const [fresh] = await db
          .select({ blocksCharged: workspaceMeterUsage.blocksCharged })
          .from(workspaceMeterUsage)
          .where(eq(workspaceMeterUsage.id, row.id))
          .limit(1);
        charged = fresh?.blocksCharged ?? charged;
        continue;
      }

      const blocks = needed - charged;
      const amount = blocks * def.creditsPerBlock;
      const settle = await consumeCredits(db, {
        workspaceId: params.workspaceId,
        amount,
        serviceType: def.serviceType,
        referenceId: params.referenceId,
        referenceType: params.referenceType,
        description: `${blocks * def.blockSize} extra ${def.unitPlural} (${period})`,
        metadata: { meter: params.meter, period, blocks, blockSize: def.blockSize, used: row.used, allowance: limits.allowance },
        userId: params.userId,
      });
      if (!settle.ok) {
        // Give the claim and the units back.
        await db
          .update(workspaceMeterUsage)
          .set({ blocksCharged: sql`${workspaceMeterUsage.blocksCharged} - ${blocks}`, updatedAt: new Date() })
          .where(and(eq(workspaceMeterUsage.id, row.id), gte(workspaceMeterUsage.blocksCharged, blocks)));
        await uncount(db, row.id, quantity);
        return {
          ...denied('insufficient_credits', row.used - quantity),
          required: settle.required,
          currentBalance: settle.currentBalance,
        };
      }
      reservation.blocks = blocks;
      reservation.credits = amount;
      reservation.transactionId = settle.transactionId;
      return allowed(amount);
    }
    console.warn(`[meters] ${params.meter}: block claim kept losing races for ${params.workspaceId}, allowing`);
    return allowed(0);
  } catch (err) {
    console.warn(`[meters] ${params.meter} overage settlement failed, allowing:`, err instanceof Error ? err.message : err);
    return allowed(reservation.credits);
  }

  function denied(reason: MeterDenied['reason'], used: number): MeterDenied {
    return { allowed: false, reason, meter: params.meter, used, allowance: limits.allowance, planName: limits.planName };
  }
}

async function uncount(db: CreditsDb, rowId: string, quantity: number): Promise<void> {
  await db
    .update(workspaceMeterUsage)
    .set({ used: sql`${workspaceMeterUsage.used} - ${quantity}`, updatedAt: new Date() })
    .where(and(eq(workspaceMeterUsage.id, rowId), gte(workspaceMeterUsage.used, quantity)));
}

/**
 * Hand back units counted by {@link meterUsage} for work that did not happen,
 * refunding the blocks that call paid for. Never throws.
 */
export async function releaseMeterUsage(db: CreditsDb, reservation: MeterReservation | null): Promise<void> {
  if (!reservation) return;
  try {
    const where = and(
      eq(workspaceMeterUsage.workspaceId, reservation.workspaceId),
      eq(workspaceMeterUsage.meter, reservation.meter),
      eq(workspaceMeterUsage.period, reservation.period),
    );
    await db
      .update(workspaceMeterUsage)
      .set({ used: sql`${workspaceMeterUsage.used} - ${reservation.quantity}`, updatedAt: new Date() })
      .where(and(where, gte(workspaceMeterUsage.used, reservation.quantity)));
    if (reservation.blocks > 0 && reservation.transactionId) {
      await db
        .update(workspaceMeterUsage)
        .set({ blocksCharged: sql`${workspaceMeterUsage.blocksCharged} - ${reservation.blocks}`, updatedAt: new Date() })
        .where(and(where, gte(workspaceMeterUsage.blocksCharged, reservation.blocks)));
      await refundCredits(db, {
        workspaceId: reservation.workspaceId,
        amount: reservation.credits,
        serviceType: METERS[reservation.meter].serviceType,
        idempotencyKey: `meter-release:${reservation.transactionId}`,
        referenceId: reservation.transactionId,
        referenceType: 'credit_transaction',
        description: `Refund: ${METERS[reservation.meter].unitPlural} not used`,
      });
    }
  } catch (err) {
    console.warn(`[meters] releasing ${reservation.meter} usage failed:`, err instanceof Error ? err.message : err);
  }
}

// ============================================================================
// Reading
// ============================================================================

export interface MeterUsageSummary {
  meter: MeterKey;
  unit: string;
  period: string;
  used: number;
  allowance: number | null;
  allowOverage: boolean;
  blockSize: number;
  creditsPerBlock: number;
  /** Credits paid for overage this month. */
  overageCredits: number;
}

/** Every meter's usage this month for one workspace, for usage and billing pages. */
export async function getMeterUsage(db: CreditsDb, workspaceId: string, now: Date = new Date()): Promise<MeterUsageSummary[]> {
  const period = meterPeriod(now);
  const [plan, rows] = await Promise.all([
    workspacePlan(db, workspaceId),
    db
      .select()
      .from(workspaceMeterUsage)
      .where(and(eq(workspaceMeterUsage.workspaceId, workspaceId), eq(workspaceMeterUsage.period, period))),
  ]);
  const byMeter = new Map<string, { used: number; blocksCharged: number }>(
    (rows as Array<{ meter: string; used: number; blocksCharged: number }>).map((r) => [r.meter, r]),
  );
  return METER_KEYS.map((meter) => {
    const def = METERS[meter];
    const limits = limitsFromPlan(meter, plan);
    const row = byMeter.get(meter);
    return {
      meter,
      unit: def.unit,
      period,
      used: row?.used ?? 0,
      allowance: limits.allowance,
      allowOverage: limits.allowOverage,
      blockSize: def.blockSize,
      creditsPerBlock: def.creditsPerBlock,
      overageCredits: (row?.blocksCharged ?? 0) * def.creditsPerBlock,
    };
  });
}

// ============================================================================
// Errors
// ============================================================================

/** Why a meter refused, in words for the person who hit it. */
export function meterDeniedMessage(result: MeterDenied): string {
  const def = METERS[result.meter];
  if (result.reason === 'insufficient_credits') {
    return `Your workspace has used its ${result.allowance} included ${def.unitPlural} this month and has too few credits for more. Top up credits to continue.`;
  }
  return `Your ${result.planName} plan includes ${result.allowance} ${def.unitPlural} per month and they are used up. Upgrade your plan to continue.`;
}

/** Thrown by callers that turn a {@link MeterDenied} into an error (402 at the API). */
export class MeterLimitError extends Error {
  readonly code: typeof INSUFFICIENT_CREDITS | 'USAGE_LIMIT_REACHED';
  constructor(readonly result: MeterDenied) {
    super(meterDeniedMessage(result));
    this.name = 'MeterLimitError';
    this.code = result.reason === 'insufficient_credits' ? INSUFFICIENT_CREDITS : 'USAGE_LIMIT_REACHED';
  }
}
