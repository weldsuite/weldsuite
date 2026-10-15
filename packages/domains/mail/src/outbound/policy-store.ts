/**
 * Master-DB side of the outbound guard: load a subject's sending policy
 * (trust level, limits, state, guard mode) and record automatic and staff
 * changes to it. Used by the `OutboundLedger` Durable Object and by mail-api.
 */

import { and, eq } from 'drizzle-orm';
import { getMasterDb, masterSchema, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  OUTBOUND_GUARD_MODES,
  OUTBOUND_PERSONAL_LIMITS,
  OUTBOUND_TRUST_LEVELS,
  computeTrustLevel,
  outboundLimitOverridesSchema,
  resolveOutboundLimits,
  type OutboundGuardMode,
  type OutboundLimits,
  type OutboundState,
  type OutboundTrustLevel,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { LedgerPolicy, LedgerSubject } from './ledger-core';

/** Flagship flag: `off` | `shadow` | `enforce` (packages/core/feature-flags). */
export const OUTBOUND_GUARD_FLAG = 'weldmail-outbound-guard';
export const DEFAULT_GUARD_MODE: OutboundGuardMode = 'shadow';

/** Structural Flagship binding (see @weldsuite/feature-flags/server). */
interface FlagshipLike {
  getStringValue(key: string, defaultValue: string, context?: Record<string, unknown>): Promise<string>;
}

export interface OutboundPolicyEnv {
  DATABASE_URL_MASTER: string;
  FLAGSHIP?: FlagshipLike;
  ENVIRONMENT?: string;
}

const { outboundMailPolicies, outboundMailEvents, workspaces, plans } = masterSchema;

export async function readGuardMode(env: OutboundPolicyEnv, subject: LedgerSubject): Promise<OutboundGuardMode> {
  if (!env.FLAGSHIP) return DEFAULT_GUARD_MODE;
  try {
    const value = await env.FLAGSHIP.getStringValue(OUTBOUND_GUARD_FLAG, DEFAULT_GUARD_MODE, {
      workspaceId: subject.kind === 'workspace' ? subject.workspaceId : '',
      userId: subject.kind === 'personal' ? subject.personalAccountId : '',
      environment: env.ENVIRONMENT ?? 'production',
      app: 'mail-api',
    });
    return (OUTBOUND_GUARD_MODES as readonly string[]).includes(value) ? (value as OutboundGuardMode) : DEFAULT_GUARD_MODE;
  } catch (err) {
    console.warn('[outbound] Flagship lookup failed, using default mode:', err instanceof Error ? err.message : err);
    return DEFAULT_GUARD_MODE;
  }
}

function policyFilter(subject: LedgerSubject) {
  return subject.kind === 'workspace'
    ? eq(outboundMailPolicies.workspaceId, subject.workspaceId)
    : eq(outboundMailPolicies.personalAccountId, subject.personalAccountId);
}

export interface DeliveryRates {
  hardBounceRate7d: number | null;
  complaintRate7d: number | null;
}

export interface LoadedPolicy extends LedgerPolicy {
  riskScore: number;
}

/** The subject's policy as the ledger applies it. */
export async function loadLedgerPolicy(
  env: OutboundPolicyEnv,
  subject: LedgerSubject,
  rates: DeliveryRates,
  db: MasterDatabase = getMasterDb(env),
): Promise<LoadedPolicy> {
  const [mode, [row]] = await Promise.all([
    readGuardMode(env, subject),
    db.select().from(outboundMailPolicies).where(policyFilter(subject)).limit(1),
  ]);
  const state: OutboundState = row?.state ?? 'active';
  const trustOverride = validTrustLevel(row?.trustOverride);
  const { trustLevel, limits } =
    subject.kind === 'personal'
      ? personalTrustAndLimits(subject.plan, trustOverride, state, row?.limits)
      : await workspaceTrustAndLimits(db, subject.workspaceId, trustOverride, state, row?.limits, rates);

  return {
    mode,
    trustLevel,
    state,
    stateReason: row?.stateReason ?? null,
    stateSetBy: row?.stateSetBy ?? null,
    stateSetAt: row?.stateSetAt ? row.stateSetAt.toISOString() : null,
    allowRepliesWhenSuspended: row?.allowRepliesWhenSuspended ?? false,
    limits,
    riskScore: row?.riskScore ?? 0,
  };
}

function validTrustLevel(value: string | null | undefined): OutboundTrustLevel | null {
  return value && (OUTBOUND_TRUST_LEVELS as readonly string[]).includes(value) ? (value as OutboundTrustLevel) : null;
}

type TrustAndLimits = { trustLevel: OutboundTrustLevel; limits: OutboundLimits };

function personalTrustAndLimits(
  plan: 'free' | 'pro',
  trustOverride: OutboundTrustLevel | null,
  state: OutboundState,
  overrides: Record<string, unknown> | null | undefined,
): TrustAndLimits {
  const trustLevel = trustOverride ?? (plan === 'pro' ? 'standard' : 'new');
  if (state === 'restricted') return { trustLevel, limits: resolveOutboundLimits(trustLevel, state, null) };
  const parsed = outboundLimitOverridesSchema.safeParse(overrides ?? {});
  return { trustLevel, limits: { ...OUTBOUND_PERSONAL_LIMITS[plan], ...(parsed.success ? parsed.data : {}) } };
}

async function workspaceTrustAndLimits(
  db: MasterDatabase,
  workspaceId: string,
  trustOverride: OutboundTrustLevel | null,
  state: OutboundState,
  overrides: Record<string, unknown> | null | undefined,
  rates: DeliveryRates,
): Promise<TrustAndLimits> {
  const [workspace] = await db
    .select({
      createdAt: workspaces.createdAt,
      subscriptionStatus: workspaces.subscriptionStatus,
      compGrantedAt: workspaces.compGrantedAt,
      billingMode: workspaces.billingMode,
      planPriceMonthly: plans.priceMonthly,
    })
    .from(workspaces)
    .leftJoin(plans, eq(plans.id, workspaces.planId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const trustLevel = workspace
    ? computeTrustLevel({
        createdAt: workspace.createdAt,
        subscriptionStatus: workspace.subscriptionStatus,
        planPriceMonthly: workspace.planPriceMonthly === null ? null : Number(workspace.planPriceMonthly),
        // Comp plans and partner-billed workspaces are paid for, just not by Stripe here.
        compGranted: !!workspace.compGrantedAt || workspace.billingMode === 'partner',
        trustOverride,
        hardBounceRate7d: rates.hardBounceRate7d,
        complaintRate7d: rates.complaintRate7d,
      })
    : (trustOverride ?? 'new');
  return { trustLevel, limits: resolveOutboundLimits(trustLevel, state, overrides ?? null) };
}

function subjectColumns(subject: LedgerSubject) {
  return subject.kind === 'workspace'
    ? { workspaceId: subject.workspaceId, personalAccountId: null }
    : { workspaceId: null, personalAccountId: subject.personalAccountId };
}

/** Create the policy row if it doesn't exist yet; returns its id. */
async function ensurePolicyRow(db: MasterDatabase, subject: LedgerSubject): Promise<string> {
  const [existing] = await db
    .select({ id: outboundMailPolicies.id })
    .from(outboundMailPolicies)
    .where(policyFilter(subject))
    .limit(1);
  if (existing) return existing.id;
  const id = generateId('obpol');
  await db
    .insert(outboundMailPolicies)
    .values({ id, ...subjectColumns(subject) })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: outboundMailPolicies.id })
    .from(outboundMailPolicies)
    .where(policyFilter(subject))
    .limit(1);
  return row?.id ?? id;
}

/** Store the latest risk score (for the admin console's ranking). */
export async function saveRiskScore(env: OutboundPolicyEnv, subject: LedgerSubject, score: number): Promise<void> {
  const db = getMasterDb(env);
  const now = new Date();
  const updated = await db
    .update(outboundMailPolicies)
    .set({ riskScore: score, riskUpdatedAt: now, updatedAt: now })
    .where(policyFilter(subject))
    .returning({ id: outboundMailPolicies.id });
  // Only create a row for a score worth showing; the rest stay row-less.
  if (updated.length === 0 && score > 0) {
    await ensurePolicyRow(db, subject);
    await db
      .update(outboundMailPolicies)
      .set({ riskScore: score, riskUpdatedAt: now, updatedAt: now })
      .where(policyFilter(subject));
  }
}

/**
 * An automatic state change (only ever a tightening; the ledger checks that).
 * The customer sees `customerReason`; the trail keeps the details.
 */
export async function applyAutomaticState(
  env: OutboundPolicyEnv,
  subject: LedgerSubject,
  change: { from: OutboundState; to: 'restricted' | 'hold'; customerReason: string; reason: string; details: Record<string, unknown> },
): Promise<void> {
  const db = getMasterDb(env);
  await ensurePolicyRow(db, subject);
  const now = new Date();
  await db
    .update(outboundMailPolicies)
    .set({ state: change.to, stateReason: change.customerReason, stateSetBy: 'system', stateSetAt: now, updatedAt: now })
    .where(and(policyFilter(subject), eq(outboundMailPolicies.state, change.from)));
  await recordOutboundEvent(db, subject, {
    kind: 'state_changed',
    fromValue: change.from,
    toValue: change.to,
    reason: change.reason,
    actor: 'system',
    details: change.details,
  });
}

export async function recordOutboundEvent(
  db: MasterDatabase,
  subject: LedgerSubject | { kind: 'platform' },
  event: {
    kind: (typeof masterSchema.OUTBOUND_EVENT_KINDS)[number];
    fromValue?: string | null;
    toValue?: string | null;
    reason?: string | null;
    actor: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.insert(outboundMailEvents).values({
      id: generateId('obevt'),
      ...(subject.kind === 'platform' ? { workspaceId: null, personalAccountId: null } : subjectColumns(subject)),
      kind: event.kind,
      fromValue: event.fromValue ?? null,
      toValue: event.toValue ?? null,
      reason: event.reason ?? null,
      actor: event.actor,
      details: event.details ?? null,
    });
  } catch (err) {
    console.error('[outbound] Failed to record event:', err instanceof Error ? err.message : err);
  }
}
