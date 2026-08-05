/**
 * Offline tests for billing-worker proxy routes:
 *   GET  /api/billing/phone-subscription
 *   POST /api/credits/checkout
 *
 * Uses the createTestApp harness (stub auth + permissions) and stubs
 * global fetch for the upstream billing-worker. These proxies do not touch
 * Postgres — no PGlite needed — but exercise the full route → service →
 * fetch → `{ data }` envelope path offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  creditTopupCheckoutSchema,
  isAllowedPlatformCheckoutUrl,
} from '@weldsuite/app-api-client/schemas/credits';
import { createTestApp, permissions } from '../test/harness';
import { billingRoutes } from './billing';
import { creditsRoutes } from './credits';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockUpstream(status: number, body: unknown) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('creditTopupCheckoutSchema', () => {
  it('accepts packageId alone and allowlisted callback URLs', () => {
    expect(creditTopupCheckoutSchema.parse({ packageId: 'pkg_1' })).toEqual({
      packageId: 'pkg_1',
    });
    expect(
      isAllowedPlatformCheckoutUrl('https://app.weldsuite.org/settings/billing'),
    ).toBe(true);
  });

  it('rejects foreign callback origins', () => {
    expect(isAllowedPlatformCheckoutUrl('https://evil.example/x')).toBe(false);
    expect(
      creditTopupCheckoutSchema.safeParse({
        packageId: 'pkg_1',
        successUrl: 'https://attacker.test/callback',
      }).success,
    ).toBe(false);
  });
});

describe('GET /api/billing/phone-subscription', () => {
  it('returns { data } from billing-worker on success', async () => {
    mockUpstream(200, { exists: true, totalMonthly: 1500 });
    const { request } = createTestApp('/api/billing', billingRoutes, {
      context: { permissions: permissions('billing:read') },
    });

    const res = await request('/api/billing/phone-subscription', {
      headers: { Authorization: 'Bearer test' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { exists: boolean; totalMonthly: number } };
    expect(body.data).toEqual({ exists: true, totalMonthly: 1500 });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://localhost:8788/api/billing/phone/subscription',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer test' }),
      }),
    );
  });

  it('denies callers without billing:read', async () => {
    const { request } = createTestApp('/api/billing', billingRoutes, {
      context: { permissions: permissions('companies:read') },
    });

    const res = await request('/api/billing/phone-subscription');
    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps upstream 400 to BAD_REQUEST', async () => {
    mockUpstream(400, { error: 'No organization selected' });
    const { request } = createTestApp('/api/billing', billingRoutes, {
      context: { permissions: permissions('billing:read') },
    });

    const res = await request('/api/billing/phone-subscription', {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('maps upstream 5xx to INTERNAL_ERROR (not exists:false)', async () => {
    mockUpstream(503, { error: 'Stripe down' });
    const { request } = createTestApp('/api/billing', billingRoutes, {
      context: { permissions: permissions('billing:read') },
    });

    const res = await request('/api/billing/phone-subscription', {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string }; data?: unknown };
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.data).toBeUndefined();
  });

  it('maps fetch exceptions to INTERNAL_ERROR', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    const { request } = createTestApp('/api/billing', billingRoutes, {
      context: { permissions: permissions('billing:read') },
    });

    const res = await request('/api/billing/phone-subscription', {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/credits/checkout', () => {
  it('returns { data: { url } } from billing-worker on success', async () => {
    mockUpstream(200, { url: 'https://checkout.stripe.com/c/pay_test' });
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:manage') },
    });

    const res = await request('/api/credits/checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        packageId: 'pkg_1',
        successUrl: 'https://app.weldsuite.org/settings/billing?credits=success',
        cancelUrl: 'https://app.weldsuite.org/settings/billing?credits=cancelled',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { url: string } };
    expect(body.data.url).toBe('https://checkout.stripe.com/c/pay_test');
  });

  it('denies callers without billing:manage', async () => {
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:read') },
    });

    const res = await request('/api/credits/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId: 'pkg_1' }),
    });
    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects missing packageId', async () => {
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:manage') },
    });

    const res = await request('/api/credits/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects successUrl on a non-allowlisted origin', async () => {
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:manage') },
    });

    const res = await request('/api/credits/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packageId: 'pkg_1',
        successUrl: 'https://evil.example/phish',
      }),
    });
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps upstream 404 to NOT_FOUND', async () => {
    mockUpstream(404, { error: 'Credit package not found' });
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:manage') },
    });

    const res = await request('/api/credits/checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ packageId: 'pkg_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('maps upstream 5xx to INTERNAL_ERROR', async () => {
    mockUpstream(500, { error: 'boom' });
    const { request } = createTestApp('/api/credits', creditsRoutes, {
      context: { permissions: permissions('billing:manage') },
    });

    const res = await request('/api/credits/checkout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ packageId: 'pkg_1' }),
    });
    expect(res.status).toBe(500);
  });
});
