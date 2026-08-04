import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../types';
import {
  BILLING_WORKER_PRODUCTION_URL,
  billingWorkerUrl,
  callBillingWorker,
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

  it('forwards Authorization and JSON body to the billing-worker path', async () => {
    await callBillingWorker(fakeContext('Bearer tok'), '/api/billing/credits/checkout', {
      method: 'POST',
      body: { packageId: 'pkg_1' },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:8788/api/billing/credits/checkout',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok',
        },
        body: JSON.stringify({ packageId: 'pkg_1' }),
      }),
    );
  });

  it('defaults to GET when no body is provided', async () => {
    await callBillingWorker(fakeContext(), '/api/billing/phone/subscription');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:8788/api/billing/phone/subscription',
      expect.objectContaining({
        method: 'GET',
        body: undefined,
      }),
    );
  });
});
