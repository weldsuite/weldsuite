/**
 * AI credit pricing — shared rate table + pure cost math.
 *
 * Single source of truth for what an AI call costs in WeldSuite credits.
 * Consumed by both `apps/workers/app-api` (`services/ai/billing.ts`, the interactive
 * `/api/ai/generate` + `/api/workflows/generate` routes) and
 * `apps/workers/workflow-worker` (the `ai_generate` / `ai_classify` workflow engine
 * actions) so the two surfaces can never price the same model differently.
 *
 * Pure — no DB, no wallet mutation. See `@weldsuite/credits` for the actual
 * balance check/consume/grant calls each caller wires on top of this math.
 *
 * MODEL_PRICES = each model's REAL published API list price in USD per 1M
 * tokens (input / output). Sourced from provider pricing pages, verified
 * 2026-07 (Anthropic docs, Cloudflare Workers AI pricing, Google AI Studio,
 * OpenAI). Update a number here when a provider changes its price.
 *
 * A call costs:  rawProviderCostUSD × PROVIDER_MARKUP × CREDITS_PER_USD  credits
 * (min 1). So the money margin over provider cost is PROVIDER_MARKUP, and
 * CREDITS_PER_USD converts dollars into your credit unit.
 *
 * ▸ CREDITS_PER_USD MUST match what a credit sells for in your Stripe top-up
 *   packages: if you sell N credits for $M, set CREDITS_PER_USD = N / M. The
 *   default assumes 1 credit = $0.01 (100 credits per $). Change it to align
 *   with the real `credit_packages` price, then revenue = cost × PROVIDER_MARKUP.
 */

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
}

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  'anthropic/claude-sonnet-4-5': { inputPerM: 3, outputPerM: 15 },
  'anthropic/claude-sonnet-4-6': { inputPerM: 3, outputPerM: 15 },
  'anthropic/claude-haiku-4-5': { inputPerM: 1, outputPerM: 5 },
  'anthropic/claude-opus-4-1': { inputPerM: 15, outputPerM: 75 },
  // OpenAI
  'openai/gpt-5': { inputPerM: 1.25, outputPerM: 10 },
  'openai/gpt-5-mini': { inputPerM: 0.25, outputPerM: 2 },
  'openai/gpt-4o': { inputPerM: 2.5, outputPerM: 10 },
  // Google
  'google-ai-studio/gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
  'google-ai-studio/gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10 },
  // Embeddings — input-only (no output tokens). Without these they fell through
  // to DEFAULT_PRICE and billed at ~150× the real rate.
  'openai/text-embedding-3-small': { inputPerM: 0.02, outputPerM: 0 },
  'openai/text-embedding-3-large': { inputPerM: 0.13, outputPerM: 0 },
  // Cloudflare Workers AI (@cf/*) — real per-token list price, not "free"
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { inputPerM: 0.293, outputPerM: 2.253 },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { inputPerM: 0.27, outputPerM: 0.85 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { inputPerM: 0.051, outputPerM: 0.335 },
  '@cf/meta/llama-3.1-8b-instruct-fast': { inputPerM: 0.045, outputPerM: 0.384 },
};

/** Fallback for other Workers AI models (typical small @cf model). */
export const WORKERS_AI_FALLBACK_PRICE: ModelPrice = { inputPerM: 0.1, outputPerM: 0.4 };
/** Fallback for unknown third-party models — assume Sonnet-class (safe/high). */
export const DEFAULT_PRICE: ModelPrice = { inputPerM: 3, outputPerM: 15 };

/** Margin charged over the raw provider cost. */
export const PROVIDER_MARKUP = 2.5;
/** Credits per USD — MUST match your top-up package (see header). 1 credit = $0.01. */
export const CREDITS_PER_USD = 100;

/** Ids already warned about — keeps a hot loop from spamming the log. */
const warnedUnknownModels = new Set<string>();

/**
 * Price a model by its **canonical** id (see `model-map.ts`). Pricing keys on
 * the canonical id, never the gateway-native one, so switching
 * `AI_GATEWAY_PROVIDER` can't change what a call costs.
 *
 * Unknown ids still fall back (fail-open — never block a call over pricing) but
 * now warn once: a silent fallback bills an unknown model at Sonnet-class
 * $3/$15, which is exactly how `anthropic/claude-sonnet-4-6` went mispriced
 * until it was added above. If you see this warning, add the real rate.
 */
export function priceForModel(modelId: string): ModelPrice {
  const known = MODEL_PRICES[modelId];
  if (known) return known;

  if (!warnedUnknownModels.has(modelId)) {
    warnedUnknownModels.add(modelId);
    console.warn(
      `[@weldsuite/ai] No published price for model "${modelId}" — billing at the ` +
        `${modelId.startsWith('@cf/') ? 'Workers AI' : 'Sonnet-class'} fallback rate. ` +
        `Add it to MODEL_PRICES in packages/ai/src/billing-rates.ts.`,
    );
  }

  return modelId.startsWith('@cf/') ? WORKERS_AI_FALLBACK_PRICE : DEFAULT_PRICE;
}

/** Raw provider cost of a call, in USD. */
export function providerCostUsd(modelId: string, usage: AiUsage): number {
  const price = priceForModel(modelId);
  return (
    ((usage.inputTokens ?? 0) / 1_000_000) * price.inputPerM +
    ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerM
  );
}

/** Credits for one call: markedUpCostUSD × CREDITS_PER_USD, min 1. */
export function creditsForUsage(modelId: string, usage: AiUsage): number {
  const credits = providerCostUsd(modelId, usage) * PROVIDER_MARKUP * CREDITS_PER_USD;
  return Math.max(1, Math.ceil(credits));
}
