import { describe, it, expect, vi } from 'vitest';
import { NangoApiError, classifyStatus, parseRetryAfter } from './errors';
import { backoffDelayMs, isRetryable, withRetry } from './retry';

describe('classifyStatus', () => {
  it('treats 401/403 as auth failures so the tenant is asked to reconnect', () => {
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(403)).toBe('auth');
  });

  it('treats 429 as rate limiting and 5xx as transient', () => {
    expect(classifyStatus(429)).toBe('rate_limit');
    expect(classifyStatus(500)).toBe('transient');
    expect(classifyStatus(503)).toBe('transient');
  });

  it('treats other 4xx as permanent', () => {
    expect(classifyStatus(400)).toBe('permanent');
    expect(classifyStatus(404)).toBe('permanent');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('30', now)).toBe(30);
  });

  it('parses an HTTP-date into seconds from now', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:45 GMT', now)).toBe(45);
  });

  it('clamps a past date to zero', () => {
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for missing or unparseable values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('retries rate limits and transient errors', () => {
    expect(isRetryable(new NangoApiError({ message: 'x', status: 429, kind: 'rate_limit' }))).toBe(true);
    expect(isRetryable(new NangoApiError({ message: 'x', status: 502, kind: 'transient' }))).toBe(true);
  });

  it('does not retry auth or permanent errors', () => {
    expect(isRetryable(new NangoApiError({ message: 'x', status: 401, kind: 'auth' }))).toBe(false);
    expect(isRetryable(new NangoApiError({ message: 'x', status: 400, kind: 'permanent' }))).toBe(false);
  });

  it('retries network-level fetch failures', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('backoffDelayMs', () => {
  it('honours Retry-After over the exponential schedule', () => {
    const err = new NangoApiError({ message: 'x', status: 429, kind: 'rate_limit', retryAfterSeconds: 5 });
    expect(backoffDelayMs(1, err, { random: () => 0.9 })).toBe(5000);
  });

  it('caps Retry-After at maxDelayMs', () => {
    const err = new NangoApiError({ message: 'x', status: 429, kind: 'rate_limit', retryAfterSeconds: 600 });
    expect(backoffDelayMs(1, err, { maxDelayMs: 30_000 })).toBe(30_000);
  });

  it('grows exponentially and applies full jitter', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, random: () => 1 };
    const err = new NangoApiError({ message: 'x', status: 500, kind: 'transient' });
    expect(backoffDelayMs(1, err, opts)).toBe(100);
    expect(backoffDelayMs(2, err, opts)).toBe(200);
    expect(backoffDelayMs(3, err, opts)).toBe(400);
    // Jitter spreads retries across the window rather than pinning the ceiling.
    expect(backoffDelayMs(3, err, { ...opts, random: () => 0 })).toBe(0);
  });
});

describe('withRetry', () => {
  const sleep = () => Promise.resolve();

  it('returns the first successful result without sleeping', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures up to maxRetries then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NangoApiError({ message: 'x', status: 503, kind: 'transient' }))
      .mockRejectedValueOnce(new NangoApiError({ message: 'x', status: 503, kind: 'transient' }))
      .mockResolvedValue('ok');

    await expect(withRetry(fn, { sleep, maxRetries: 3 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const err = new NangoApiError({ message: 'boom', status: 500, kind: 'transient' });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { sleep, maxRetries: 2 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry auth failures — reconnecting is the only fix', async () => {
    const err = new NangoApiError({ message: 'expired', status: 401, kind: 'auth' });
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { sleep, maxRetries: 5 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports each retry to onRetry', async () => {
    const onRetry = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new NangoApiError({ message: 'x', status: 429, kind: 'rate_limit', retryAfterSeconds: 1 }))
      .mockResolvedValue('ok');

    await withRetry(fn, { sleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, delayMs: 1000 });
  });
});
