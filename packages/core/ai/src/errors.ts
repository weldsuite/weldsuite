/**
 * Gateway failure classification — decides whether a failed call is worth
 * retrying on a DIFFERENT gateway, or is doomed everywhere.
 *
 * Getting this wrong is expensive in both directions: retry a doomed call and
 * you pay three gateways to reject the same malformed prompt; terminate a
 * transient one and you take an outage while a healthy gateway sits idle.
 *
 * ## Two things that look like bugs but aren't
 *
 * **402 (billing/credit exhausted) is `retry-elsewhere`.** This is the single
 * most important line in this file. Ops service-credit balances burn down from a
 * counter that lags reality by up to ~2 minutes, so the *first* signal that a
 * gateway's credit is truly gone is that gateway returning a hard billing error.
 * Classified as terminal, that means **every AI call in the product fails** the
 * moment a free allowance runs out — while a perfectly healthy Cloudflare sits
 * unused. 402 must move to the next gateway. Do not "fix" this.
 *
 * **401/403 is `retry-elsewhere`, not terminal.** Each gateway holds an
 * independent credential (see `config.ts`), so an auth failure is scoped to the
 * gateway that raised it and must not, on its own, be treated as unrecoverable.
 * The risk — masking a real misconfiguration forever — is handled by logging
 * loudly on every auth fallback, not by failing the call. (With a single gateway
 * no fallback occurs; the classification is kept for when a second is added.)
 *
 * ## Why `isInstance` and never `instanceof`
 *
 * The dependency tree holds TWO copies of `@ai-sdk/provider` (a hoisted one, and
 * the one nested under `ai`). An error thrown by a provider built against one
 * copy is `instanceof`-incompatible with the other, so identity checks would
 * silently misclassify — the worst possible failure here. The SDK's own
 * `isInstance` helpers compare `Symbol.for(...)` markers via the GLOBAL symbol
 * registry, which is copy-agnostic. Always use those.
 */

import { APICallError, RetryError } from 'ai';

import { GatewayConfigError, UnsupportedModelError } from './adapters/types.js';

export type FailureKind =
  /** Transient or gateway-local — a different gateway may well succeed. */
  | 'retry-elsewhere'
  /** Deterministic — would fail identically everywhere. Stop, don't spend more. */
  | 'terminal';

/**
 * Peel a `RetryError` down to the error that actually happened.
 *
 * The AI SDK wraps the real failure after exhausting its own in-gateway retries,
 * so classifying the wrapper (which is not an `APICallError` and carries no
 * status code) would send everything down the `terminal` path.
 */
export function unwrapGatewayError(err: unknown): unknown {
  let current = err;
  // Bounded: RetryError nesting is shallow, but never trust a cycle.
  for (let i = 0; i < 5; i++) {
    if (RetryError.isInstance(current) && current.lastError !== undefined) {
      current = current.lastError;
      continue;
    }
    return current;
  }
  return current;
}

/** HTTP statuses where another gateway is worth a try. */
function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  // 5xx: gateway-side fault.        429: per-gateway rate limit.
  // 402: this gateway's billing/credit — the others' wallets are separate.
  // 404: model not in THIS catalog (drift); another gateway may serve it.
  // 401/403: this gateway's credential only — see the header.
  if (status >= 500) return true;
  return status === 429 || status === 402 || status === 404 || status === 401 || status === 403;
}

/**
 * Classify a failure from one gateway attempt.
 *
 * Unrecognised errors are **terminal** on purpose: fail closed. An unknown bug
 * (a TypeError in our own callback, say) would fail identically on every
 * gateway, so retrying just triples the latency and the bill.
 */
export function classifyGatewayError(err: unknown): FailureKind {
  const error = unwrapGatewayError(err);

  // Our own pre-flight errors. Candidates are filtered before the chain runs, so
  // these shouldn't surface here — but if they do, no gateway can help.
  if (error instanceof UnsupportedModelError) return 'terminal';
  if (error instanceof GatewayConfigError) return 'terminal';

  if (APICallError.isInstance(error)) {
    if (isRetryableStatus(error.statusCode)) return 'retry-elsewhere';
    // A 4xx we don't recognise (400 malformed prompt/schema, 422, …) fails the
    // same way everywhere.
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return 'terminal';
    }
    // No status at all = network/DNS/TLS/abort — never reached the gateway.
    // Defer to the SDK's own judgement rather than guessing.
    return error.isRetryable ? 'retry-elsewhere' : 'terminal';
  }

  return 'terminal';
}

/** True when the failure was this gateway's credentials, not our request. */
export function isAuthFailure(err: unknown): boolean {
  const error = unwrapGatewayError(err);
  if (!APICallError.isInstance(error)) return false;
  return error.statusCode === 401 || error.statusCode === 403;
}

/** True when the gateway rejected the call for billing reasons (see header). */
export function isBillingFailure(err: unknown): boolean {
  const error = unwrapGatewayError(err);
  if (!APICallError.isInstance(error)) return false;
  return error.statusCode === 402;
}

/** One gateway's attempt at a call — success or failure. */
export interface GatewayAttempt {
  gateway: string;
  ok: boolean;
  /** Present when `ok` is false. */
  error?: unknown;
  kind?: FailureKind;
  durationMs: number;
}

/**
 * Every candidate gateway failed.
 *
 * `cause` is the LAST error so existing call-site handling (which reads
 * `err.message` / status) still reads sensibly rather than seeing a wrapper.
 */
export class AllGatewaysFailedError extends Error {
  constructor(
    readonly attempts: GatewayAttempt[],
    override readonly cause: unknown,
  ) {
    const tried = attempts.map((a) => a.gateway).join(', ') || 'none';
    const last = cause instanceof Error ? cause.message : String(cause);
    super(`[@weldsuite/ai] All AI gateways failed (tried: ${tried}). Last error: ${last}`);
    this.name = 'AllGatewaysFailedError';
  }
}
