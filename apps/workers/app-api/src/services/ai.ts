/**
 * AI service facade — STUBBED (legacy shim, not a statement about AI overall).
 *
 * AI is back: `@weldsuite/ai` is a real package (Vercel AI SDK bound to
 * Cloudflare AI Gateway — see `services/ai/index.ts`'s `/api/ai/generate`
 * route and `services/ai/billing.ts` for the current, live integration).
 * This particular file is a narrower, older adapter shape (a
 * generate/stream/generateWithTools facade with its own credit-gating hooks)
 * that predates the gateway rewrite; it's kept as a no-op/throwing stub only
 * because `services/accounting-ocr.ts` (its sole remaining importer) still
 * references these exact symbol names. New AI call sites should go through
 * `@weldsuite/ai` directly (see `services/ai/index.ts`, `services/mail/ai.ts`,
 * `services/workflow-generation.ts`), not through this file. If
 * accounting-ocr is ever rebuilt on the gateway, this file can be deleted.
 */

import type { Env } from '../types';

// ============================================================================
// Error types — kept for callers that narrow on `instanceof`.
// ============================================================================

export class InsufficientCreditsError extends Error {
  constructor(public readonly currentBalance: number = 0) {
    super('AI is currently unavailable');
    this.name = 'InsufficientCreditsError';
  }
}

export class AgentTokenLimitExceededError extends Error {
  constructor(message = 'AI is currently unavailable') {
    super(message);
    this.name = 'AgentTokenLimitExceededError';
  }
}

export class AiProviderError extends Error {
  constructor(message = 'AI is currently unavailable') {
    super(message);
    this.name = 'AiProviderError';
  }
}

// ============================================================================
// Misc helpers previously re-exported from `@weldsuite/ai`.
// ============================================================================

export function getSessionWindow(): { start: Date; end: Date } {
  const now = new Date();
  return { start: now, end: now };
}

export function getWeekWindow(): { start: Date; end: Date } {
  const now = new Date();
  return { start: now, end: now };
}

// ============================================================================
// Placeholder types — previously re-exported from `@weldsuite/ai`. Kept as
// loose shapes so any remaining type-only imports still resolve.
// ============================================================================

export type ActiveModel = Record<string, unknown>;
export type ChatMessage = Record<string, unknown>;
export type GenerateOptions = Record<string, unknown>;
export type GenerateResult = Record<string, unknown>;
export type GenerateWithToolsOptions = Record<string, unknown>;
export type GenerateWithToolsResult = Record<string, unknown>;
export type StreamOptions = Record<string, unknown>;
export type TokenUsage = Record<string, unknown>;
export type TrackUsageInput = Record<string, unknown>;
export type TrackUsageResult = Record<string, unknown>;

// ============================================================================
// Stubbed provider surface — no-ops / unavailable errors.
// ============================================================================

/** No-op — there is no provider left to register. */
export function ensureAiProviderRegistered(_env: Env): void {
  // Intentionally empty.
}

export async function generate(_env: Env, _options: GenerateOptions): Promise<GenerateResult> {
  console.warn('[ai] AI is currently unavailable — generate() no-op');
  throw new AiProviderError();
}

export async function stream(
  _env: Env,
  _options: StreamOptions,
): Promise<{ response: Response; trackAfterStream: () => Promise<void> }> {
  console.warn('[ai] AI is currently unavailable — stream() no-op');
  throw new AiProviderError();
}

export async function generateWithTools(
  _env: Env,
  _options: GenerateWithToolsOptions,
): Promise<GenerateWithToolsResult> {
  console.warn('[ai] AI is currently unavailable — generateWithTools() no-op');
  throw new AiProviderError();
}

export async function getActiveModels(_env: Env): Promise<ActiveModel[]> {
  console.warn('[ai] AI is currently unavailable — getActiveModels() no-op');
  return [];
}

/**
 * No-op — always resolves. Credit gating is meaningless once there is no
 * model call to gate; callers (accounting-ocr) skip the call entirely now,
 * but this is kept resolvable rather than throwing to avoid surprising any
 * future caller with a hard failure on a pure pre-flight check.
 */
export async function checkCreditsAvailable(_env: Env, _workspaceId: string): Promise<void> {
  console.warn('[ai] AI is currently unavailable — checkCreditsAvailable() no-op');
}

/**
 * Raw usage write — previously used by `services/accounting-ocr.ts` after
 * hitting the gateway directly. No usage to track anymore.
 */
export async function trackUsageAndConsume(
  _env: Env,
  _input: TrackUsageInput,
): Promise<TrackUsageResult> {
  console.warn('[ai] AI is currently unavailable — trackUsageAndConsume() no-op');
  return {};
}
