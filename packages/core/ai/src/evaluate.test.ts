import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluate,
  isEvaluateConfigured,
  parseEvaluateResponse,
  resolveEvaluateRequest,
  JEV_MODEL_ID,
} from './evaluate.js';
import type { CloudflareGatewayConfig } from './config.js';

const baseConfig = (overrides: Partial<CloudflareGatewayConfig> = {}): CloudflareGatewayConfig => ({
  provider: 'cloudflare',
  accountId: 'acct_test',
  defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  ...overrides,
});

describe('resolveEvaluateRequest', () => {
  it('uses the unified /ai/run endpoint for third-party models when an API token is set', () => {
    const req = resolveEvaluateRequest(
      baseConfig({ apiKey: 'cf_token', gateway: 'weld', gatewayToken: 'aig_tok' }),
      JEV_MODEL_ID,
    );
    expect(req.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_test/ai/run');
    expect(req.wrapInModelInput).toBe(true);
    expect(req.headers.Authorization).toBe('Bearer cf_token');
    expect(req.headers['cf-aig-gateway-id']).toBe('weld');
  });

  it('refuses a gateway token alone for third-party models (the workers-ai route 401s)', () => {
    expect(() =>
      resolveEvaluateRequest(baseConfig({ gatewayToken: 'aig_tok' }), JEV_MODEL_ID),
    ).toThrow(/not configured/i);
  });

  it('uses the gateway workers-ai route for @cf/ models with only a gateway token', () => {
    const req = resolveEvaluateRequest(
      baseConfig({ gatewayToken: 'aig_tok' }),
      '@cf/meta/llama-3.1-8b-instruct',
    );
    expect(req.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct_test/default/workers-ai/@cf/meta/llama-3.1-8b-instruct',
    );
    expect(req.wrapInModelInput).toBe(false);
    expect(req.headers['cf-aig-authorization']).toBe('Bearer aig_tok');
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('throws when no credentials are available', () => {
    expect(() => resolveEvaluateRequest(baseConfig(), JEV_MODEL_ID)).toThrow(/not configured/i);
  });
});

describe('isEvaluateConfigured', () => {
  it('is true with an AI binding and no tokens', () => {
    expect(isEvaluateConfigured({ AI: { run: vi.fn() } })).toBe(true);
  });

  it('is false for Jev with only a gateway token', () => {
    expect(isEvaluateConfigured({ CF_ACCOUNT_ID: 'acct', CF_AIG_TOKEN: 'aig' })).toBe(false);
  });

  it('is true for Jev with an API token', () => {
    expect(isEvaluateConfigured({ CF_ACCOUNT_ID: 'acct', AI_GATEWAY_API_TOKEN: 'tok' })).toBe(true);
  });
});

describe('parseEvaluateResponse', () => {
  const sample = {
    model: 'jev-1.13.0',
    answers: {
      billing: { type: 'noul', noul: 0.91 },
      other: { type: 'noul', noul: 0.12 },
    },
    usage: { input_tokens: 400, output_tokens: 40 },
  };

  it('parses a bare Workers AI response', () => {
    const parsed = parseEvaluateResponse(sample);
    expect(parsed.model).toBe('jev-1.13.0');
    expect(parsed.answers.billing).toEqual({ type: 'noul', noul: 0.91 });
    expect(parsed.usage).toEqual({ inputTokens: 400, outputTokens: 40, totalTokens: 440 });
  });

  it('unwraps the Cloudflare REST { result, success } envelope', () => {
    const parsed = parseEvaluateResponse({ success: true, result: sample, errors: [] });
    expect(parsed.answers.other).toEqual({ type: 'noul', noul: 0.12 });
  });

  it('unwraps the nested unified /ai/run envelope for third-party models', () => {
    const parsed = parseEvaluateResponse({
      success: true,
      errors: [],
      result: { state: 'Completed', result: sample, gatewayMetadata: { keySource: 'Unified' } },
    });
    expect(parsed.answers.billing).toEqual({ type: 'noul', noul: 0.91 });
    expect(parsed.usage.totalTokens).toBe(440);
  });

  it('throws when the async job has not completed', () => {
    expect(() =>
      parseEvaluateResponse({ success: true, result: { state: 'Queued', result: null } }),
    ).toThrow(/did not complete/i);
  });

  it('throws on success:false envelopes', () => {
    expect(() =>
      parseEvaluateResponse({ success: false, result: null, errors: [{ message: 'nope' }] }),
    ).toThrow(/API error/i);
  });
});

describe('evaluate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const questions = {
    urgent: {
      type: 'noul' as const,
      instructions: 'Is this urgent?',
      criteria: { true: 'Time-sensitive', false: 'Not urgent' },
    },
  };

  it('runs through the AI binding via the configured gateway and records ops usage', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const run = vi.fn().mockResolvedValue({
      model: 'jev-1.13.0',
      answers: { urgent: { type: 'noul', noul: 0.88 } },
      usage: { input_tokens: 100, output_tokens: 10 },
    });

    const onUsage = vi.fn();
    const result = await evaluate(
      { AI: { run }, CF_AI_GATEWAY: 'weld' },
      { state: { subject: 'Invoice overdue' }, questions },
      { op: 'mail_auto_label', onUsage },
    );

    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.88 });
    expect(result.modelId).toBe(JEV_MODEL_ID);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      JEV_MODEL_ID,
      { state: { subject: 'Invoice overdue' }, questions },
      { gateway: { id: 'weld' } },
    );
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: 'cloudflare',
        modelId: JEV_MODEL_ID,
        op: 'mail_auto_label',
        usage: expect.objectContaining({ inputTokens: 100, outputTokens: 10 }),
      }),
    );
  });

  it('defaults the binding gateway to `default`', async () => {
    const run = vi.fn().mockResolvedValue({ answers: {} });
    await evaluate({ AI: { run } }, { state: 'hi', questions });
    expect(run.mock.calls[0]![2]).toEqual({ gateway: { id: 'default' } });
  });

  it('falls back to REST /ai/run with { model, input } when there is no binding', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          state: 'Completed',
          result: {
            model: 'jev-1.13.0',
            answers: { urgent: { type: 'noul', noul: 0.5 } },
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await evaluate(
      { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_tok' },
      { state: 'hello', questions },
    );

    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.5 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_test/ai/run');
    expect(JSON.parse(init.body as string)).toEqual({
      model: JEV_MODEL_ID,
      input: { state: 'hello', questions },
    });
  });
});
