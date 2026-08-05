import { describe, expect, it } from 'vitest';
import {
  BILLING_WORKER_PRODUCTION_URL,
  resolveBillingWorkerUrl,
} from './billing-worker-client';

describe('resolveBillingWorkerUrl', () => {
  it('prefers an explicit VITE_BILLING_WORKER_URL override', () => {
    expect(
      resolveBillingWorkerUrl({
        VITE_BILLING_WORKER_URL: 'http://localhost:9999',
        PROD: true,
      }),
    ).toBe('http://localhost:9999');
  });

  it('uses the production custom domain for PROD builds without an override', () => {
    expect(resolveBillingWorkerUrl({ PROD: true })).toBe(BILLING_WORKER_PRODUCTION_URL);
    expect(BILLING_WORKER_PRODUCTION_URL).toBe('https://billing-worker.weldsuite.org');
  });

  it('falls back to local wrangler for non-PROD builds', () => {
    expect(resolveBillingWorkerUrl({ PROD: false })).toBe('http://localhost:8788');
    expect(resolveBillingWorkerUrl({})).toBe('http://localhost:8788');
  });
});
