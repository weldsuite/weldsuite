/**
 * AI actions: ai_generate, ai_classify.
 *
 * Routes through `@weldsuite/ai` → the Cloudflare AI Gateway. Model ids stay
 * canonical, so pricing is stable across surfaces. Metered
 * against the workspace's prepaid credit wallet via `@weldsuite/credits`. The rate table
 * + cost math (`priceForModel`/`creditsForUsage`) is shared with app-api's
 * `/api/ai/generate` (`packages/core/ai/src/billing-rates.ts`) so a model is never
 * billed differently between the two surfaces.
 *
 * Hard gate: an empty wallet throws `AiInsufficientCreditsError`
 * (`ai_insufficient_credits`) rather than silently skipping the step — the
 * engine's own retry/`continueOnError` handling decides what happens next,
 * same as any other failing action. If credit-metering infra itself is
 * unavailable (no `DATABASE_URL_MASTER`, no master workspace row, etc.) the
 * call proceeds unmetered (fail-open), mirroring app-api's posture.
 *
 * Idempotent charging: `ctx.tenant.workspaceId` is the Clerk org id (see
 * `apps/workers/workflow-worker/src/index.ts`), resolved to the internal master
 * workspace id before touching the wallet. Each charge is keyed on
 * `executionId:stepId:op` via `@weldsuite/credits`' `idempotencyKey`, so a
 * Cloudflare Workflow step retry — which re-runs `runtime.do` under a NEW
 * attempt name but the SAME logical step — never double-charges.
 *
 * Field names (`prompt`/`systemPrompt`/`model`/`temperature`/`maxTokens` for
 * ai_generate; `text`/`categories`/`model` for ai_classify, plus the
 * `input`/`labels`/`max_tokens` aliases) match the pre-teardown api-worker
 * implementation so previously-saved workflow step configs keep working.
 */

import {
  assertGatewayConfigured as assertAiGatewayConfigured,
  runWithFallback,
  generateText,
  generateObject,
  jsonSchema,
  recommended,
  creditsForUsage,
  type AiUsage,
} from '@weldsuite/ai';
import { checkCredits, consumeCredits, grantCredits, resolveInternalWorkspaceId } from '@weldsuite/credits';
import { nanoUsd, recordProviderUsage, type Gateway } from '@weldsuite/credits/gateway-costs';
import { readGatewayCreditSnapshot, toCreditStates } from '@weldsuite/credits/gateway-cache';
import { getMasterDb, type MasterDatabase } from '../../db';
import type { ActionContext, ActionHandler } from '../types';

/** Thrown when the workspace wallet can't cover even the minimum precheck —
 *  the step fails loudly rather than silently skipping (see file header). */
export class AiInsufficientCreditsError extends Error {
  readonly code = 'ai_insufficient_credits';
  constructor(
    public readonly currentBalance: number,
    public readonly required: number,
  ) {
    super(`Insufficient AI credits for this workflow step (balance ${currentBalance}, need ${required})`);
    this.name = 'AiInsufficientCreditsError';
  }
}

interface AiMetering {
  masterDb: MasterDatabase;
  internalWsId: string;
}

const MIN_PRECHECK_CREDITS = 1;

