/**
 * Canonical model ids → gateway-native ids.
 *
 * ## Why canonical ids are Cloudflare-shaped
 *
 * WeldSuite's canonical vocabulary *is* the Cloudflare id set (`@cf/…`,
 * `anthropic/claude-sonnet-4-5`, `google-ai-studio/gemini-2.5-flash`). Because
 * the only gateway is Cloudflare, translation is the identity map — but the
 * `resolveModelId`/`isModelSupported` seam is kept so a future second gateway
 * slots in here rather than at every call site.
 *
 * `billing-rates.ts` prices a call by its canonical id, so the ids below double
 * as the "known, priced" set surfaced by {@link knownCanonicalIds}.
 */

import type { GatewayProvider } from './adapters/types.js';

/** Canonical (== Cloudflare-native) ids WeldSuite prices and autocompletes. */
const KNOWN_CANONICAL_IDS: readonly string[] = [
  // Anthropic
  'anthropic/claude-sonnet-4-5',
  'anthropic/claude-sonnet-4-6',
  'anthropic/claude-haiku-4-5',
  'anthropic/claude-opus-4-1',
  // OpenAI
  'openai/gpt-5',
  'openai/gpt-5-mini',
  'openai/gpt-4o',
  // Google
  'google-ai-studio/gemini-2.5-flash',
  'google-ai-studio/gemini-2.5-pro',
  // Embeddings
  'openai/text-embedding-3-small',
  'openai/text-embedding-3-large',
];

/**
 * Translate a canonical id into the native id for `provider`.
 *
 * Cloudflare-native ids equal the canonical ids by construction, so this is the
 * identity map. Unknown ids pass through unchanged: the catalog moves faster
 * than this table and the gateway accepts any string it understands. The
 * `provider` param is retained for the seam and is always `'cloudflare'`.
 */
export function resolveModelId(canonicalId: string, _provider: GatewayProvider = 'cloudflare'): string {
  return canonicalId;
}

/** True when `provider` can serve `canonicalId`. Cloudflare serves everything. */
export function isModelSupported(_canonicalId: string, _provider: GatewayProvider = 'cloudflare'): boolean {
  return true;
}

/** Canonical ids known to this package (for validation / model-picker UIs). */
export function knownCanonicalIds(): string[] {
  return [...KNOWN_CANONICAL_IDS];
}
