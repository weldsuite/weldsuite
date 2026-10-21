/**
 * Cloudflare AI Gateway adapter — the only gateway, serving Workers AI (`@cf/…`)
 * off the free allocation plus third-party models.
 *
 * Chat models always go through the gateway's OpenAI-compatible endpoint
 * (`gateway.ai.cloudflare.com/v1/{acct}/{gateway}/compat`), on `CF_AI_GATEWAY`
 * or the account's `default` gateway, so every call is logged/cached/rate-
 * limited/spend-limited. Only the gateway serves third-party models: the direct
 * Workers AI REST endpoint (`api.cloudflare.com/.../ai/v1`) answers `anthropic/…`
 * ids with "Model not found" (7003), and a 404 is not a fallback-worthy refusal.
 *
 * Ids use the unified `{provider}/{model}` syntax — Workers AI ids gain a
 * `workers-ai/` prefix. Auth is the gateway header ONLY (`cf-aig-authorization:
 * Bearer <CF_AIG_TOKEN, else the AI token>`); third-party models are paid with
 * the gateway's stored provider keys, so no provider `Authorization` header is
 * sent — passing an invalid one 401s even when the gateway auth is valid.
 *
 * Embeddings always use the DIRECT Workers AI endpoint: the compat endpoint's
 * `/embeddings` support is model-dependent, and embeddings gain nothing from
 * gateway caching. They need `Authorization` (a Workers-AI-scoped CF API token).
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { compatBaseUrl, restApiBaseUrl, type CloudflareGatewayConfig } from '../config.js';
import type { AdapterRuntime } from './types.js';

/** Gateway chat models run on when `CF_AI_GATEWAY` is unset. */
export const DEFAULT_GATEWAY_ID = 'default';

/**
 * Map a native id to the unified `{provider}/{model}` syntax the gateway compat
 * endpoint expects. Workers AI ids (`@cf/…`) gain a `workers-ai/` prefix; ids
 * that are already provider-prefixed (`anthropic/…`, `openai/…`) pass through.
 */
export function toGatewayModelId(nativeId: string): string {
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

/** Direct Workers AI provider (Authorization bearer). Embeddings only. */
function directProvider(config: CloudflareGatewayConfig) {
  return openAiCompatibleProvider('weldsuite-cloudflare-workers-ai', {
    baseURL: restApiBaseUrl(config.accountId),
    apiKey: config.apiKey,
    headers: config.headers,
  });
}

/**
 * Gateway compat provider for every chat model. `CF_AIG_TOKEN` when set, else
 * the AI token: one Cloudflare token with AI Gateway Run authenticates both.
 */
function gatewayProvider(config: CloudflareGatewayConfig) {
  const token = config.gatewayToken ?? config.apiKey;
  return openAiCompatibleProvider('weldsuite-cloudflare-ai-gateway', {
    baseURL:
      config.baseURL ?? compatBaseUrl(config.accountId, config.gateway ?? DEFAULT_GATEWAY_ID),
    // Gateway-scoped bearer ONLY — no provider Authorization header (see header).
    headers: {
      ...config.headers,
      ...(token ? { 'cf-aig-authorization': `Bearer ${token}` } : {}),
    },
  });
}

export function createCloudflareAdapter(config: CloudflareGatewayConfig): AdapterRuntime {
  const languageProvider = gatewayProvider(config);
  const embeddingProvider = directProvider(config);

  return {
    provider: languageProvider,
    languageModel: (nativeId) => languageProvider(toGatewayModelId(nativeId)),
    textEmbeddingModel: (nativeId) => embeddingProvider.textEmbeddingModel(nativeId),
  };
}