/** Resolve the master-DB metering context. `null` = unmetered (fail-open). */
async function resolveMetering(ctx: ActionContext): Promise<AiMetering | null> {
  if (!ctx.env.DATABASE_URL_MASTER) return null;
  try {
    const masterDb = getMasterDb(ctx.env);
    const internalWsId = await resolveInternalWorkspaceId(masterDb, ctx.tenant.workspaceId);
    if (!internalWsId) {
      console.warn(`[ai] no master workspace for org ${ctx.tenant.workspaceId} — unmetered`);
      return null;
    }
    return { masterDb, internalWsId };
  } catch (err) {
    console.warn('[ai] credit metering unavailable:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Hard gate: throw {@link AiInsufficientCreditsError} when the wallet is empty. */
async function assertCredits(metering: AiMetering | null): Promise<void> {
  if (!metering) return;
  const check = await checkCredits(metering.masterDb, metering.internalWsId, MIN_PRECHECK_CREDITS);
  if (!check.available) {
    throw new AiInsufficientCreditsError(check.currentBalance, check.required);
  }
}

/** Charge the wallet for one completed model call. Returns credits charged. */
async function chargeUsage(
  metering: AiMetering | null,
  ctx: ActionContext,
  params: {
    modelId: string;
    usage: AiUsage;
    op: 'ai_generate' | 'ai_classify';
    /** Which gateway served the call, and what it cost US. Omit → not recorded. */
    gateway?: Gateway;
    providerCostUsd?: number;
    coveredByServiceCredit?: boolean;
  },
): Promise<number> {
  if (!metering) return 0;
  // NOTE: `creditsForUsage` takes the CANONICAL modelId and never the gateway —
  // a step costs the customer the same no matter who served it. Keep it that
  // way; the gateway only ever affects the OPS ledger below.
  const credits = creditsForUsage(params.modelId, params.usage);
  if (credits <= 0) return 0;

  const idempotencyKey = `wf:${ctx.executionId}:${ctx.stepId}:${params.op}`;
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
      idempotencyKey,
      referenceId: ctx.executionId,
      referenceType: 'workflow_step',
      description: `Workflow AI (${params.op}) [${params.modelId}]`,
      metadata: meta,
      userId: ctx.tenant.userId,
    });
    if (settle.ok) {
      await recordOpsUsage(metering, ctx, params, credits, idempotencyKey);
      return credits;
    }
    // Tokens already spent but the balance couldn't cover it — record the
    // debt rather than silently unbilled usage (mirrors app-api's billing.ts).
    await grantCredits(metering.masterDb, {
      workspaceId: metering.internalWsId,
      amount: -credits,
      type: 'adjustment',
      idempotencyKey: `${idempotencyKey}:debt`,
      serviceType: 'ai_tokens',
      referenceId: ctx.executionId,
      referenceType: 'workflow_step',
      description: `Workflow AI (${params.op}) [${params.modelId}] — settled into negative balance`,
      metadata: { ...meta, forcedSettlement: true },
      userId: ctx.tenant.userId,
    });
    await recordOpsUsage(metering, ctx, params, credits, idempotencyKey);
    return credits;
  } catch (err) {
    console.error('[ai] credit settlement failed (untracked workflow AI usage!):', err);
    return 0;
  }
}

/**
 * Append the ops-ledger row: what WE paid to serve this step.
 *
 * Mirrors app-api's billing.ts. Keyed on the same idempotency key as the wallet
 * charge (+':usage') so a Cloudflare Workflow step retry — which re-runs under a
 * new attempt name but the same logical step — can't double-count our spend.
 */
async function recordOpsUsage(
  metering: AiMetering,
  ctx: ActionContext,
  params: { modelId: string; usage: AiUsage; op: string; gateway?: Gateway; providerCostUsd?: number; coveredByServiceCredit?: boolean },
  credits: number,
  idempotencyKey: string,
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
    referenceType: 'workflow_step',
    referenceId: ctx.executionId,
    idempotencyKey: `${idempotencyKey}:usage`,
  });
}

/**
 * Fail fast when the Cloudflare AI Gateway is missing its env.
 *
 * Delegates to `@weldsuite/ai` so validation stays in one place.
 */
function assertGatewayConfigured(ctx: ActionContext): void {
  assertAiGatewayConfigured(ctx.env);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((v) => v !== undefined && v !== null);
}

/**
 * Ops service-credit state for the router — one edge-cached KV read.
 *
 * Never queries the master DB: a KV outage must degrade routing to fee order,
 * not become a DB stampede at per-call rate. `[]` means "no credit info".
 */
async function creditStates(ctx: ActionContext) {
  if (!ctx.env.WORKSPACE_CACHE) return [];
  return toCreditStates(await readGatewayCreditSnapshot(ctx.env.WORKSPACE_CACHE));
}

