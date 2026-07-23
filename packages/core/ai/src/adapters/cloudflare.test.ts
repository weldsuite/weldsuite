import { describe, it, expect } from 'vitest';

import { createCloudflareAdapter, toGatewayModelId } from './cloudflare.js';
import { compatBaseUrl, restApiBaseUrl, type CloudflareGatewayConfig } from '../config.js';

describe('toGatewayModelId', () => {
  it('prefixes Workers AI ids with workers-ai/ in gateway mode', () => {
    expect(toGatewayModelId('@cf/meta/llama-3.3-70b-instruct-fp8-fast', true)).toBe(
      'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
  });

  it('leaves already provider-prefixed ids untouched', () => {
    expect(toGatewayModelId('anthropic/claude-sonnet-4-5', true)).toBe('anthropic/claude-sonnet-4-5');
    expect(toGatewayModelId('openai/gpt-5', true)).toBe('openai/gpt-5');
  });

  it('is a no-op in direct mode', () => {
    expect(toGatewayModelId('@cf/meta/llama-3.3-70b-instruct-fp8-fast', false)).toBe(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    );
  });
});

describe('createCloudflareAdapter', () => {
  const base: CloudflareGatewayConfig = {
    provider: 'cloudflare',
    accountId: 'acct_1',
    apiKey: 'cf_token',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  };

  it('builds language + embedding models in direct mode (no gateway)', () => {
    const a = createCloudflareAdapter(base);
    expect(a.languageModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBeDefined();
    expect(a.textEmbeddingModel('@cf/baai/bge-m3')).toBeDefined();
  });

  it('builds models in gateway mode', () => {
    const a = createCloudflareAdapter({ ...base, gateway: 'weldsuite', gatewayToken: 'aig_tok' });
    expect(a.languageModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBeDefined();
    expect(a.textEmbeddingModel('@cf/baai/bge-m3')).toBeDefined();
  });

  it('exposes the expected base-url helpers', () => {
    expect(restApiBaseUrl('acct_1')).toBe('https://api.cloudflare.com/client/v4/accounts/acct_1/ai/v1');
    expect(compatBaseUrl('acct_1', 'weldsuite')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct_1/weldsuite/compat',
    );
  });
});
