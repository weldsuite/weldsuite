import { describe, it, expect } from 'vitest';

import { createWeldAI } from './gateway.js';
import { DEFAULT_MODEL } from './config.js';
import { thirdParty, workersAi } from './models.js';

const CF_ENV = { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_token' };

describe('createWeldAI — public shape', () => {
  // apps/workers/workflow-worker/src/engine/actions/ai.test.ts mocks exactly this shape.
  it('returns { model, embedding, provider, config } with the cloudflare gateway', () => {
    const ai = createWeldAI(CF_ENV);
    expect(typeof ai.model).toBe('function');
    expect(typeof ai.embedding).toBe('function');
    expect(ai.provider).toBeDefined();
    expect(ai.config).toBeDefined();
    expect(ai.gateway).toBe('cloudflare');
  });

  it('defaults to the cloudflare gateway when AI_GATEWAY_PROVIDER is unset', () => {
    expect(createWeldAI(CF_ENV).config).toMatchObject({ provider: 'cloudflare' });
  });
});

describe('createWeldAI — model resolution', () => {
  // @ai-sdk/openai-compatible@3 emits specificationVersion 'v4'; ai@7 accepts v2/v3/v4.
  const AI_V7_ACCEPTS = ['v2', 'v3', 'v4'];

  it('builds a spec-compatible AI SDK language model', () => {
    const model = createWeldAI(CF_ENV).model(thirdParty.anthropic.sonnet);
    expect(model).toBeDefined();
    expect(AI_V7_ACCEPTS).toContain(
      (model as { specificationVersion?: string }).specificationVersion,
    );
  });

  it('falls back to the configured default model when no id is given', () => {
    const ai = createWeldAI(CF_ENV);
    expect(ai.config.defaultModel).toBe(DEFAULT_MODEL);
    expect(ai.model()).toBeDefined();
  });

  it('builds embedding models', () => {
    expect(createWeldAI(CF_ENV).embedding(workersAi.embedM3)).toBeDefined();
  });
});

describe('createWeldAI — config passthrough', () => {
  it('accepts an already-built config', () => {
    const ai = createWeldAI({
      provider: 'cloudflare',
      accountId: 'acct_direct',
      defaultModel: DEFAULT_MODEL,
    });
    expect(ai.config).toMatchObject({ accountId: 'acct_direct' });
  });

  it('treats a legacy provider-less cloudflare config as cloudflare', () => {
    // Pre-multi-gateway callers passed { accountId, defaultModel } with no provider.
    const ai = createWeldAI({ accountId: 'acct_legacy', defaultModel: DEFAULT_MODEL });
    expect(ai.gateway).toBe('cloudflare');
  });

  it('throws when the gateway is unconfigured', () => {
    expect(() => createWeldAI({})).toThrow(/gateway is not configured/i);
  });
});
