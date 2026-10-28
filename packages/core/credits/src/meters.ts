/**
 * Usage meters — plan allowances with overage paid from the credit wallet.
 *
 * Every metered thing a workspace does (a workflow run, a signature request
 * sent, …) is counted per UTC month by the workspace's `UsageMeter` Durable
 * Object (./meter-object.ts; hosted by mail-api, bound as `USAGE_METER` by
 * every worker that meters). The plan includes an allowance per meter
 * (`plans.features`); past it, usage is paid in blocks from the same prepaid
 * wallet AI draws from: the first unit of a new block charges the whole block,
 * the rest of the block is free. A plan that does not allow overage (free
 * plans, by default) stops at the allowance instead.
 *
 * AI is not a meter: its cost varies per call, so it is charged in credits
 * directly (`@weldsuite/core-domain/ai-billing`) and the plan's
 * `monthlyCredits` is its allowance.
 *
 * Enforcement: call {@link meterUsage} BEFORE doing the work. It counts the
 * units, charges a block when one is crossed, and refuses with a
 * {@link MeterDenied} when the limit or the wallet says no. When the work then
 * does not happen, hand the reservation back with {@link releaseMeterUsage}.
 * Pass an `idempotencyKey` and a retried call returns the first answer
 * instead of counting again. A missing binding or an unreachable meter fails
 * open (the work goes ahead, uncounted), the same posture as AI billing.
 *
 * This file is the catalog, the plan limits, the decision logic and the
 * callers' side; it never imports the Durable Object at runtime.
 */

import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { PlanFeatures } from '@weldsuite/db/schema/plans';
import { INSUFFICIENT_CREDITS, type CreditServiceType, type CreditsDb } from './index';
import type { UsageMeter } from './meter-object';

const { workspaces, plans } = masterSchema;

// ============================================================================
// Catalog
// ============================================================================

export type MeterKey = 'workflow_runs' | 'sign_requests' | 'emails';

export interface MeterDefinition {
  key: MeterKey;
  /** What one unit is, for messages ("workflow run", "signature request"). */
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

/** Every meter's limits for a workspace: its plan, else the default plan, else none. */
export async function loadMeterLimits(db: CreditsDb, workspaceId: string): Promise<Record<MeterKey, MeterLimits>> {
  const [ws] = await db.select({ planId: workspaces.planId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  const [own]: PlanRow[] = ws?.planId ? await db.select().from(plans).where(eq(plans.id, ws.planId)).limit(1) : [];
  const [fallback]: PlanRow[] = own ? [] : await db.select().from(plans).where(eq(plans.isDefault, true)).limit(1);
  const plan = own ?? fallback ?? null;
  return Object.fromEntries(METER_KEYS.map((meter) => [meter, limitsFromPlan(meter, plan)])) as Record<MeterKey, MeterLimits>;
}

// ============================================================================
// Decision
// ============================================================================

/** One meter's month in the Durable Object's storage. */
export interface MeterCounter {
  used: number;
  /** Overage blocks already paid for this month. */
  blocksCharged: number;
}

export type MeterDecision =
  /** Inside the allowance or a block already paid for. */
  | { kind: 'free'; used: number }
  /** The units open `blocks` new blocks: charge `credits`, then count. */
  | { kind: 'charge'; used: number; blocks: number; credits: number; blocksCharged: number }
  /** The plan stops at its allowance. */
  | { kind: 'limit_reached' };

/** What counting `quantity` more units does, given this month's counter and the plan. */
export function decideMeter(meter: MeterKey, counter: MeterCounter, quantity: number, limits: MeterLimits): MeterDecision {
  const def = METERS[meter];
  const used = counter.used + quantity;
  if (limits.allowance === null) return { kind: 'free', used };
  const needed = Math.ceil(Math.max(0, used - limits.allowance) / def.blockSize);
  if (needed <= counter.blocksCharged) return { kind: 'free', used };
  if (!limits.allowOverage) return { kind: 'limit_reached' };
  const blocks = needed - counter.blocksCharged;
  return { kind: 'charge', used, blocks, credits: blocks * def.creditsPerBlock, blocksCharged: needed };
}

/** The UTC month a moment falls in, `YYYY-MM`. */
export function meterPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

// ============================================================================
// Results
// ============================================================================

export interface MeterUsageParams {
  /** Master `workspaces.id` (the Durable Object is named by it). */
  workspaceId: string;
  meter: MeterKey;
  /** Units to count, default 1. */
  quantity?: number;
  /** Stable key for this unit of work (`run:<executionId>`): a retry returns the first answer. */
  idempotencyKey?: string;
  /** What the units are for (an execution or envelope id), recorded on any charge. */
  referenceId?: string;
  referenceType?: string;
  userId?: string;
}

/** What {@link releaseMeterUsage} needs to hand counted units (and their charge) back. */
export interface MeterReservation {
  workspaceId: string;
  meter: MeterKey;
  period: string;
  quantity: number;
  idempotencyKey: string | null;
  /** Blocks this call paid for, and the ledger row it paid with. */
  blocks: number;
  credits: number;
  transactionId: string | null;
}

export interface MeterAllowed {
  allowed: true;
  /** `null` when the work went ahead unmetered (fail-open): nothing to release. */
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

// ============================================================================
// Callers' side
// ============================================================================

/** The binding every metering worker declares (mail-api hosts the class). */
export interface UsageMeterEnv {
  USAGE_METER?: DurableObjectNamespace<UsageMeter>;
}

const UNMETERED: MeterAllowed = { allowed: true, reservation: null, used: 0, allowance: null, creditsCharged: 0 };

function meterFor(env: UsageMeterEnv, workspaceId: string) {
  const ns = env.USAGE_METER!;
  return ns.get(ns.idFromName(workspaceId));
}

/**
 * Count units against the plan's allowance in the workspace's meter, paying
 * a new overage block from the wallet when they cross into one. Refuses (and
 * counts nothing) when the plan stops at its allowance or the wallet cannot
 * pay. Fails open.
 */
export async function meterUsage(env: UsageMeterEnv, params: MeterUsageParams): Promise<MeterUsageResult> {
  const quantity = params.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`[meters] quantity must be a positive integer, got ${quantity}`);
  }
  if (!env.USAGE_METER) return UNMETERED;
  try {
    return (await meterFor(env, params.workspaceId).meter({ ...params, quantity })) as MeterUsageResult;
  } catch (err) {
    console.warn(`[meters] ${params.meter} meter unreachable, allowing:`, err instanceof Error ? err.message : err);
    return UNMETERED;
  }
}

/** Hand back units counted for work that did not happen, refunding the blocks that call paid for. Never throws. */
export async function releaseMeterUsage(env: UsageMeterEnv, reservation: MeterReservation | null): Promise<void> {
  if (!reservation || !env.USAGE_METER) return;
  try {
    await meterFor(env, reservation.workspaceId).release(reservation);
  } catch (err) {
    console.warn(`[meters] releasing ${reservation.meter} usage failed:`, err instanceof Error ? err.message : err);
  }
}

/** Every meter's use this month for one workspace, for usage and billing pages; `[]` when unavailable. */
export async function getMeterUsage(env: UsageMeterEnv, workspaceId: string): Promise<MeterUsageSummary[]> {
  if (!env.USAGE_METER) return [];
  try {
    return (await meterFor(env, workspaceId).usage(workspaceId)) as MeterUsageSummary[];
  } catch (err) {
    console.warn('[meters] usage unavailable:', err instanceof Error ? err.message : err);
    return [];
  }
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
