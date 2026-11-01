/**
 * POST /api/internal/telephony/fulfill-number on its public mount: the
 * INTERNAL_API_SECRET bearer, the body, and the refusal when Stripe is not
 * configured (nothing is bought). The Stripe path itself is unit-tested in
 * ../../lib/stripe-checkout.test.ts and ../../services/phone-number-order.test.ts;
 * billing (Stripe) is Global-only, so the Rust backend always answers as
 * the worker does without STRIPE_SECRET_KEY.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { internalTelephonyRoutes } from './index';

const BASE = '/api/internal/telephony';
const VALID = {
  checkoutSessionId: 'cs_test_abcdefgh',
  clerkOrgId: 'org_buyer',
  phoneNumber: '+31201234567',
  countryCode: 'NL',
  numberType: 'local',
};

let db: Database;

beforeAll(async () => {
  // Nothing is read: the harness serves Rust a database all the same.
  db = (await createPgliteDb()).db;
}, 180_000);

function fulfill(body: unknown, authorization: string | null, env: Record<string, unknown> = { INTERNAL_API_SECRET: 'internal-secret' }) {
  const { request } = createTestApp(BASE, internalTelephonyRoutes, { context: { tenantDb: db }, env: env as never });
  return request(`${BASE}/fulfill-number`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorization === null ? {} : { Authorization: authorization }) },
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/telephony/fulfill-number', () => {
  it('needs the internal secret', async () => {
    const off = await fulfill(VALID, 'Bearer internal-secret', {});
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: 'Internal auth not configured' });
    const missing = await fulfill(VALID, null);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Missing or invalid Authorization header' });
    const wrong = await fulfill(VALID, 'Bearer nope');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'Unauthorized' });
  });

  it('validates the body', async () => {
    expect((await fulfill({ ...VALID, checkoutSessionId: 'cs_short' }, 'Bearer internal-secret')).status).toBe(400);
    expect((await fulfill({ ...VALID, countryCode: 'N', numberType: '' }, 'Bearer internal-secret')).status).toBe(400);
    expect((await fulfill({}, 'Bearer internal-secret')).status).toBe(400);
  });

  it('refuses to buy without Stripe to verify the payment', async () => {
    const res = await fulfill({ ...VALID, displayName: 'Main' }, 'Bearer internal-secret');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ success: false, error: 'Payment verification is not configured' });
  });
});
