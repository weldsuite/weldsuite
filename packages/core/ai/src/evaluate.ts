/**
 * Structured evaluation via TypeSafe Jev (`typesafe/jev`) on Cloudflare
 * Workers AI / AI Gateway.
 *
 * Jev is not a chat model — it answers typed Noul / Choice / Score questions
 * about a `state` and returns calibrated probabilities. That shape does not
 * fit the OpenAI-compatible `/chat/completions` path used by
 * {@link createWeldAI}, so this module talks to the Workers AI `run` endpoint
 * (directly or through the AI Gateway workers-ai provider route).
 *
 * @see https://developers.cloudflare.com/ai/models/typesafe/jev/
 */

import type { GatewayProvider } from './adapters/types.js';
import { GatewayConfigError } from './adapters/types.js';
import { providerCostUsd, type AiUsage } from './billing-rates.js';
import {
  resolveConfig,
  type CloudflareGatewayConfig,
  type WeldAiConfig,
} from './config.js';
import type { GatewayUsageRecord, RecordGatewayUsage } from './run.js';

/** Canonical model id for TypeSafe Jev on Cloudflare Workers AI. */
export const JEV_MODEL_ID = 'typesafe/jev' as const;

/** Yes/no probability question. Answer is `noul` in [0, 1]. */
export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

/** Single-select among named options. */
export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

/** Ordered rubric score (2–10 levels). */
export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

export interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface EvaluateInput {
  /** Content under evaluation — string or structured JSON-serialisable object. */
  state: unknown;
  /** Map of question id → typed question. */
  questions: Record<string, JevQuestion>;
  /** Override model id (defaults to {@link JEV_MODEL_ID}). */
  modelId?: string;
}

export interface EvaluateResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: AiUsage;
  /** Gateway that served the call. */
  gateway: GatewayProvider;
  /** Canonical model id used for pricing / ops ledger. */
  modelId: string;
}

export interface EvaluateOptions {
  /** Short verb for the ops ledger, e.g. `mail_auto_label`. */
  op?: string;
  /** Injected so this module stays DB-free. Never allowed to fail the call. */
  onUsage?: RecordGatewayUsage;
}

/**
 * Minimal shape of the Workers AI binding (`[ai] binding = "AI"`). Typed
 * structurally so this package does not depend on `@cloudflare/workers-types`.
 */
export interface AiBindingLike {
  run(model: string, inputs: unknown, options?: unknown): Promise<unknown>;
}

/** The Workers AI binding on `env.AI`, when the worker declares one. */
function aiBinding(env: unknown): AiBindingLike | undefined {
  if (!env || typeof env !== 'object') return undefined;
  const ai = (env as { AI?: unknown }).AI;
  return ai && typeof (ai as AiBindingLike).run === 'function'
    ? (ai as AiBindingLike)
    : undefined;
}

/** Workers AI-hosted models use the `@cf/` prefix; everything else is third-party. */
function isWorkersAiModel(modelId: string): boolean {
  return modelId.startsWith('@cf/');
}

/**
 * Build the REST URL + auth headers for a Jev `run` call (used when the worker
 * has no `AI` binding).
 *
 * - With a Cloudflare API token: the unified `/ai/run` endpoint. This is the
 *   only REST path that serves third-party models such as `typesafe/jev`; the
 *   token needs Account > Workers AI > Read.
 * - `@cf/` models with only a gateway token:
 *   `gateway.ai.cloudflare.com/.../workers-ai/{model}` with `cf-aig-authorization`.
 *   The `workers-ai/` route cannot reach third-party models, so a gateway token
 *   alone is not enough for Jev.
 */
