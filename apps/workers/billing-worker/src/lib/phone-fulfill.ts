/**
 * Call call-api after Stripe has taken payment for a phone number.
 * Mirrors WeldHost domain registration: pay first, then register.
 * Goes over the `CALL_INTERNAL` entrypoint binding; the public HTTP path through
 * app-api (bearer INTERNAL_API_SECRET) is the fallback.
 */

import type { Env } from '../index';

export function appApiUrl(env: Pick<Env, 'ENVIRONMENT' | 'APP_API_URL'>): string {
  if (env.APP_API_URL) return env.APP_API_URL.replace(/\/+$/, '');
  if (env.ENVIRONMENT === 'test') return 'https://app-api-test.weldsuite.org';
  if (env.ENVIRONMENT === 'development') return 'http://localhost:8789';
  return 'https://app-api.weldsuite.org';
}

export async function fulfillPaidPhoneNumberFromBilling(
  env: Env,
  input: {
    clerkOrgId: string;
    phoneNumber: string;
    countryCode: string;
    numberType: string;
    addressId?: string;
    displayName?: string;
    friendlyName?: string;
  },
): Promise<void> {
  const body = JSON.stringify(input);
  let resp: Response | undefined;

  // Preferred: call-api's CallInternal entrypoint over the CALL_INTERNAL binding.
  // Reachable only through a service binding, so no secret is sent. Only a
  // missing entrypoint (not deployed yet) falls back, so an order is never
  // placed twice.
  if (env.CALL_INTERNAL) {
    try {
      resp = await env.CALL_INTERNAL.fetch('https://internal/api/internal/telephony/fulfill-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      if (!(err instanceof Error && /entrypoint/i.test(err.message))) throw err;
      console.warn('[PhoneFulfill] CALL_INTERNAL entrypoint unavailable, falling back to HTTP:', err);
    }
  }

  // Fallback while the binding is absent: public HTTP through app-api's
  // forwarder with the shared INTERNAL_API_SECRET bearer.
  if (!resp) {
    const secret = env.INTERNAL_API_SECRET?.trim();
    if (!secret) {
      throw new Error('INTERNAL_API_SECRET is not configured; cannot order the Telnyx number after payment');
    }

    resp = await fetch(`${appApiUrl(env)}/api/internal/telephony/fulfill-number`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Phone fulfill failed (${resp.status}): ${text.slice(0, 400)}`);
  }
}
