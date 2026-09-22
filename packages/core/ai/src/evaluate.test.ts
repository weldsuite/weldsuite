import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  evaluate,
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
  it('uses the AI Gateway workers-ai route when a gateway id is set', () => {
    const req = resolveEvaluateRequest(
      baseConfig({ gateway: 'default', gatewayToken: 'aig_tok', apiKey: 'should-not-use' }),
      JEV_MODEL_ID,
    );
    expect(req.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct_test/default/workers-ai/typesafe/jev',
    );
    expect(req.wrapInModelInput).toBe(false);
    expect(req.headers['cf-aig-authorization']).toBe('Bearer aig_tok');
    expect(req.headers.Authorization).toBeUndefined();
  });

  it('falls back to direct Workers AI /ai/run when no gateway is configured', () => {
    const req = resolveEvaluateRequest(baseConfig({ apiKey: 'cf_token' }), JEV_MODEL_ID);
    expect(req.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_test/ai/run');
    expect(req.wrapInModelInput).toBe(true);
    expect(req.headers.Authorization).toBe('Bearer cf_token');
  });

  it('defaults to the account `default` gateway when only CF_AIG_TOKEN is set', () => {
    const req = resolveEvaluateRequest(
      baseConfig({ gatewayToken: 'aig_tok' }),
      JEV_MODEL_ID,
    );
    expect(req.url).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct_test/default/workers-ai/typesafe/jev',
    );
    expect(req.headers['cf-aig-authorization']).toBe('Bearer aig_tok');
  });

  it('throws when neither gateway-auth nor api key is available for direct mode', () => {
    expect(() => resolveEvaluateRequest(baseConfig(), JEV_MODEL_ID)).toThrow(/not configured/i);
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

  it('POSTs state+questions through the gateway and records ops usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: { urgent: { type: 'noul', noul: 0.88 } },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const onUsage = vi.fn();
    const result = await evaluate(
      {
        CF_ACCOUNT_ID: 'acct_test',
        CF_AI_GATEWAY: 'default',
        CF_AIG_TOKEN: 'aig',
      },
      {
        state: { subject: 'Invoice overdue' },
        questions: {
          urgent: {
            type: 'noul',
            instructions: 'Is this urgent?',
            criteria: { true: 'Time-sensitive', false: 'Not urgent' },
          },
        },
      },
      { op: 'mail_auto_label', onUsage },
    );

    expect(result.answers.urgent).toEqual({ type: 'noul', noul: 0.88 });
    expect(result.modelId).toBe(JEV_MODEL_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain('/workers-ai/typesafe/jev');
    expect(JSON.parse(init.body as string)).toEqual({
      state: { subject: 'Invoice overdue' },
      questions: {
        urgent: {
          type: 'noul',
          instructions: 'Is this urgent?',
          criteria: { true: 'Time-sensitive', false: 'Not urgent' },
        },
      },
    });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: 'cloudflare',
        modelId: JEV_MODEL_ID,
        op: 'mail_auto_label',
        usage: expect.objectContaining({ inputTokens: 100, outputTokens: 10 }),
      }),
    );
  });

  it('wraps the body in { model, input } for direct Workers AI calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        result: {
          model: 'jev-1.13.0',
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await evaluate(
      { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_tok' },
      { state: 'hello', questions: { q: { type: 'noul', instructions: 'yes?' } } },
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({
      model: JEV_MODEL_ID,
      input: {
        state: 'hello',
        questions: { q: { type: 'noul', instructions: 'yes?' } },
      },
    });
  });
});
