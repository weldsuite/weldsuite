/**
 * Call app-api after Stripe has taken payment for a phone number.
 * Mirrors WeldHost domain registration: pay first, then register.
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
  const secret = env.INTERNAL_API_SECRET?.trim();
  if (!secret) {
    throw new Error('INTERNAL_API_SECRET is not configured; cannot order the Telnyx number after payment');
  }

  const resp = await fetch(`${appApiUrl(env)}/api/internal/telephony/fulfill-number`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Phone fulfill failed (${resp.status}): ${text.slice(0, 400)}`);
  }
}
