/**
 * Configuration for the WeldSuite AI package.
 *
 * WeldSuite routes every model call through the **Cloudflare AI Gateway**, via
 * CF's OpenAI-compatible REST API. One CF API token reaches both Workers AI
 * (`@cf/…`, free allocation) and third-party models (unified billing). The
 * gateway choice is invisible to call sites: it owns auth + base URL + model-id
 * translation, nothing else.
 *
 * Runtime-agnostic: pass config explicitly (Cloudflare Workers, where env is
 * injected per-request) or let {@link resolveConfig} read `process.env`
 * (Node / scripts).
 */

import { GatewayConfigError, type GatewayProvider } from './adapters/types.js';
import { ROUTING_MODES, type RoutingMode } from './routing.js';

/**
 * Env shape we read config from — a Workers `env` (which also holds non-string
 * bindings) or `process.env`. Only string values are read; anything else is
 * ignored, so passing a full Worker `env` is safe.
 */
export type EnvLike = Record<string, unknown>;

/** Read a value only if it's a string (Worker envs carry non-string bindings). */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const GATEWAY_PROVIDERS: readonly GatewayProvider[] = ['cloudflare'];

/** The only gateway. `AI_GATEWAY_PROVIDER` exists for forward-compat but must be this. */
export const DEFAULT_PROVIDER: GatewayProvider = 'cloudflare';

/** Free Workers AI 70B model — the zero-cost default. */
export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

interface CommonConfig {
  /** Default **canonical** model id used when a caller doesn't specify one. */
  defaultModel: string;
  /** Extra headers merged onto every request. */
  headers?: Record<string, string>;
  /** Override the provider's base URL. Rarely needed. */
  baseURL?: string;
}

export interface CloudflareGatewayConfig extends CommonConfig {
  provider: 'cloudflare';
  /** Cloudflare account ID that owns AI Gateway / Workers AI. */
  accountId: string;
  /**
   * Cloudflare API token → `Authorization: Bearer <token>`. Needs Workers AI +
   * AI Gateway Run permissions.
   */
  apiKey?: string;
  /** AI Gateway id → `cf-aig-gateway-id`. Omit for the account default gateway. */
  gateway?: string;
  /** Gateway auth token → `cf-aig-authorization`. Only for "Authenticated" gateways. */
  gatewayToken?: string;
}

export type WeldAiConfig = CloudflareGatewayConfig;

/**
 * Cloudflare's OpenAI-compatible REST API base (routed through AI Gateway).
 * The AI SDK's openai-compatible provider appends `/chat/completions` and
 * `/embeddings`.
 */
export function restApiBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

/**
 * Legacy AI Gateway "Unified API" compat endpoint. Deprecated by Cloudflare in
 * favour of {@link restApiBaseUrl}, but still functional; handy for BYOK where
 * `apiKey` is a provider key rather than a Cloudflare token.
 */
