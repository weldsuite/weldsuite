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

/**
 * Workers AI chat schemas reject OpenAI content-part arrays (`[{type:'text',...}]`)
 * and often reject `content: null` on assistant tool-call turns. Flatten to plain
 * strings before the request leaves the adapter.
 *
 * @see https://github.com/cloudflare/cloudflare-os/issues/54
 */
export function flattenWorkersAiRequestBody(args: Record<string, unknown>): Record<string, unknown> {
  const messages = args.messages;
  if (!Array.isArray(messages)) return args;

  return {
    ...args,
    messages: messages.map((msg) => {
      if (!msg || typeof msg !== 'object') return msg;
      const m = { ...(msg as Record<string, unknown>) };
      const content = m.content;

      if (Array.isArray(content)) {
        m.content = content
          .map((part) => {
            if (typeof part === 'string') return part;
            if (part && typeof part === 'object') {
              const p = part as Record<string, unknown>;
              if (typeof p.text === 'string') return p.text;
              if (p.type === 'text' && typeof p.text === 'string') return p.text;
            }
            return '';
          })
          .filter((s) => s.length > 0)
          .join('\n');
      } else if (content === null || content === undefined) {
        // Assistant messages with tool_calls often arrive as content:null.
        m.content = '';
      }

      return m;
    }),
  };
}

function openAiCompatibleProvider(
  name: string,
  opts: {
    baseURL: string;
    apiKey?: string;
    headers?: Record<string, string>;
  },
) {
  return createOpenAICompatible({
    name,
    baseURL: opts.baseURL,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    transformRequestBody: flattenWorkersAiRequestBody,
  });
}

/** Direct Workers AI provider (Authorization bearer). Used for embeddings, and for
 *  everything when no gateway is configured. */
function directProvider(config: CloudflareGatewayConfig) {
  return openAiCompatibleProvider('weldsuite-cloudflare-workers-ai', {
    baseURL: config.baseURL ?? restApiBaseUrl(config.accountId),
    apiKey: config.apiKey,
    headers: config.headers,
  });
}

export function createCloudflareAdapter(config: CloudflareGatewayConfig): AdapterRuntime {
  const useGateway = Boolean(config.gateway);

  const languageProvider = useGateway
    ? openAiCompatibleProvider('weldsuite-cloudflare-ai-gateway', {
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
