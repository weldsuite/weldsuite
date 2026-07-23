/**
 * WeldSuite AI gateway factory.
 *
 * Binds the Vercel AI SDK to the Cloudflare AI Gateway. The returned
 * `model()` / `embedding()` helpers hand back plain AI SDK model objects, so
 * they drop straight into `generateText`, `streamText`, `generateObject`,
 * `embed`, tool calling, etc.
 *
 * Call sites pass **canonical** model ids (the Cloudflare-shaped vocabulary in
 * `models.ts`); `model-map.ts` translates them to native ids (an identity map
 * for the single Cloudflare gateway).
 */

import type { EmbeddingModel, LanguageModel } from 'ai';

import { createAdapter } from './adapters/index.js';
import type { GatewayProvider } from './adapters/types.js';
import { resolveConfig, type WeldAiConfig } from './config.js';
import { resolveModelId } from './model-map.js';
import type { ModelId } from './models.js';

export interface WeldAI {
  /** Resolve a chat/completion model for use with generateText/streamText/etc. */
  model: (id?: ModelId) => LanguageModel;
  /** Resolve a text-embedding model for use with embed/embedMany. */
  embedding: (id: ModelId) => EmbeddingModel;
  /** The underlying AI SDK provider, for advanced/escape-hatch use. */
  provider: unknown;
  /** The resolved configuration (provider, default model, …). */
  config: WeldAiConfig;
  /** Which gateway served this instance. Handy for logs/debugging. */
  gateway: GatewayProvider;
}

/**
 * Create a gateway-bound AI SDK provider.
 *
 * @param configOrEnv A full {@link WeldAiConfig}, or any env-like object
 *   (a Workers `env` — bindings included — or `process.env`) to resolve config
 *   from. Omit in Node to read `process.env` automatically.
 *
 * @example Cloudflare Worker
 * ```ts
 * const ai = createWeldAI(c.env);
 * const { text } = await generateText({
 *   model: ai.model(recommended.draft.free),
 *   prompt,
 * });
 * ```
 */
export function createWeldAI(configOrEnv?: WeldAiConfig | object): WeldAI {
  const config: WeldAiConfig = isFullConfig(configOrEnv)
    ? configOrEnv
    : resolveConfig(configOrEnv);

  const adapter = createAdapter(config);

  return {
    model: (id?: ModelId) =>
      adapter.languageModel(resolveModelId(id ?? config.defaultModel, config.provider)),
    embedding: (id: ModelId) =>
      adapter.textEmbeddingModel(resolveModelId(id, config.provider)),
    provider: adapter.provider,
    config,
    gateway: config.provider,
  };
}

/**
 * Distinguish an already-built config from a raw env bag.
 *
 * A config is identified by its `provider` discriminant. The `accountId`
 * fallback keeps pre-multi-gateway callers working: they passed a Cloudflare
 * config with no `provider` field, so normalise it to `cloudflare` rather than
 * mistaking it for an env bag.
 */
function isFullConfig(value: unknown): value is WeldAiConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.provider === 'string' && 'defaultModel' in candidate) return true;
  if ('accountId' in candidate && 'defaultModel' in candidate) {
    // Legacy Cloudflare-shaped config — stamp the discriminant in place.
    candidate.provider = 'cloudflare';
    return true;
  }
  return false;
}