export function compatBaseUrl(accountId: string, gateway: string): string {
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/compat`;
}

/** Parse + validate `AI_GATEWAY_PROVIDER`. Cloudflare is the only accepted value. */
export function resolveProvider(env?: object): GatewayProvider {
  const source = readEnv(env);
  const raw = str(source.AI_GATEWAY_PROVIDER)?.toLowerCase();
  if (!raw) return DEFAULT_PROVIDER;
  if (!GATEWAY_PROVIDERS.includes(raw as GatewayProvider)) {
    throw new Error(
      `[@weldsuite/ai] Unknown AI_GATEWAY_PROVIDER "${raw}". Only "cloudflare" is supported.`,
    );
  }
  return raw as GatewayProvider;
}

function readEnv(env?: object): EnvLike {
  return (env ??
    (typeof process !== 'undefined' && process.env ? process.env : {})) as EnvLike;
}

/**
 * Resolve config from an env-like record. In Workers, pass the request `env`;
 * in Node this defaults to `process.env`.
 *
 * - `AI_GATEWAY_PROVIDER`  optional, must be `cloudflare`
 * - `AI_DEFAULT_MODEL`     default canonical model id
 * - `CF_ACCOUNT_ID` / `CLOUDFLARE_ACCOUNT_ID`   (required)
 * - `AI_GATEWAY_API_TOKEN` / `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` → Authorization
 * - `CF_AI_GATEWAY`  gateway id, `CF_AIG_TOKEN`  gateway auth token
 */
export function resolveConfig(env?: object): WeldAiConfig {
  return resolveConfigFor(resolveProvider(env), env);
}

/**
 * Resolve the config for a SPECIFIC gateway. Kept as a named seam for
 * {@link configuredGateways}; throws {@link GatewayConfigError} when the
 * gateway's env is incomplete.
 */
export function resolveConfigFor(provider: GatewayProvider, env?: object): WeldAiConfig {
  const source = readEnv(env);
  const defaultModel = str(source.AI_DEFAULT_MODEL) ?? DEFAULT_MODEL;

  // `provider` is always 'cloudflare'; the switch keeps the seam explicit.
  switch (provider) {
    case 'cloudflare': {
      const accountId = str(source.CF_ACCOUNT_ID) ?? str(source.CLOUDFLARE_ACCOUNT_ID);
      if (!accountId) {
        throw new GatewayConfigError('cloudflare', 'CF_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_ID');
      }
      return {
        provider: 'cloudflare',
        accountId,
        apiKey:
          str(source.AI_GATEWAY_API_TOKEN) ??
          str(source.CLOUDFLARE_API_TOKEN) ??
          str(source.CF_API_TOKEN),
        gateway: str(source.CF_AI_GATEWAY),
        gatewayToken: str(source.CF_AIG_TOKEN),
        defaultModel,
      };
    }
  }
}

/**
 * Throw {@link GatewayConfigError} unless the gateway has everything it needs.
 * Consumers should call this before doing expensive setup (credit checks, prompt
 * assembly) so a misconfigured worker fails fast — `apps/workers/workflow-worker`
 * uses it for exactly that.
 */
export function assertGatewayConfigured(env?: object): void {
  resolveConfig(env);
}

/** Non-throwing variant of {@link assertGatewayConfigured}. */
export function isGatewayConfigured(env?: object): boolean {
  try {
    resolveConfig(env);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Every gateway whose env is complete, in a stable order. Never throws — an
 * unconfigured gateway is simply absent. With a single gateway this is either
 * `[cloudflare]` or `[]`.
 */
export function configuredGateways(env?: object): WeldAiConfig[] {
  const source = readEnv(env);
  const configs: WeldAiConfig[] = [];
  for (const provider of GATEWAY_PROVIDERS) {
    try {
      configs.push(resolveConfigFor(provider, source));
    } catch {
      // Not configured — skip.
    }
  }
  return configs;
}

/**
 * How much freedom the router has: `off` (default) | `fallback` | `cost`.
 *
 * With one gateway every mode resolves to "cloudflare only". Kept so a stray
 * `AI_GATEWAY_ROUTING` value fails loudly rather than silently.
 */
export function resolveRoutingMode(env?: object): RoutingMode {
  const raw = str(readEnv(env).AI_GATEWAY_ROUTING)?.toLowerCase();
  if (!raw) return 'off';
  if (!ROUTING_MODES.includes(raw as RoutingMode)) {
    throw new Error(
      `[@weldsuite/ai] Unknown AI_GATEWAY_ROUTING "${raw}". Expected one of: ${ROUTING_MODES.join(', ')}.`,
    );
  }
  return raw as RoutingMode;
}

/**
 * Last-resort gateway order for when the credit snapshot is unavailable. With a
 * single gateway this is always `[cloudflare]`; `AI_GATEWAY_ORDER` is honoured
 * for forward-compat.
 */
export function resolveGatewayOrder(env?: object): GatewayProvider[] {
  const raw = str(readEnv(env).AI_GATEWAY_ORDER);
  if (!raw) return [...GATEWAY_PROVIDERS];
  const order = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is GatewayProvider => GATEWAY_PROVIDERS.includes(s as GatewayProvider));
  // Append any gateway the operator forgot, so a typo can't strand a gateway.
  return [...order, ...GATEWAY_PROVIDERS.filter((g) => !order.includes(g))];
}
