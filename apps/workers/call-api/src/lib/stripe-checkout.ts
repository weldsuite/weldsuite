/**
 * Independent verification of a phone-number Stripe Checkout Session.
 *
 * `/api/internal/telephony/fulfill-number` buys a (billed) Telnyx number, so
 * it must not trust its caller's say-so that a payment happened. The caller
 * (billing-worker's checkout.session.completed handler) passes the Checkout
 * Session id; this module re-reads that session from Stripe and checks that it
 * is a paid phone checkout for exactly the org and number being fulfilled.
 */

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
}

/** The slice of a Stripe Checkout Session this check reads. */
export interface StripeCheckoutSessionLike {
  id?: string;
  object?: string;
  status?: string | null;
  payment_status?: string | null;
  metadata?: Record<string, string> | null;
}

export interface PhoneCheckoutClaim {
  clerkOrgId: string;
  phoneNumber: string;
  countryCode: string;
  numberType: string;
}

/** Thrown when the payment cannot be verified; carries the HTTP status to answer with. */
export class PhonePaymentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 403 | 502 | 503,
  ) {
    super(message);
    this.name = 'PhonePaymentError';
  }
}

export function isCheckoutSessionId(value: string): boolean {
  return /^cs_\w{8,}$/.test(value);
}

export async function retrieveCheckoutSession(
  env: StripeEnv,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StripeCheckoutSessionLike> {
  if (!env.STRIPE_SECRET_KEY) {
    console.error('[PhoneOrder] STRIPE_SECRET_KEY is not configured; cannot verify payment');
    throw new PhonePaymentError('Payment verification is not configured', 503);
  }
  if (!isCheckoutSessionId(sessionId)) {
    throw new PhonePaymentError('Invalid checkout session reference', 400);
  }

  const resp = await fetchImpl(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Basic ${btoa(env.STRIPE_SECRET_KEY + ':')}` } },
  );

  if (resp.status === 404) {
    throw new PhonePaymentError('Checkout session not found', 403);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`[PhoneOrder] Stripe session lookup failed (${resp.status}): ${text.slice(0, 200)}`);
    throw new PhonePaymentError('Could not verify payment with Stripe', 502);
  }
  return (await resp.json()) as StripeCheckoutSessionLike;
}

/**
 * Pure check: the session is a completed, paid phone checkout whose metadata
 * (written by billing-worker at checkout start) names this org and number.
 * Defaults mirror billing-worker's `handlePhoneCheckoutCompleted`.
 */
export function assertPaidPhoneCheckout(
  session: StripeCheckoutSessionLike,
  claim: PhoneCheckoutClaim,
): void {
  if (session.object !== 'checkout.session') {
    throw new PhonePaymentError('Reference is not a checkout session', 403);
  }
  const metadata = session.metadata ?? {};
  if (metadata.type !== 'phone_checkout') {
    throw new PhonePaymentError('Checkout session is not a phone-number purchase', 403);
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    throw new PhonePaymentError('Checkout session has not been paid', 402);
  }
  if (!metadata.clerkOrgId || metadata.clerkOrgId !== claim.clerkOrgId) {
    throw new PhonePaymentError('Checkout session belongs to a different organization', 403);
  }
  if (!metadata.phone_number || metadata.phone_number.trim() !== claim.phoneNumber.trim()) {
    throw new PhonePaymentError('Checkout session was paid for a different phone number', 403);
  }
  const paidCountry = (metadata.phone_country_code || 'US').toUpperCase();
  const paidType = metadata.phone_number_type || 'local';
  if (paidCountry !== claim.countryCode.toUpperCase() || paidType !== claim.numberType) {
    throw new PhonePaymentError('Checkout session does not match the requested number details', 403);
  }
}

export async function verifyPaidPhoneCheckout(
  env: StripeEnv,
  sessionId: string,
  claim: PhoneCheckoutClaim,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const session = await retrieveCheckoutSession(env, sessionId, fetchImpl);
  if (session.id !== sessionId) {
    throw new PhonePaymentError('Checkout session mismatch', 403);
  }
  assertPaidPhoneCheckout(session, claim);
}