export function resolveEvaluateRequest(
  config: CloudflareGatewayConfig,
  modelId: string,
): {
  url: string;
  headers: Record<string, string>;
  /** When true, POST body is `{ model, input }`; otherwise body is the input. */
  wrapInModelInput: boolean;
} {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
    if (config.gateway) headers['cf-aig-gateway-id'] = config.gateway;
    return {
      url: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run`,
      headers,
      wrapInModelInput: true,
    };
  }

  if (config.gatewayToken && isWorkersAiModel(modelId)) {
    headers['cf-aig-authorization'] = `Bearer ${config.gatewayToken}`;
    return {
      url: `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gateway ?? 'default'}/workers-ai/${modelId}`,
      headers,
      wrapInModelInput: false,
    };
  }

  throw new GatewayConfigError(
    'cloudflare',
    isWorkersAiModel(modelId)
      ? 'AI_GATEWAY_API_TOKEN / CLOUDFLARE_API_TOKEN / CF_API_TOKEN (or CF_AIG_TOKEN)'
      : 'an AI binding, or AI_GATEWAY_API_TOKEN / CLOUDFLARE_API_TOKEN / CF_API_TOKEN with Workers AI Read',
  );
}

/**
 * Whether {@link evaluate} can run `modelId` with this env: the worker has an
 * `AI` binding, or the REST config resolves.
 */
export function isEvaluateConfigured(env?: object, modelId: string = JEV_MODEL_ID): boolean {
  if (aiBinding(env)) return true;
  try {
    resolveEvaluateRequest(resolveEvaluateConfig(env), modelId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a Jev evaluation through Workers AI / AI Gateway.
 *
 * Prefers the worker's `AI` binding (no tokens needed; routed through the
 * `CF_AI_GATEWAY` gateway, or `default`), and falls back to the REST API.
 *
 * @example
 * ```ts
 * const { answers } = await evaluate(env, {
 *   state: { subject, from, preview },
 *   questions: {
 *     billing: {
 *       type: 'noul',
 *       instructions: 'Is this about billing?',
 *       criteria: { true: 'Billing/invoices', false: 'Anything else' },
 *     },
 *   },
 * });
 * ```
 */
export async function evaluate(
  envOrConfig: object | WeldAiConfig | undefined,
  input: EvaluateInput,
  opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const modelId = input.modelId ?? JEV_MODEL_ID;
  const modelInput = { state: input.state, questions: input.questions };
  const startedAt = Date.now();

  const binding = isCloudflareConfig(envOrConfig) ? undefined : aiBinding(envOrConfig);
  let raw: unknown;
  if (binding) {
    const gateway = (envOrConfig as { CF_AI_GATEWAY?: unknown }).CF_AI_GATEWAY;
    raw = await binding.run(modelId, modelInput, {
      gateway: { id: typeof gateway === 'string' && gateway ? gateway : 'default' },
    });
  } else {
    const config = resolveEvaluateConfig(envOrConfig);
    const { url, headers, wrapInModelInput } = resolveEvaluateRequest(config, modelId);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(wrapInModelInput ? { model: modelId, input: modelInput } : modelInput),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[@weldsuite/ai] Jev evaluate failed (${res.status}) on cloudflare: ${body.slice(0, 500)}`,
      );
    }
    raw = (await res.json()) as unknown;
  }

  const parsed = parseEvaluateResponse(raw);

  const result: EvaluateResult = {
    model: parsed.model,
    answers: parsed.answers,
    usage: parsed.usage,
    gateway: 'cloudflare',
    modelId,
  };

  await reportEvaluateUsage(opts, result, Date.now() - startedAt);
  return result;
}

function resolveEvaluateConfig(envOrConfig: object | WeldAiConfig | undefined): CloudflareGatewayConfig {
  if (isCloudflareConfig(envOrConfig)) return envOrConfig;
  const resolved = resolveConfig(envOrConfig);
  if (resolved.provider !== 'cloudflare') {
    throw new GatewayConfigError('cloudflare', 'provider');
  }
  return resolved;
}

function isCloudflareConfig(value: unknown): value is CloudflareGatewayConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { provider?: string }).provider === 'cloudflare' &&
    typeof (value as { accountId?: unknown }).accountId === 'string' &&
    'defaultModel' in (value as object)
  );
}

/**
 * Accept the bare Jev response, the REST `{ result, success }` envelope, and
 * the unified `/ai/run` shape for third-party models, which nests once more:
 * `{ result: { state: 'Completed', result: { model, answers, usage } } }`.
 */
export function parseEvaluateResponse(raw: unknown): {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: AiUsage;
} {
  const root = unwrapResult(raw);
  if (!root || typeof root !== 'object') {
    throw new Error('[@weldsuite/ai] Jev evaluate returned an empty body');
  }

  const obj = root as Record<string, unknown>;
  const answers = obj.answers;
  if (!answers || typeof answers !== 'object') {
    throw new Error('[@weldsuite/ai] Jev evaluate response missing answers');
  }

  const usageRaw = (obj.usage ?? {}) as Record<string, unknown>;
  const usage: AiUsage = {
    inputTokens: num(usageRaw.input_tokens) ?? num(usageRaw.inputTokens) ?? 0,
    outputTokens: num(usageRaw.output_tokens) ?? num(usageRaw.outputTokens) ?? 0,
  };
  usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);

  return {
    model: typeof obj.model === 'string' ? obj.model : JEV_MODEL_ID,
    answers: answers as Record<string, JevAnswer>,
    usage,
  };
}

function unwrapResult(raw: unknown): unknown {
  let current = raw;
  // Peel `{ result }` envelopes until we reach the object carrying `answers`.
  for (let depth = 0; depth < 3; depth++) {
    if (!current || typeof current !== 'object') return current;
    const obj = current as Record<string, unknown>;
    if ('answers' in obj) return obj;
    if (obj.success === false) {
      const errors = Array.isArray(obj.errors) ? JSON.stringify(obj.errors) : 'unknown error';
      throw new Error(`[@weldsuite/ai] Jev evaluate API error: ${errors}`);
    }
    if (!('result' in obj) || obj.result === undefined) return current;
    if (typeof obj.state === 'string' && obj.state !== 'Completed') {
      throw new Error(`[@weldsuite/ai] Jev evaluate did not complete (state: ${obj.state})`);
    }
    current = obj.result;
  }
  return current;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function reportEvaluateUsage(
  opts: EvaluateOptions,
  result: EvaluateResult,
  durationMs: number,
): Promise<void> {
  if (!opts.onUsage) return;
  try {
    const record: GatewayUsageRecord = {
      gateway: result.gateway,
      modelId: result.modelId,
      nativeModelId: result.modelId,
      usage: result.usage,
      providerCostUsd: providerCostUsd(result.modelId, result.usage),
      coveredByServiceCredit: false,
      op: opts.op ?? 'ai_evaluate',
      attempts: [{ gateway: result.gateway, ok: true, durationMs }],
    };
    await opts.onUsage(record);
  } catch (err) {
    console.error('[@weldsuite/ai] recording Jev gateway usage failed (cost untracked):', err);
  }
}
