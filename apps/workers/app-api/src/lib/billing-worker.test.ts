import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import {
  BILLING_WORKER_PRODUCTION_URL,
  BILLING_WORKER_TIMEOUT_MS,
  billingWorkerUrl,
  callBillingWorker,
  fetchBillingWorker,
} from './billing-worker';

describe('billingWorkerUrl', () => {
  it('points production at the billing-worker custom domain', () => {
    expect(billingWorkerUrl({ ENVIRONMENT: 'production' })).toBe(BILLING_WORKER_PRODUCTION_URL);
  });

  it('points preview at the same live billing-worker host', () => {
    expect(billingWorkerUrl({ ENVIRONMENT: 'preview' })).toBe(BILLING_WORKER_PRODUCTION_URL);
  });

  it('uses localhost for development', () => {
    expect(billingWorkerUrl({ ENVIRONMENT: 'development' })).toBe('http://localhost:8788');
  });
});

describe('fetchBillingWorker', () => {
  it('forwards Authorization and JSON body with an AbortSignal', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    await fetchBillingWorker(
      { ENVIRONMENT: 'development' },
      '/api/billing/credits/checkout',
      {
        method: 'POST',
        authorization: 'Bearer tok',
        body: { packageId: 'pkg_1' },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:8788/api/billing/credits/checkout',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok',
        },
        body: JSON.stringify({ packageId: 'pkg_1' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('aborts when the upstream exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return;
            if (signal.aborted) {
              reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
              return;
            }
            signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      );

      const pending = fetchBillingWorker(
        { ENVIRONMENT: 'development' },
        '/api/billing/phone/subscription',
        {
          timeoutMs: 50,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      );
      // Attach rejection handler before advancing timers so Vitest never sees
      // an unhandled rejection while the abort fires.
      const expectation = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(50);
      await expectation;
      expect(BILLING_WORKER_TIMEOUT_MS).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('callBillingWorker', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function fakeContext(auth?: string) {
    return {
      env: { ENVIRONMENT: 'development' } as Env,
      req: {
        header: (name: string) => (name === 'Authorization' ? auth : undefined),
      },
    } as never;
  }

  it('defaults to GET when no body is provided', async () => {
    await callBillingWorker(fakeContext(), '/api/billing/phone/subscription');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:8788/api/billing/phone/subscription',
      expect.objectContaining({
        method: 'GET',
        body: undefined,
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
