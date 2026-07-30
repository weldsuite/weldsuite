import { describe, expect, it, vi } from 'vitest';
import { ConnectorApiError } from './errors';
import { backoffDelayMs, isRetryable, withRetry } from './retry';

function apiError(status: number, retryAfterSeconds?: number): ConnectorApiError {
  return new ConnectorApiError({
    message: `failed with ${status}`,
    status,
    kind:
      status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'transient'
          : status === 401 || status === 403
            ? 'auth'
            : 'permanent',
    retryAfterSeconds,
  });
}

describe('isRetryable', () => {
  it('retries rate limits and 5xx', () => {
    expect(isRetryable(apiError(429))).toBe(true);
    expect(isRetryable(apiError(503))).toBe(true);
  });

  it('does not retry auth or client errors', () => {
    // Retrying a rejected credential just multiplies the failure; retrying a 400
    // cannot change the request.
    expect(isRetryable(apiError(401))).toBe(false);
    expect(isRetryable(apiError(400))).toBe(false);
  });

  it('retries network-level fetch failures', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('backoffDelayMs', () => {
  it('prefers Retry-After over the exponential schedule', () => {
    // Ignoring the server's own instruction is how a rate limit becomes a ban.
    expect(backoffDelayMs(1, apiError(429, 12), { random: () => 0.99 })).toBe(12_000);
  });

  it('caps Retry-After at maxDelayMs', () => {
    expect(backoffDelayMs(1, apiError(429, 9999), { maxDelayMs: 5_000 })).toBe(5_000);
  });

  it('doubles the jitter window each attempt', () => {
    // Full jitter spreads retries uniformly across a growing window, so the
    // guarantee is the window's size, not any single delay. Asserting exact
    // values here would only be testing the multiplication.
    const ceiling = (attempt: number) =>
      backoffDelayMs(attempt, apiError(503), { baseDelayMs: 100, random: () => 1 });

    expect(ceiling(1)).toBe(100);
    expect(ceiling(2)).toBe(200);
    expect(ceiling(3)).toBe(400);
  });

  it('keeps every jittered delay inside its window', () => {
    for (const random of [0, 0.25, 0.5, 0.99]) {
      const delay = backoffDelayMs(3, apiError(503), { baseDelayMs: 100, random: () => random });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(400);
    }
    // The bottom of the window must be reachable — a floor of zero is what
    // actually de-synchronises tenants retrying against the same provider.
    expect(backoffDelayMs(3, apiError(503), { baseDelayMs: 100, random: () => 0 })).toBe(0);
  });

  it('respects maxDelayMs on the exponential path', () => {
    expect(
      backoffDelayMs(20, apiError(503), { baseDelayMs: 100, maxDelayMs: 1_000, random: () => 1 }),
    ).toBe(1_000);
  });
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn();
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn, { sleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw apiError(503);
      return 'ok';
    });

    expect(await withRetry(fn, { sleep: async () => undefined, random: () => 0 })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw apiError(503);
    });

    await expect(
      withRetry(fn, { maxRetries: 2, sleep: async () => undefined, random: () => 0 }),
    ).rejects.toMatchObject({ status: 503 });
    // The initial attempt plus two retries.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable failure', async () => {
    const fn = vi.fn(async () => {
      throw apiError(401);
    });

    await expect(withRetry(fn, { sleep: async () => undefined })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry to onRetry', async () => {
    const onRetry = vi.fn();
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 2) throw apiError(503);
      return 'ok';
    };

    await withRetry(fn, { sleep: async () => undefined, random: () => 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });

  it('maxRetries: 0 disables retrying', async () => {
    const fn = vi.fn(async () => {
      throw apiError(503);
    });
    await expect(withRetry(fn, { maxRetries: 0, sleep: async () => undefined })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
