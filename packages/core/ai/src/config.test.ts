import { describe, it, expect } from 'vitest';

import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  isGatewayConfigured,
  resolveConfig,
  resolveProvider,
  restApiBaseUrl,
} from './config.js';

const CF_ENV = { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_token' };

describe('resolveProvider', () => {
  it('defaults to cloudflare when AI_GATEWAY_PROVIDER is unset', () => {
    expect(resolveProvider({})).toBe('cloudflare');
    expect(DEFAULT_PROVIDER).toBe('cloudflare');
  });

  it('is case-insensitive', () => {
    expect(resolveProvider({ AI_GATEWAY_PROVIDER: 'CLOUDFLARE' })).toBe('cloudflare');
  });

  it('rejects any non-cloudflare provider rather than silently falling back', () => {
    expect(() => resolveProvider({ AI_GATEWAY_PROVIDER: 'vercel' })).toThrow(
      /Unknown AI_GATEWAY_PROVIDER/i,
    );
    expect(() => resolveProvider({ AI_GATEWAY_PROVIDER: 'openrouter' })).toThrow(
      /Unknown AI_GATEWAY_PROVIDER/i,
    );
  });
});

describe('resolveConfig — cloudflare', () => {
  it('resolves account, token and the free default model', () => {
    const config = resolveConfig(CF_ENV);
    expect(config).toMatchObject({
      provider: 'cloudflare',
      accountId: 'acct_test',
      apiKey: 'cf_token',
      defaultModel: DEFAULT_MODEL,
    });
  });

  it('accepts CLOUDFLARE_ACCOUNT_ID as an alias', () => {
    expect(resolveConfig({ CLOUDFLARE_ACCOUNT_ID: 'acct_alias' })).toMatchObject({
      accountId: 'acct_alias',
    });
  });

  it('falls back through the token aliases in order', () => {
    expect(resolveConfig({ ...CF_ENV, AI_GATEWAY_API_TOKEN: undefined, CF_API_TOKEN: 'cf2' })).toMatchObject({
      apiKey: 'cf2',
    });
  });

  // The workflow-worker guard asserts on this exact wording (/gateway is not configured/i).
  it('throws a "gateway is not configured" error when the account id is missing', () => {
    expect(() => resolveConfig({})).toThrow(/gateway is not configured/i);
    expect(() => resolveConfig({})).toThrow(/CF_ACCOUNT_ID/);
  });

  it('ignores non-string values so a full Worker env (with bindings) is safe', () => {
    const config = resolveConfig({ ...CF_ENV, SOME_KV_BINDING: { get: () => null } });
    expect(config.provider).toBe('cloudflare');
  });

  it('lets AI_DEFAULT_MODEL override the default model', () => {
    expect(resolveConfig({ ...CF_ENV, AI_DEFAULT_MODEL: 'openai/gpt-5' })).toMatchObject({
      defaultModel: 'openai/gpt-5',
    });
  });
});

describe('isGatewayConfigured', () => {
  it('reports readiness without throwing', () => {
    expect(isGatewayConfigured(CF_ENV)).toBe(true);
    expect(isGatewayConfigured({})).toBe(false);
  });
});

describe('base url helpers', () => {
  it('builds the Cloudflare REST base', () => {
    expect(restApiBaseUrl('acct_1')).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct_1/ai/v1',
    );
  });
});
