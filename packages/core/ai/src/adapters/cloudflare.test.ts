import { describe, it, expect } from 'vitest';

import {
  createCloudflareAdapter,
  flattenWorkersAiRequestBody,
  toGatewayModelId,
} from './cloudflare.js';
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

describe('flattenWorkersAiRequestBody', () => {
  it('flattens OpenAI content-part arrays to plain strings', () => {
    const out = flattenWorkersAiRequestBody({
      model: 'workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are helpful.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'there' }] },
        { role: 'assistant', content: 'Already a string' },
      ],
    });

    expect(out.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello\nthere' },
      { role: 'assistant', content: 'Already a string' },
    ]);
  });

  it('replaces null/undefined content with empty string', () => {
    const out = flattenWorkersAiRequestBody({
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: '1' }] },
        { role: 'tool', content: undefined },
      ],
    });

    expect(out.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: '1' }] },
      { role: 'tool', content: '' },
    ]);
  });

  it('leaves non-message payloads untouched', () => {
    const body = { input: 'embed me' };
    expect(flattenWorkersAiRequestBody(body)).toEqual(body);
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
