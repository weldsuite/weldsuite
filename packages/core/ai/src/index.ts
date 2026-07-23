/**
 * `@weldsuite/ai` — the one place WeldSuite talks to LLMs.
 *
 * This package re-exports the **Vercel AI SDK** in full and adds a thin factory
 * ({@link createWeldAI}) that binds the SDK to a **Cloudflare AI Gateway**. Use
 * the SDK exactly as documented — just get your model from here so every call
 * is routed, logged, and cached through the gateway.
 *
 * @example Cloudflare Worker (explicit env)
 * ```ts
 * import { createWeldAI, generateText } from '@weldsuite/ai';
 *
 * const ai = createWeldAI(c.env);
 * const { text } = await generateText({
 *   model: ai.model('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), // free Workers AI
 *   prompt: 'Summarise this ticket…',
 * });
 * ```
 *
 * @example Node / script (reads process.env)
 * ```ts
 * import { model, generateObject } from '@weldsuite/ai';
 * import { z } from 'zod';
 *
 * const { object } = await generateObject({
 *   model: model(),                       // default model from AI_DEFAULT_MODEL
 *   schema: z.object({ sentiment: z.enum(['pos', 'neg', 'neu']) }),
 *   prompt: text,
 * });
 * ```
 */

// Re-export the entire Vercel AI SDK: generateText, streamText, generateObject,
// streamObject, embed, embedMany, tool, stepCountIs, jsonSchema, all types, …
export * from 'ai';

// Gateway factory + configuration.
export { createWeldAI, type WeldAI } from './gateway.js';
export {
  resolveConfig,
  resolveProvider,
  assertGatewayConfigured,
  isGatewayConfigured,
  restApiBaseUrl,
  compatBaseUrl,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  GATEWAY_PROVIDERS,
  type WeldAiConfig,
  type CloudflareGatewayConfig,
  type EnvLike,
} from './config.js';

// Gateway adapter — the Cloudflare seam (kept for a future second gateway).
export {
  createAdapter,
  UnsupportedModelError,
  GatewayConfigError,
  type AdapterRuntime,
  type GatewayProvider,
} from './adapters/index.js';
export { resolveModelId, isModelSupported, knownCanonicalIds } from './model-map.js';

// Cost-aware routing + failover. `AI_GATEWAY_ROUTING` defaults to 'off', which
// is byte-identical to a single pinned gateway.
export {
  rankCandidates,
  effectiveCostUsd,
  GATEWAY_FEE_MULTIPLIER,
  ROUTING_MODES,
  type RoutingMode,
  type ModelKind,
  type GatewayCandidate,
  type GatewayCreditState,
} from './routing.js';
export {
  runWithFallback,
  pickGateway,
  pickEmbedding,
  planRoute,
  type Attempt,
  type RunOptions,
  type RunResult,
  type GatewayUsageRecord,
  type RecordGatewayUsage,
} from './run.js';
export {
  classifyGatewayError,
  unwrapGatewayError,
  isAuthFailure,
  isBillingFailure,
  AllGatewaysFailedError,
  type FailureKind,
  type GatewayAttempt,
} from './errors.js';
export {
  configuredGateways,
  resolveConfigFor,
  resolveRoutingMode,
  resolveGatewayOrder,
} from './config.js';
export {
  models,
  workersAi,
  thirdParty,
  recommended,
  type ModelId,
} from './models.js';

// Shared AI credit pricing (rate table + pure cost math) — see billing-rates.ts
// header for why this lives here instead of duplicated in every consumer.
export {
  MODEL_PRICES,
  WORKERS_AI_FALLBACK_PRICE,
  DEFAULT_PRICE,
  PROVIDER_MARKUP,
  CREDITS_PER_USD,
  priceForModel,
  providerCostUsd,
  creditsForUsage,
  type ModelPrice,
  type AiUsage,
} from './billing-rates.js';

import { createWeldAI, type WeldAI } from './gateway.js';
import type { ModelId } from './models.js';

let _default: WeldAI | undefined;

/**
 * Lazily-created default gateway, resolved from `process.env`. Convenient for
 * Node and scripts. In Cloudflare Workers there is no ambient env — call
 * {@link createWeldAI} with the request `env` instead.
 */
export function defaultAI(): WeldAI {
  return (_default ??= createWeldAI());
}

/** Shorthand for `defaultAI().model(id)`. Node/script convenience. */
export const model = (id?: ModelId) => defaultAI().model(id);

/** Shorthand for `defaultAI().embedding(id)`. Node/script convenience. */
export const embedding = (id: ModelId) => defaultAI().embedding(id);
