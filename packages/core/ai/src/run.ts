/**
 * Gateway execution with fallback.
 *
 * ## Why this is a wrapper and not a smart `ai.model()`
 *
 * The tempting design is for `ai.model(id)` to return a `LanguageModel` that
 * internally records usage, leaving call sites untouched. It doesn't work here:
 *
 *  - **No request context.** `doGenerate` sees usage but not workspace/op, so it
 *    can't record which gateway served the call — and the caller can't learn it
 *    except through a mutable field, which `generateText`'s tool loop makes racy.
 *  - **Nested retries.** Fallback inside `doGenerate` sits inside the SDK's own
 *    retry loop, multiplying attempts.
 *
 * So fallback wraps the CALL. `createWeldAI` stays synchronous and unchanged.
 *
 * ## Streaming is deliberately excluded
 *
 * Once a stream emits its first chunk you cannot retry it, and buffering until
 * the first chunk to make failures retryable defeats streaming. Nothing in the
 * repo streams today. Use {@link pickGateway} for a streaming call site — it
 * gives you cost routing without a fallback promise we can't keep.
 *
 * ## This module never touches the credit wallet
 *
 * The customer is charged ONCE, by the call site, after this returns, keyed on
 * the CANONICAL model id — so the price is identical no matter which gateway
 * served it. `onUsage` records what *we* paid, which does vary. Keeping those
 * two ledgers apart is the whole design; don't merge them.
 */

import type { EmbeddingModel, LanguageModel } from 'ai';

import { UnsupportedModelError, type GatewayProvider } from './adapters/types.js';
import {
  configuredGateways,
  resolveGatewayOrder,
  resolveProvider,
  resolveRoutingMode,
} from './config.js';
import {
  AllGatewaysFailedError,
  classifyGatewayError,
  isAuthFailure,
  isBillingFailure,
  type GatewayAttempt,
} from './errors.js';
import { createWeldAI, type WeldAI } from './gateway.js';
import { providerCostUsd, type AiUsage } from './billing-rates.js';
import {
  rankCandidates,
  type GatewayCandidate,
  type GatewayCreditState,
  type ModelKind,
} from './routing.js';

/** One gateway's turn at serving a call. */
export interface Attempt {
  /** Gateway-bound SDK wrapper for this attempt. */
  ai: WeldAI;
  /** Pre-resolved model — pass straight to generateText/generateObject. */
  model: LanguageModel;
  /** Canonical model id — unchanged across attempts. */
  modelId: string;
  gateway: GatewayProvider;
  attemptIndex: number;
}

/** What we paid to serve one call. Recorded on success only. */
export interface GatewayUsageRecord {
  gateway: GatewayProvider;
  /** Canonical id — what billing and the reports key on. */
  modelId: string;
  nativeModelId: string;
  usage: AiUsage | undefined;
  /** List price × the gateway's fee factor. `0` when service credit covered it. */
  providerCostUsd: number;
  coveredByServiceCredit: boolean;
  op: string;
  /** Every attempt, including failures — the gateway-health signal. */
  attempts: GatewayAttempt[];
}

export type RecordGatewayUsage = (record: GatewayUsageRecord) => void | Promise<void>;

export interface RunOptions<T> {
  /** Canonical model id. */
  modelId: string;
  /** Short verb for the ops ledger: `ai_generate`, `mail_draft`, … */
  op: string;
  kind?: ModelKind;
  /** Credit state per gateway (from the KV snapshot). Omit → nothing is "free". */
  credits?: readonly GatewayCreditState[];
  /** Injected so this module stays DB-free. Never allowed to fail the call. */
  onUsage?: RecordGatewayUsage;
  /** Pull usage off the result. Defaults to `result.usage` (generateText/Object). */
  extractUsage?: (value: T) => AiUsage | undefined;
}

export interface RunResult<T> {
  value: T;
  /** The gateway that actually served it. */
  gateway: GatewayProvider;
  attempts: GatewayAttempt[];
}

function defaultExtractUsage<T>(value: T): AiUsage | undefined {
  return (value as { usage?: AiUsage } | null)?.usage;
}

/**
 * Build the ranked candidate list for a call. Exported for tests/diagnostics.
 *
 * On a credit-snapshot miss the caller passes no `credits`, so nothing ranks as
 * free and ordering falls back to fee + the `AI_GATEWAY_ORDER` pin — degraded,
 * never broken.
 */
export function planRoute(
  env: object | undefined,
  opts: { modelId: string; kind?: ModelKind; credits?: readonly GatewayCreditState[] },
): GatewayCandidate[] {
  const mode = resolveRoutingMode(env);
  const configured = configuredGateways(env);

  // `resolveProvider` throws on a bad value and defaults to cloudflare; in
  // fallback/cost the pin is only a tie-break, so an unconfigured pin is fine.
  const pinned = resolveProvider(env);

  const candidates = rankCandidates({
    configured,
    modelId: opts.modelId,
    kind: opts.kind,
    credits: opts.credits,
    pinned,
    mode,
  });

  if (mode !== 'cost' || opts.credits?.length) return candidates;

  // No credit info: honour AI_GATEWAY_ORDER so a KV outage degrades to a
  // deterministic operator-chosen order instead of alphabetical chance.
  const order = resolveGatewayOrder(env);
  return [...candidates].sort((a, b) => order.indexOf(a.gateway) - order.indexOf(b.gateway));
}

