/**
 * Cloudflare AI Gateway adapter — the only gateway, serving Workers AI (`@cf/…`)
 * off the free allocation plus third-party models.
 *
 * Two modes, chosen by whether a gateway id (`CF_AI_GATEWAY`) is configured:
 *
 *  - **Gateway (recommended).** Routes through the gateway's OpenAI-compatible
 *    endpoint (`gateway.ai.cloudflare.com/v1/{acct}/{gateway}/compat`), so every
 *    call is logged/cached/rate-limited/spend-limited. Uses the unified
 *    `{provider}/{model}` id syntax — Workers AI ids gain a `workers-ai/` prefix.
 *    Auth is the gateway-scoped token ONLY (`cf-aig-authorization: Bearer
 *    <CF_AIG_TOKEN>`): an authenticated gateway proves account ownership and
 *    Workers AI is billed via unified billing, so no provider `Authorization`
 *    header is sent — passing an invalid one 401s even when the gateway auth is
 *    valid. (Third-party models route via the gateway's stored provider keys.)
 *
 *  - **Direct (fallback).** No gateway id → the direct Workers AI REST endpoint
 *    (`api.cloudflare.com/.../ai/v1`), `@cf/…` ids unprefixed, `Authorization:
 *    Bearer <CF API token>` only. This is the pre-gateway behaviour; unchanged.
 *
 * Embeddings always use the DIRECT Workers AI endpoint, even in gateway mode:
 * the compat endpoint's `/embeddings` support is model-dependent, and embeddings
 * gain nothing from gateway caching. They need `Authorization` (a Workers-AI-
 * scoped CF API token) regardless.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { compatBaseUrl, restApiBaseUrl, type CloudflareGatewayConfig } from '../config.js';
import type { AdapterRuntime } from './types.js';

/**
 * Map a native id to the unified `{provider}/{model}` syntax the gateway compat
 * endpoint expects. Workers AI ids (`@cf/…`) gain a `workers-ai/` prefix; ids
 * that are already provider-prefixed (`anthropic/…`, `openai/…`) pass through.
 * A no-op in direct mode.
 */
export function toGatewayModelId(nativeId: string, useGateway: boolean): string {
  if (!useGateway) return nativeId;
  return nativeId.startsWith('@cf/') ? `workers-ai/${nativeId}` : nativeId;
}

/** Direct Workers AI provider (Authorization bearer). Used for embeddings, and for
 *  everything when no gateway is configured. */
function directProvider(config: CloudflareGatewayConfig) {
  return createOpenAICompatible({
    name: 'weldsuite-cloudflare-workers-ai',
    baseURL: config.baseURL ?? restApiBaseUrl(config.accountId),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
  });
}

export function createCloudflareAdapter(config: CloudflareGatewayConfig): AdapterRuntime {
  const useGateway = Boolean(config.gateway);

  const languageProvider = useGateway
    ? createOpenAICompatible({
        name: 'weldsuite-cloudflare-ai-gateway',
        baseURL: config.baseURL ?? compatBaseUrl(config.accountId, config.gateway!),
        // Gateway-scoped bearer ONLY — no provider Authorization header (see header).
        headers: {
          ...config.headers,
          ...(config.gatewayToken
            ? { 'cf-aig-authorization': `Bearer ${config.gatewayToken}` }
            : {}),
        },
      })
    : directProvider(config);

  // Embeddings: always the direct Workers AI endpoint.
  const embeddingProvider = useGateway ? directProvider(config) : languageProvider;

  return {
    provider: languageProvider,
    languageModel: (nativeId) => languageProvider(toGatewayModelId(nativeId, useGateway)),
    textEmbeddingModel: (nativeId) => embeddingProvider.textEmbeddingModel(nativeId),
  };
}
