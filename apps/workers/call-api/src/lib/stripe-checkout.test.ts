import { describe, expect, it, vi } from 'vitest';
import {
  assertPaidPhoneCheckout,
  PhonePaymentError,
  retrieveCheckoutSession,
  verifyPaidPhoneCheckout,
  type StripeCheckoutSessionLike,
} from './stripe-checkout';

const claim = {
  clerkOrgId: 'org_1',
  phoneNumber: '+31201234567',
  countryCode: 'NL',
  numberType: 'local',
};

function paidSession(overrides: Partial<StripeCheckoutSessionLike> = {}): StripeCheckoutSessionLike {
  return {
    id: 'cs_test_abcdefgh',
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    metadata: {
      type: 'phone_checkout',
      clerkOrgId: 'org_1',
      phone_number: '+31201234567',
      phone_country_code: 'NL',
      phone_number_type: 'local',
    },
    ...overrides,
  };
}

function refusal(fn: () => void): PhonePaymentError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PhonePaymentError);
    return err as PhonePaymentError;
  }
  throw new Error('expected a PhonePaymentError');
}

const asFetch = (fn: unknown) => fn as unknown as typeof fetch;

describe('assertPaidPhoneCheckout', () => {
  it('accepts a paid phone checkout for the same org and number', () => {
    expect(() => assertPaidPhoneCheckout(paidSession(), claim)).not.toThrow();
  });

  it('applies the billing-worker defaults (US / local) when metadata omits them', () => {
    const session = paidSession({
      metadata: { type: 'phone_checkout', clerkOrgId: 'org_1', phone_number: '+12025550100' },
    });
    expect(() =>
      assertPaidPhoneCheckout(session, {
        ...claim,
        phoneNumber: '+12025550100',
        countryCode: 'us',
        numberType: 'local',
      }),
    ).not.toThrow();
  });

  it('refuses an unpaid or incomplete session (402)', () => {
    expect(refusal(() => assertPaidPhoneCheckout(paidSession({ payment_status: 'unpaid' }), claim)).status).toBe(402);
    expect(refusal(() => assertPaidPhoneCheckout(paidSession({ status: 'open' }), claim)).status).toBe(402);
  });

  it('refuses a session for a different org (403)', () => {
    expect(
      refusal(() => assertPaidPhoneCheckout(paidSession(), { ...claim, clerkOrgId: 'org_attacker' })).status,
    ).toBe(403);
  });

  it('refuses a session paid for a different number (403)', () => {
    expect(
      refusal(() => assertPaidPhoneCheckout(paidSession(), { ...claim, phoneNumber: '+31209999999' })).status,
    ).toBe(403);
  });

  it('refuses mismatched country or number type (403)', () => {
    expect(refusal(() => assertPaidPhoneCheckout(paidSession(), { ...claim, countryCode: 'US' })).status).toBe(403);
    expect(refusal(() => assertPaidPhoneCheckout(paidSession(), { ...claim, numberType: 'mobile' })).status).toBe(403);
  });

  it('refuses a checkout that is not a phone purchase (403)', () => {
    const session = paidSession({ metadata: { ...paidSession().metadata, type: 'plan_checkout' } });
    expect(refusal(() => assertPaidPhoneCheckout(session, claim)).status).toBe(403);
    expect(refusal(() => assertPaidPhoneCheckout(paidSession({ object: 'payment_intent' }), claim)).status).toBe(403);
  });
});

describe('retrieveCheckoutSession / verifyPaidPhoneCheckout', () => {
  const env = { STRIPE_SECRET_KEY: 'sk_test_123' };

  it('fails closed (503) when STRIPE_SECRET_KEY is missing, without calling Stripe', async () => {
    const fetchImpl = vi.fn();
    await expect(verifyPaidPhoneCheckout({}, 'cs_test_abcdefgh', claim, asFetch(fetchImpl))).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a malformed reference (400) without calling Stripe', async () => {
    const fetchImpl = vi.fn();
    await expect(retrieveCheckoutSession(env, 'pi_123', asFetch(fetchImpl))).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the session from Stripe with the secret key and verifies it', async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(paidSession()), { status: 200 }));
    await expect(verifyPaidPhoneCheckout(env, 'cs_test_abcdefgh', claim, asFetch(fetchImpl))).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_test_abcdefgh');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('sk_test_123:')}`);
  });

  it('maps an unknown session to 403 and a Stripe outage to 502', async () => {
    const notFound = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(verifyPaidPhoneCheckout(env, 'cs_test_abcdefgh', claim, asFetch(notFound))).rejects.toMatchObject({
      status: 403,
    });
    const down = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(verifyPaidPhoneCheckout(env, 'cs_test_abcdefgh', claim, asFetch(down))).rejects.toMatchObject({
      status: 502,
    });
  });

  it('refuses when Stripe returns a different session id', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(paidSession({ id: 'cs_test_other0000' })), { status: 200 }),
    );
    await expect(verifyPaidPhoneCheckout(env, 'cs_test_abcdefgh', claim, asFetch(fetchImpl))).rejects.toMatchObject({
      status: 403,
    });
  });
});
