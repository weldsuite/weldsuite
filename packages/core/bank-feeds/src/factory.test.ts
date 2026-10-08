import { describe, expect, it } from 'vitest';
import { FeedProviderError } from './errors';
import {
  bankFeedConfigFromEnv,
  createBankFeedProvider,
  createWebhookProvider,
  enabledProviders,
  normalizeProviderId,
  parseProviderRouting,
} from './factory';

const ENV = {
  PLAID_CLIENT_ID: 'cid',
  PLAID_SECRET: 'sec',
  PLAID_ENV: 'production',
  STRIPE_FC_SECRET_KEY: 'sk_test',
  PONTO_CLIENT_ID: 'pid',
  PONTO_CLIENT_SECRET: 'psec',
  ENABLE_BANKING_APP_ID: 'app',
  ENABLE_BANKING_PRIVATE_KEY: 'pem',
  BANK_FEED_WEBHOOK_URL: 'https://hooks.example/webhooks/bank-feeds/',
};

const ids = (country: string, env: Record<string, string>) => enabledProviders(country, bankFeedConfigFromEnv(env)).map((p) => p.id);

describe('provider routing spec', () => {
  it('parses per-country lists and normalizes ids', () => {
    expect(parseProviderRouting('US:stripe-fc,plaid; nl : ponto ;*:enable_banking')).toEqual({
      US: ['stripe_fc', 'plaid'],
      NL: ['ponto'],
      '*': ['enable_banking'],
    });
    expect(parseProviderRouting(undefined)).toEqual({});
    expect(normalizeProviderId('enable-banking')).toBe('enable_banking');
  });
});

describe('enabledProviders', () => {
  it('offers every configured provider where its regions allow, in default order, when no spec is set', () => {
    expect(ids('US', ENV)).toEqual(['plaid', 'stripe_fc']);
    expect(ids('NL', ENV)).toEqual(['ponto', 'enable_banking']);
    expect(ids('JP', ENV)).toEqual([]);
  });

  it('follows the spec order, country list first and the * list after', () => {
    const env = { ...ENV, BANK_FEED_PROVIDERS: 'US:stripe_fc,plaid;NL:ponto;*:enable_banking' };
    expect(ids('US', env)).toEqual(['stripe_fc', 'plaid']);
    expect(ids('NL', env)).toEqual(['ponto', 'enable_banking']);
    expect(ids('DE', env)).toEqual(['enable_banking']);
  });

  it('lets config switch the US default without code', () => {
    expect(ids('US', { ...ENV, BANK_FEED_PROVIDERS: 'US:plaid' })).toEqual(['plaid']);
    expect(ids('US', { ...ENV, BANK_FEED_PROVIDERS: 'US:stripe_fc' })).toEqual(['stripe_fc']);
  });

  it('drops providers without credentials and providers that do not cover the country', () => {
    const noPlaid = { ...ENV, PLAID_CLIENT_ID: '' };
    expect(ids('US', { ...noPlaid, BANK_FEED_PROVIDERS: 'US:plaid,stripe_fc' })).toEqual(['stripe_fc']);
    expect(ids('US', { ...ENV, BANK_FEED_PROVIDERS: 'US:ponto,plaid' })).toEqual(['plaid']);
  });
});

describe('bankFeedConfigFromEnv / createBankFeedProvider', () => {
  it('builds Plaid with the environment and the webhook URL', () => {
    const config = bankFeedConfigFromEnv(ENV);
    expect(config.plaid).toMatchObject({ env: 'production', webhookUrl: 'https://hooks.example/webhooks/bank-feeds/plaid' });
    expect(bankFeedConfigFromEnv({ ...ENV, PLAID_ENV: undefined as unknown as string }).plaid?.env).toBe('sandbox');
  });

  it('creates a provider by id (url segments accepted) and refuses unknown or unconfigured ones', () => {
    const config = bankFeedConfigFromEnv(ENV);
    expect(createBankFeedProvider('stripe-fc', config).id).toBe('stripe_fc');
    expect(() => createBankFeedProvider('teller', config)).toThrow(FeedProviderError);
    expect(() => createBankFeedProvider('plaid', {})).toThrow(/not configured/);
  });
});

describe('createWebhookProvider', () => {
  it('verifies Stripe Financial Connections deliveries with the webhook secret alone', () => {
    expect(createWebhookProvider('stripe-fc', {}).id).toBe('stripe_fc');
    expect(() => createBankFeedProvider('stripe_fc', {})).toThrow(/not configured/);
  });

  it('still needs credentials for providers that fetch verification keys', () => {
    expect(() => createWebhookProvider('plaid', {})).toThrow(/not configured/);
    expect(createWebhookProvider('plaid', bankFeedConfigFromEnv(ENV)).id).toBe('plaid');
  });
});