export const handleAiGenerate: ActionHandler = async (inputs, ctx: ActionContext) => {
  const prompt = String(inputs.prompt || '');
  if (!prompt) throw new Error('Prompt is required');
  assertGatewayConfigured(ctx);

  const systemPrompt = firstDefined(inputs.systemPrompt, inputs.system);
  const modelId = inputs.model ? String(inputs.model) : recommended.draft.free;
  const temperature = inputs.temperature !== undefined ? Number(inputs.temperature) : undefined;
  const maxTokensRaw = firstDefined(inputs.maxTokens, inputs.max_tokens);
  const maxOutputTokens = maxTokensRaw !== undefined ? Number(maxTokensRaw) : undefined;

  const metering = await resolveMetering(ctx);
  await assertCredits(metering);

  let served: { gateway: Gateway; providerCostUsd: number; covered: boolean } | undefined;
  const { value: result } = await runWithFallback(
    ctx.env,
    {
      modelId,
      op: 'ai_generate',
      credits: await creditStates(ctx),
      onUsage: (rec) => {
        served = {
          gateway: rec.gateway as Gateway,
          providerCostUsd: rec.providerCostUsd,
          covered: rec.coveredByServiceCredit,
        };
      },
    },
    ({ model }) =>
      generateText({
        model,
        system: systemPrompt !== undefined ? String(systemPrompt) : undefined,
        prompt,
        temperature,
        maxOutputTokens,
        // One in-gateway retry, then move on — the SDK's default of 2 burns two
        // backed-off retries before we ever reach the next gateway.
        maxRetries: 1,
      }),
  );

  const creditsUsed = await chargeUsage(metering, ctx, {
    modelId,
    usage: result.usage,
    op: 'ai_generate',
    gateway: served?.gateway,
    providerCostUsd: served?.providerCostUsd,
    coveredByServiceCredit: served?.covered,
  });

  return {
    text: result.text,
    model: modelId,
    finishReason: result.finishReason,
    usage: result.usage,
    creditsUsed,
  };
};

export const handleAiClassify: ActionHandler = async (inputs, ctx: ActionContext) => {
  const text = String(inputs.text || inputs.input || '');
  const categories = (firstDefined(inputs.categories, inputs.labels) as string[] | undefined) ?? undefined;
  if (!text) throw new Error('Text input is required');
  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    throw new Error('Categories array is required');
  }
  assertGatewayConfigured(ctx);

  const modelId = inputs.model ? String(inputs.model) : recommended.classify.free;

  const metering = await resolveMetering(ctx);
  await assertCredits(metering);

  // Plain JSON schema (not zod) — a dynamic enum built from the caller's
  // categories, and keeps structured-output inference shallow (matches the
  // convention in services/mail/ai.ts to avoid TS2589 "excessively deep"
  // against the AI SDK's generics).
  const classifySchema = jsonSchema<{ category: string; confidence?: number; reasoning?: string }>({
    type: 'object',
    properties: {
      category: { type: 'string', enum: categories },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string' },
    },
    required: ['category'],
    additionalProperties: false,
  });

  let served: { gateway: Gateway; providerCostUsd: number; covered: boolean } | undefined;
  const { value: result } = await runWithFallback(
    ctx.env,
    {
      modelId,
      op: 'ai_classify',
      credits: await creditStates(ctx),
      onUsage: (rec) => {
        served = {
          gateway: rec.gateway as Gateway,
          providerCostUsd: rec.providerCostUsd,
          covered: rec.coveredByServiceCredit,
        };
      },
    },
    ({ model }) =>
      generateObject({
        model,
        schema: classifySchema,
        system:
          'You are a text classifier. Classify the given text into exactly one of the provided categories. ' +
          'Include a confidence between 0 and 1 and a brief reasoning.',
        prompt: `Categories: ${categories.join(', ')}.\n\nText:\n${text}`,
        maxRetries: 1,
      }),
  );

  const creditsUsed = await chargeUsage(metering, ctx, {
    modelId,
    usage: result.usage,
    op: 'ai_classify',
    gateway: served?.gateway,
    providerCostUsd: served?.providerCostUsd,
    coveredByServiceCredit: served?.covered,
  });

  return {
    category: result.object.category,
    confidence: result.object.confidence ?? null,
    reasoning: result.object.reasoning ?? '',
    model: modelId,
    usage: result.usage,
    creditsUsed,
  };
};
