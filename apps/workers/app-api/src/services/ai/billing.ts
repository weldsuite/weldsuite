/**
 * AI billing — meters `@weldsuite/ai` usage against the prepaid credit wallet.
 *
 * Draws from the same `workspace_credits` wallet as calls/social/etc. via
 * `@weldsuite/credits` (serviceType `ai_tokens`). Pricing is cost-transparent:
 * `@weldsuite/ai`'s {@link priceForModel} (in `packages/core/ai/src/billing-rates.ts`)
 * holds each model's real published USD/1M-token rate, and a call costs
 * `rawProviderCost × PROVIDER_MARKUP × CREDITS_PER_USD` credits. That rate
 * table is the SHARED source of truth — `apps/workers/workflow-worker`'s
 * `ai_generate`/`ai_classify` engine actions price their calls off the same
 * module so a model can never be billed differently in the two surfaces.
 *
 * Enforcement: **hard gate + post-consume**. Call {@link assertAiCredits}
 * before the model call (throws {@link InsufficientAiCreditsError} → 402 when
 * the wallet is empty), then {@link chargeAiUsage} after with the real token
 * usage. A call that empties the wallet still completes; the next one is
 * blocked. If metering infra is unavailable the helpers no-op (fail-open) so
 * AI keeps working — same posture as the calls route.
 */

import {
  checkCredits,
  consumeCredits,
  grantCredits,
  resolveInternalWorkspaceId,
} from '@weldsuite/credits';
import { nanoUsd, recordProviderUsage, type Gateway } from '@weldsuite/credits/gateway-costs';
import {
  priceForModel,
  providerCostUsd,
  creditsForUsage,
  type ModelPrice,
  type AiUsage,
} from '@weldsuite/ai';
import { getMasterDb, type MasterDatabase } from '../../db';
import type { Env } from '../../types';

// Re-exported for existing importers (billing.test.ts, mail/ai.ts, …) — the
// real rate table + math now live in `@weldsuite/ai/billing-rates` (shared
// with workflow-worker). See file header.
export { priceForModel, providerCostUsd, creditsForUsage, type ModelPrice, type AiUsage };

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

export interface AiMetering {
  masterDb: MasterDatabase;
  internalWsId: string;
  userId: string;
}

export class InsufficientAiCreditsError extends Error {
  constructor(
    public readonly currentBalance: number,
    public readonly required: number,
    public readonly shortfall: number,
  ) {
    super('Insufficient credits');
    this.name = 'InsufficientAiCreditsError';
  }
}

/** Smallest balance allowed before a call is blocked by the hard gate. */
const MIN_PRECHECK_CREDITS = 1;

/**
 * Resolve the master-DB metering context for a Clerk org id. Returns `null`
 * (unmetered, fail-open) when there is no master workspace or infra is down.
 */
export async function resolveAiMetering(
  env: Env,
  orgId: string,
  userId: string,
): Promise<AiMetering | null> {
  try {
    const masterDb = getMasterDb(env);
    const internalWsId = await resolveInternalWorkspaceId(masterDb, orgId);
    if (!internalWsId) {
      console.warn(`[app-api/ai] no master workspace for org ${orgId} — unmetered`);
      return null;
    }
    return { masterDb, internalWsId, userId };
  } catch (err) {
    console.warn('[app-api/ai] credit metering unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Hard gate: throw {@link InsufficientAiCreditsError} when the wallet is empty. */
export async function assertAiCredits(metering: AiMetering | null): Promise<void> {
  if (!metering) return;
  const check = await checkCredits(metering.masterDb, metering.internalWsId, MIN_PRECHECK_CREDITS);
  if (!check.available) {
    throw new InsufficientAiCreditsError(check.currentBalance, check.required, check.shortfall);
  }
}

/**
 * Consume credits for one completed model call. Returns the credits charged.
 * On a lost overdraft race the cost is recorded as debt (negative adjustment)
 * so spent tokens are never silently unbilled — mirrors the calls route.
 */
export async function chargeAiUsage(
  metering: AiMetering | null,
  params: {
    modelId: string;
    usage: AiUsage;
    op: string;
    referenceId?: string;
    /** Which gateway served the call, and what it cost US. Omit → not recorded. */
    gateway?: Gateway;
    providerCostUsd?: number;
    coveredByServiceCredit?: boolean;
  },
): Promise<number> {
  if (!metering) return 0;
  // NOTE: `creditsForUsage` takes the CANONICAL modelId and never the gateway —
  // the customer pays the same no matter who served it. Keep it that way; the
  // gateway only ever affects the OPS ledger below.
  const credits = creditsForUsage(params.modelId, params.usage);
  if (credits <= 0) return 0;

  const meta = {
    modelId: params.modelId,
    op: params.op,
    inputTokens: params.usage.inputTokens ?? 0,
    outputTokens: params.usage.outputTokens ?? 0,
    ...(params.gateway ? { gateway: params.gateway } : {}),
    ...(params.providerCostUsd !== undefined
      ? { providerCostNanoUsd: nanoUsd(params.providerCostUsd) }
      : {}),
  };
  try {
    const settle = await consumeCredits(metering.masterDb, {
      workspaceId: metering.internalWsId,
      amount: credits,
      serviceType: 'ai_tokens',
      referenceId: params.referenceId,
      referenceType: 'ai',
      description: `AI (${params.op}) [${params.modelId}]`,
      metadata: meta,
      userId: metering.userId,
    });
    if (settle.ok) {
      await recordOpsUsage(metering, params, credits);
      return credits;
    }
    // Tokens already spent but balance insufficient — record the debt.
    await grantCredits(metering.masterDb, {
      workspaceId: metering.internalWsId,
      amount: -credits,
      type: 'adjustment',
      serviceType: 'ai_tokens',
      referenceId: params.referenceId,
      referenceType: 'ai',
      description: `AI (${params.op}) [${params.modelId}] — settled into negative balance`,
      metadata: { ...meta, forcedSettlement: true },
      userId: metering.userId,
    });
    await recordOpsUsage(metering, params, credits);
    return credits;
  } catch (err) {
    console.error('[app-api/ai] credit settlement failed (untracked AI usage!):', err);
    return 0;
  }
}

/**
 * Append the ops-ledger row: what WE paid to serve this call.
 *
 * Separate from the wallet write on purpose — the customer ledger records their
 * stable price, this records our variable cost, and the gap is margin. Never
 * throws (recordProviderUsage swallows), so bookkeeping can't fail a call that
 * already succeeded and was already charged.
 */
async function recordOpsUsage(
  metering: AiMetering,
  params: { modelId: string; usage: AiUsage; op: string; referenceId?: string; gateway?: Gateway; providerCostUsd?: number; coveredByServiceCredit?: boolean },
  credits: number,
): Promise<void> {
  if (!params.gateway) return; // routing not wired for this call site yet
  await recordProviderUsage(metering.masterDb, {
    gateway: params.gateway,
    modelId: params.modelId,
    usage: params.usage,
    op: params.op,
    providerCostNanoUsd: nanoUsd(params.providerCostUsd ?? 0),
    creditsCharged: credits,
    coveredByServiceCredit: params.coveredByServiceCredit ?? false,
    workspaceId: metering.internalWsId,
    referenceType: 'ai',
    referenceId: params.referenceId,
  });
}