/** Choose ONE gateway without fallback. Safe for streaming; sync, like `createWeldAI`. */
export function pickGateway(
  env: object | undefined,
  opts: { modelId: string; kind?: ModelKind; credits?: readonly GatewayCreditState[] },
): Attempt {
  const candidates = planRoute(env, opts);
  const first = candidates[0];
  if (!first) throw noCandidatesError(opts.modelId, opts.kind);
  return toAttempt(first, opts.modelId, 0);
}

/**
 * Run `run` against the best gateway, falling back to the next on a failure that
 * another gateway might survive.
 *
 * Terminal failures (400, unsupported model, unknown bugs) throw immediately —
 * retrying them elsewhere just triples the latency and the bill. See `errors.ts`
 * for why 402 and 401/403 are NOT terminal.
 *
 * Pass `maxRetries: 1` to generateText/generateObject inside `run`: the SDK's
 * default of 2 burns two backed-off in-gateway retries before we ever reach the
 * next gateway.
 */
export async function runWithFallback<T>(
  env: object | undefined,
  opts: RunOptions<T>,
  run: (attempt: Attempt) => Promise<T>,
): Promise<RunResult<T>> {
  const candidates = planRoute(env, opts);
  if (candidates.length === 0) throw noCandidatesError(opts.modelId, opts.kind);

  const attempts: GatewayAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    const startedAt = Date.now();

    try {
      const value = await run(toAttempt(candidate, opts.modelId, i));
      attempts.push({ gateway: candidate.gateway, ok: true, durationMs: Date.now() - startedAt });

      await reportUsage(opts, candidate, value, attempts);
      return { value, gateway: candidate.gateway, attempts };
    } catch (err) {
      const kind = classifyGatewayError(err);
      attempts.push({
        gateway: candidate.gateway,
        ok: false,
        error: err,
        kind,
        durationMs: Date.now() - startedAt,
      });
      lastError = err;

      // Loud on purpose: without this, a revoked key or an exhausted allowance
      // is invisible. With a single gateway there is no fallback, so the message
      // must not promise one — say what actually happens next.
      const next = i < candidates.length - 1 ? ' Falling back to the next gateway.' : '';
      if (isAuthFailure(err)) {
        console.error(
          `[@weldsuite/ai] Auth failure (401/403) on "${candidate.gateway}" — its API token is ` +
            `missing, invalid, or lacks the Workers AI + AI Gateway Run scopes, or CF_ACCOUNT_ID ` +
            `is wrong.${next}`,
        );
      } else if (isBillingFailure(err)) {
        console.warn(
          `[@weldsuite/ai] Billing failure (402) on "${candidate.gateway}" — its service credit is ` +
            `likely exhausted ahead of our counter.${next}`,
        );
      }

      if (kind === 'terminal') throw err;
    }
  }

  throw new AllGatewaysFailedError(attempts, lastError);
}

function toAttempt(candidate: GatewayCandidate, modelId: string, index: number): Attempt {
  const ai = createWeldAI(candidate.config);
  return {
    ai,
    model: ai.model(modelId),
    modelId,
    gateway: candidate.gateway,
    attemptIndex: index,
  };
}

/**
 * Record what the successful call cost us.
 *
 * Wrapped in try/catch: the call already succeeded and the customer is about to
 * be charged for it, so bookkeeping must never turn that into a failure. A lost
 * record self-heals in aggregate — the rollup re-derives spend from the rows
 * that did land.
 */
async function reportUsage<T>(
  opts: RunOptions<T>,
  candidate: GatewayCandidate,
  value: T,
  attempts: GatewayAttempt[],
): Promise<void> {
  if (!opts.onUsage) return;
  try {
    const usage = (opts.extractUsage ?? defaultExtractUsage)(value);
    await opts.onUsage({
      gateway: candidate.gateway,
      modelId: opts.modelId,
      nativeModelId: candidate.nativeModelId,
      usage,
      providerCostUsd: providerCostUsd(opts.modelId, usage ?? {}) * candidate.costFactor,
      coveredByServiceCredit: candidate.free,
      op: opts.op,
      attempts,
    });
  } catch (err) {
    console.error('[@weldsuite/ai] recording gateway usage failed (cost untracked):', err);
  }
}

function noCandidatesError(modelId: string, kind: ModelKind = 'language'): Error {
  return new UnsupportedModelError(
    modelId,
    'cloudflare',
    `no configured gateway can serve this ${kind === 'embedding' ? 'embedding ' : ''}model ` +
      `(check AI_GATEWAY_PROVIDER / per-gateway env, and model-map.ts support)`,
  );
}

/**
 * Embedding twin of {@link pickGateway}. Embeddings are cheap, deterministic and
 * Cloudflare-served, so they route but don't fall back — an embedding failure is
 * nearly always terminal.
 */
export function pickEmbedding(
  env: object | undefined,
  opts: { modelId: string; credits?: readonly GatewayCreditState[] },
): { model: EmbeddingModel; gateway: GatewayProvider } {
  const attempt = pickGateway(env, { ...opts, kind: 'embedding' });
  return { model: attempt.ai.embedding(opts.modelId), gateway: attempt.gateway };
}
