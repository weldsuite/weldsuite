/**
 * Gateway adapter contract.
 *
 * WeldSuite talks to the Cloudflare AI Gateway. The adapter owns *auth + base URL
 * + how to ask its SDK provider for a model*; {@link createWeldAI} builds one and
 * hands back the same {@link WeldAI} to every call site. Model-id translation
 * lives in `model-map.ts`, so an adapter always receives a **native** id.
 *
 * The `GatewayProvider` type is kept as a (now single-member) union so the seam
 * survives a future second gateway without a call-site rewrite.
 */

import type { EmbeddingModel, LanguageModel } from 'ai';

import type { WeldAiConfig } from '../config.js';

/** The gateways WeldSuite can be pointed at. Cloudflare is the only one. */
export type GatewayProvider = 'cloudflare';

/** Runtime returned by an adapter factory. */
export interface AdapterRuntime {
  /**
   * The underlying AI SDK provider object. Escape hatch for provider-specific
   * features; prefer `languageModel`/`textEmbeddingModel`.
   */
  provider: unknown;
  /** Resolve a chat/completion model from a **native** (already-mapped) id. */
  languageModel(nativeId: string): LanguageModel;
  /** Resolve a text-embedding model from a **native** (already-mapped) id. */
  textEmbeddingModel(nativeId: string): EmbeddingModel;
}

export type AdapterFactory<C extends WeldAiConfig = WeldAiConfig> = (
  config: C,
) => AdapterRuntime;

/**
 * Thrown when the gateway cannot serve a model at all.
 *
 * This exists so a capability gap fails loudly at the call site with an
 * actionable message, instead of surfacing as an opaque upstream 404.
 */
export class UnsupportedModelError extends Error {
  constructor(
    readonly canonicalId: string,
    readonly provider: GatewayProvider,
    reason?: string,
  ) {
    super(
      `[@weldsuite/ai] Model "${canonicalId}" is not available on the "${provider}" gateway` +
        (reason ? ` — ${reason}` : '') +
        `. Either map it in model-map.ts or pick a model this gateway serves.`,
    );
    this.name = 'UnsupportedModelError';
  }
}

/**
 * Thrown when the gateway is missing its required env.
 *
 * The message intentionally keeps the `gateway is not configured` wording that
 * `apps/workers/workflow-worker`'s `ai.test.ts` asserts on (`/gateway is not configured/i`).
 */
export class GatewayConfigError extends Error {
  constructor(
    readonly provider: GatewayProvider,
    missing: string,
  ) {
    super(`AI gateway is not configured (missing ${missing}) for provider "${provider}"`);
    this.name = 'GatewayConfigError';
  }
}
