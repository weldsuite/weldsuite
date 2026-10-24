import { describe, it, expect } from 'vitest';
import { StripeClient } from '@weldsuite/connectors';
import {
  createConnectorClient,
  credentialPatchError,
  stripeStoredCredentials,
  withRuntimeCredentials,
} from './clients';

const env = { STRIPE_SECRET_KEY: 'sk_platform' };
const oauthRow = { provider: 'stripe', externalAccountId: 'acct_own', settings: { importStartDate: '2026-01-01' } };

describe('withRuntimeCredentials (Stripe)', () => {
  it('pairs the platform key with the account the OAuth flow recorded', () => {
    expect(withRuntimeCredentials(oauthRow, { stripeUserId: 'acct_own', entityId: 'ent_1' }, env)).toEqual({
      stripeUserId: 'acct_own',
      platformSecretKey: 'sk_platform',
      entityId: 'ent_1',
      importStartDate: '2026-01-01',
    });
  });

  it('gives a re-pointed account id nothing, so the platform key never reads another customer', () => {
    const runtime = withRuntimeCredentials(oauthRow, { stripeUserId: 'acct_victim', accessToken: 'sk_test_attacker' }, env);
    expect(runtime).toEqual({ importStartDate: '2026-01-01' });
    const client = createConnectorClient('stripe', runtime, oauthRow.externalAccountId);
    expect(client).toBeInstanceOf(StripeClient);
    // No key at all: every call fails as unauthorised instead of reaching a Stripe account.
    expect((client as StripeClient).mode).toBe('oauth');
  });

  it('never takes a stored platform key or token', () => {
    const runtime = withRuntimeCredentials(oauthRow, { stripeUserId: 'acct_own', platformSecretKey: 'sk_planted', accessToken: 'x' }, env);
    expect(runtime.platformSecretKey).toBe('sk_platform');
    expect(runtime).not.toHaveProperty('accessToken');
  });

  it('uses a pasted key as-is and adds no platform key', () => {
    expect(withRuntimeCredentials(oauthRow, { apiKey: 'rk_live_1', stripeUserId: 'acct_victim' }, env)).toEqual({
      apiKey: 'rk_live_1',
      importStartDate: '2026-01-01',
    });
  });

  it('leaves other providers untouched', () => {
    const creds = { accessToken: 'mb', administrationId: '1' };
    expect(withRuntimeCredentials({ provider: 'moneybird', externalAccountId: '1', settings: null }, creds, env)).toBe(creds);
  });
});

describe('Stripe credential changes', () => {
  it('refuses to re-point an OAuth connection and allows only the key on an API-key one', () => {
    expect(credentialPatchError('stripe', { stripeUserId: 'acct_own' }, { stripeUserId: 'acct_victim' })).toMatch(/Connect Stripe again/);
    expect(credentialPatchError('stripe', { stripeUserId: 'acct_own' }, { apiKey: 'rk' })).toMatch(/Connect Stripe again/);
    expect(credentialPatchError('stripe', { apiKey: 'rk_old' }, { apiKey: 'rk_new' })).toBeNull();
    expect(credentialPatchError('stripe', { apiKey: 'rk_old' }, { apiKey: 'rk', stripeUserId: 'acct_victim' })).toMatch(/Only the Stripe API key/);
    expect(credentialPatchError('woocommerce', { consumerKey: 'a' }, { consumerKey: 'b' })).toBeNull();
  });

  it('stores only the allow-listed Stripe keys on connect', () => {
    expect(
      stripeStoredCredentials({ apiKey: 'rk', stripeUserId: 'acct', platformSecretKey: 'sk', accessToken: 't', entityId: 'e' }),
    ).toEqual({ apiKey: 'rk', stripeUserId: 'acct', entityId: 'e' });
  });
});
