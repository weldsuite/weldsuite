/**
 * Retry + backoff for provider calls.
 *
 * Full-jitter exponential backoff, capped, with `Retry-After` taking priority
 * when the server supplied one. Jitter matters here because every tenant's
 * connections are swept by the same cron — a fixed schedule would synchronise
 * the retries of every workspace hitting the same rate-limited provider.
 */

import { ConnectorApiError } from './errors';

export interface RetryOptions {
  /** Attempts after the first one. 0 disables retrying. */
  maxRetries?: number;
  /** First backoff step in ms. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff step in ms. */
  maxDelayMs?: number;
  /** Injectable sleep — tests pass a no-op to keep runs instant. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for the jitter, in [0, 1). */
  random?: () => number;
  /** Called before each backoff so callers can log/observe. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decide whether `error` is worth another attempt. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ConnectorApiError) return error.retryable;
  // Network-level failures (DNS, socket reset, Workers subrequest abort) throw
  // plain TypeErrors from fetch — those are worth retrying.
  return error instanceof TypeError || error instanceof DOMException;
}

/**
 * Backoff for `attempt` (1-based), in ms.
 *
 * `Retry-After` wins when present — the server knows better than our schedule,
 * and ignoring it is how you get a rate limit turned into a ban.
 */
export function backoffDelayMs(
  attempt: number,
  error: unknown,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;

  if (error instanceof ConnectorApiError && error.retryAfterSeconds !== undefined) {
    return Math.min(error.retryAfterSeconds * 1000, max);
  }

  const exponential = Math.min(base * 2 ** (attempt - 1), max);
  // Full jitter — spread retries uniformly across the window.
  return Math.floor(random() * exponential);
}

/** Run `fn`, retrying transient/rate-limited failures with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries || !isRetryable(err)) throw err;
      const delayMs = backoffDelayMs(attempt + 1, err, options);
      options.onRetry?.({ attempt: attempt + 1, delayMs, error: err });
      await sleep(delayMs);
    }
  }
  throw lastError;
}
