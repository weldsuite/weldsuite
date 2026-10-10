import { describe, expect, it } from 'vitest';
import { adminRoutes, stripeFailure } from './admin';
import { parseAdminActor, secretsMatch } from '../middleware/admin-auth';
import { isCompActive } from '../services/subscription-policy';
import { nextCreditPeriod } from '../services/comp-sweep';
import { toCents } from '../services/admin-plans';
import { subscriptionCoupon, subscriptionPeriod, type AdminStripeSubscription } from '../lib/stripe-admin';
import type { Env } from '../index';

const SECRET = 'a'.repeat(40);

function env(overrides: Partial<Env> = {}): Env {
  return {
    BILLING_ADMIN_SECRET: SECRET,
    // Never queried by these tests: postgres-js connects lazily.
    DATABASE_URL_MASTER: 'postgres://user:pass@127.0.0.1:1/unused',
    ...overrides,
  } as Env;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'x-admin-secret': SECRET,
    'x-admin-email': 'ops@weldsuite.org',
    'content-type': 'application/json',
    ...extra,
  };
}

describe('admin API auth', () => {
  it('answers 503 when the shared secret is missing or too short', async () => {
    const missing = await adminRoutes.request('/workspaces/ws_1/stripe', { headers: headers() }, env({ BILLING_ADMIN_SECRET: undefined }));
    expect(missing.status).toBe(503);
    const short = await adminRoutes.request('/workspaces/ws_1/stripe', { headers: headers() }, env({ BILLING_ADMIN_SECRET: 'short' }));
    expect(short.status).toBe(503);
  });

  it('rejects a wrong secret', async () => {
    const res = await adminRoutes.request(
      '/workspaces/ws_1/stripe',
      { headers: headers({ 'x-admin-secret': 'b'.repeat(40) }) },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it('requires the acting admin email', async () => {
    const res = await adminRoutes.request(
      '/workspaces/ws_1/stripe',
      { headers: headers({ 'x-admin-email': 'not-an-email' }) },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it('refuses a write without a usable request id before touching anything', async () => {
    const res = await adminRoutes.request(
      '/workspaces/ws_1/credits',
      { method: 'POST', headers: headers({ 'x-request-id': 'short' }), body: JSON.stringify({ amount: 10, reason: 'goodwill' }) },
      env(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('x-request-id');
  });
});

describe('secretsMatch', () => {
  it('matches equal secrets only', async () => {
    expect(await secretsMatch(SECRET, SECRET)).toBe(true);
    expect(await secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(await secretsMatch('', SECRET)).toBe(false);
  });
});

describe('parseAdminActor', () => {
  it('normalises the email and keeps the user id', () => {
    expect(parseAdminActor('  Ops@WeldSuite.org ', 'user_1')).toEqual({ email: 'ops@weldsuite.org', userId: 'user_1' });
    expect(parseAdminActor('ops@weldsuite.org', undefined)).toEqual({ email: 'ops@weldsuite.org', userId: null });
  });

  it('rejects missing or malformed emails', () => {
    expect(parseAdminActor(undefined, 'user_1')).toBeNull();
    expect(parseAdminActor('ops', 'user_1')).toBeNull();
  });
});

describe('isCompActive', () => {
  const now = new Date('2026-10-09T12:00:00Z');

  it('is false without a grant', () => {
    expect(isCompActive({ compGrantedAt: null, compEndsAt: null }, now)).toBe(false);
  });

  it('runs until an admin ends it when there is no end date', () => {
    expect(isCompActive({ compGrantedAt: new Date('2026-01-01'), compEndsAt: null }, now)).toBe(true);
  });

  it('stops at the end date', () => {
    const granted = new Date('2026-01-01');
    expect(isCompActive({ compGrantedAt: granted, compEndsAt: new Date('2026-10-10') }, now)).toBe(true);
    expect(isCompActive({ compGrantedAt: granted, compEndsAt: new Date('2026-10-09T12:00:00Z') }, now)).toBe(false);
  });
});

describe('stripeFailure', () => {
  it("surfaces Stripe's own message for client errors", () => {
    const err = new Error(
      'Stripe API POST /v1/refunds failed (400): {"error":{"message":"Charge ch_1 has already been refunded."}}',
    );
    expect(stripeFailure(err)).toEqual({ status: 400, message: 'Stripe: Charge ch_1 has already been refunded.' });
  });

  it('maps Stripe outages to 502', () => {
    expect(stripeFailure(new Error('Stripe API GET /v1/subscriptions/sub_1 failed (500): oops'))?.status).toBe(502);
  });

  it('ignores errors that did not come from Stripe', () => {
    expect(stripeFailure(new Error('boom'))).toBeNull();
  });
});

describe('toCents', () => {
  it('rounds to the cent so float noise never creates a new price', () => {
    expect(toCents('12.50')).toBe(1250);
    expect(toCents('19.99')).toBe(1999);
    expect(toCents('0')).toBe(0);
    expect(toCents('1.005')).toBe(101);
  });
});

describe('nextCreditPeriod', () => {
  it('continues from the previous period end', () => {
    const { start, end } = nextCreditPeriod(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
    expect(start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('restarts from now instead of granting missed months', () => {
    const now = new Date('2026-10-09T00:00:00Z');
    const { start, end } = nextCreditPeriod(new Date('2026-06-01T00:00:00Z'), now);
    expect(start).toBe(now);
    expect(end.toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('Stripe subscription shapes', () => {
  const base: AdminStripeSubscription = {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: 'si_1',
          quantity: 3,
          current_period_start: 100,
          current_period_end: 200,
          price: { id: 'price_1', product: 'prod_1', unit_amount: 1000, currency: 'eur', active: true, recurring: { interval: 'month' } },
        },
      ],
    },
    metadata: null,
  };
  const coupon = {
    id: 'co_1',
    name: '20% off',
    percent_off: 20,
    amount_off: null,
    currency: null,
    duration: 'repeating' as const,
    duration_in_months: 3,
  };

  it('reads period dates from the item on newer API versions', () => {
    expect(subscriptionPeriod(base)).toEqual({ start: 100, end: 200 });
    expect(subscriptionPeriod({ ...base, current_period_start: 1, current_period_end: 2 })).toEqual({ start: 1, end: 2 });
  });

  it('finds the coupon on the legacy discount and on discount.source', () => {
    expect(subscriptionCoupon({ ...base, discount: { coupon, end: 300 } })).toEqual({ coupon, end: 300 });
    expect(subscriptionCoupon({ ...base, discounts: [{ id: 'di_1', source: { coupon }, end: null }] })).toEqual({
      coupon,
      end: null,
    });
    expect(subscriptionCoupon({ ...base, discounts: ['di_1'] })).toBeNull();
    expect(subscriptionCoupon(base)).toBeNull();
  });
});
